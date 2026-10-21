// Objects that deploy-time SQL drops and creates again (QA 184), for the
// warning that their hand-made grants, revokes and policies on a target will
// be lost (deploy/recreated-privileges.ts). Database-free: it follows the
// units' statements in the order they run.
//
// Only objects that carry privileges or policies count: tables (and foreign
// tables), views, materialized views, sequences, functions and procedures,
// and types (domains included). An object is recreated when a DROP of it is
// followed, in the same unit or a later one, by a CREATE of the same name
// and family: relations share one family (they share pg_class's names), as
// do routines (matched by name, not signature: changing a function's
// arguments drops it and creates a new one, which loses its privileges just
// the same) and types. Each object is named by its DROP, which is what the
// target holds now (`identity`, for to_regclass, to_regprocedure or
// to_regtype). Objects outside the managed schema are skipped: deploy-time
// files can't create or drop them there.
import type {
  CreateFunctionStmt,
  DropStmt,
  ObjectWithArgs,
  RangeVar,
  TypeName,
} from "@pgsql/types";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
import { type Json, statementBody, stringList, unwrap } from "./syntax-tree.ts";

/** Which catalog an object's name and privileges live in. */
export type RecreatedFamily = "relation" | "routine" | "type";

/** An object a unit drops that a unit (the same or a later one) creates again. */
export interface RecreatedObject {
  readonly family: RecreatedFamily;
  /**
   * The object as its DROP names it, schema-qualified and quoted, e.g.
   * `"app"."order_count"("pg_catalog"."int8")`: what to_regclass,
   * to_regprocedure or to_regtype resolves on a target.
   */
  readonly identity: string;
  /** The label of the unit that drops it, e.g. `00005-wider-total`. */
  readonly droppedBy: string;
  /** The label of the unit that creates it again. */
  readonly createdBy: string;
}

/** One migration (or draft) as the SQL files it runs, in order. */
export interface RecreatingUnit {
  readonly label: string;
  readonly files: readonly SqlFile[];
}

const droppedFamilies: Readonly<Record<string, RecreatedFamily>> = {
  OBJECT_TABLE: "relation",
  OBJECT_FOREIGN_TABLE: "relation",
  OBJECT_VIEW: "relation",
  OBJECT_MATVIEW: "relation",
  OBJECT_SEQUENCE: "relation",
  OBJECT_FUNCTION: "routine",
  OBJECT_PROCEDURE: "routine",
  OBJECT_ROUTINE: "routine",
  OBJECT_TYPE: "type",
  OBJECT_DOMAIN: "type",
};

interface Dropped {
  readonly family: RecreatedFamily;
  /** `family:name`, what a CREATE matches. */
  readonly key: string;
  readonly identity: string;
  readonly droppedBy: string;
  createdBy?: string;
}

/**
 * The objects in `managedSchema` that `units` drop and create again, in the
 * order they are dropped; each once, at its first drop. Files that don't
 * parse are skipped (the rules refuse them elsewhere).
 */
export async function recreatedObjects(
  units: readonly RecreatingUnit[],
  managedSchema: string,
): Promise<RecreatedObject[]> {
  const dropped: Dropped[] = [];
  for (const unit of units) {
    for (const file of unit.files) {
      const parsed = await parseSqlFile(file);
      for (const statement of parsed.ok ? parsed.statements : []) {
        for (const key of createdKeys(statement, managedSchema)) {
          for (const drop of dropped) {
            if (drop.key === key) {
              drop.createdBy ??= unit.label;
            }
          }
        }
        for (const drop of drops(statement, managedSchema)) {
          if (!dropped.some((earlier) => earlier.identity === drop.identity)) {
            dropped.push({ ...drop, droppedBy: unit.label });
          }
        }
      }
    }
  }
  return dropped.flatMap(({ family, identity, droppedBy, createdBy }) =>
    createdBy === undefined ? [] : [{ family, identity, droppedBy, createdBy }],
  );
}

function drops(
  statement: ParsedStatement,
  managedSchema: string,
): Omit<Dropped, "droppedBy">[] {
  if (statement.nodeType !== "DropStmt") {
    return [];
  }
  const drop = statementBody(statement) as DropStmt;
  const family = droppedFamilies[drop.removeType ?? ""];
  if (family === undefined) {
    return [];
  }
  return (drop.objects ?? []).flatMap((object) => {
    const routine = unwrap<ObjectWithArgs>(object, "ObjectWithArgs");
    const type = unwrap<TypeName>(object, "TypeName");
    const parts = stringList(
      routine?.objname ?? type?.names ?? (object as unknown),
    );
    const name = parts.at(-1);
    const schema = parts.length > 1 ? parts.at(-2) : managedSchema;
    if (name === undefined || schema !== managedSchema) {
      return [];
    }
    const qualified = `${quoted(schema)}.${quoted(name)}`;
    const args = (routine?.objargs ?? []).flatMap((arg) => {
      const argType = unwrap<TypeName>(arg, "TypeName");
      return argType === undefined ? [] : [typeText(argType)];
    });
    return [
      {
        family,
        key: `${family}:${name}`,
        identity:
          family === "routine" ? `${qualified}(${args.join(", ")})` : qualified,
      },
    ];
  });
}

/** `family:name` of each object in `managedSchema` the statement creates. */
function createdKeys(
  statement: ParsedStatement,
  managedSchema: string,
): string[] {
  const body = statementBody(statement);
  const inSchema = (family: RecreatedFamily, parts: readonly string[]) => {
    const name = parts.at(-1);
    const schema = parts.length > 1 ? parts.at(-2) : managedSchema;
    return name === undefined || schema !== managedSchema
      ? []
      : [`${family}:${name}`];
  };
  const relation = (value: unknown) => inSchema("relation", rangeParts(value));
  switch (statement.nodeType) {
    case "CreateStmt":
      return relation(body.relation);
    case "CreateForeignTableStmt":
      return relation((body.base as Json | undefined)?.relation);
    case "CreateTableAsStmt":
      return relation((body.into as Json | undefined)?.rel);
    case "ViewStmt":
      return relation(body.view);
    case "CreateSeqStmt":
      return relation(body.sequence);
    case "CreateFunctionStmt":
      return inSchema(
        "routine",
        stringList((body as CreateFunctionStmt).funcname),
      );
    case "CreateDomainStmt":
      return inSchema("type", stringList(body.domainname));
    case "CreateEnumStmt":
    case "CreateRangeStmt":
      return inSchema("type", stringList(body.typeName));
    case "CompositeTypeStmt":
      return inSchema("type", rangeParts(body.typevar));
    default:
      return [];
  }
}

/** A RangeVar's name parts, wrapped or not: `[schema, name]` or `[name]`. */
function rangeParts(value: unknown): string[] {
  const range = (unwrap<RangeVar>(value, "RangeVar") ?? value) as
    | RangeVar
    | undefined;
  return [range?.schemaname, range?.relname].filter(
    (part): part is string => part !== undefined,
  );
}

/** A type as PostgreSQL's regtype input reads it: quoted parts, array bounds. */
function typeText(type: TypeName): string {
  const name = stringList(type.names).map(quoted).join(".");
  return `${name}${"[]".repeat(type.arrayBounds?.length ?? 0)}`;
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
