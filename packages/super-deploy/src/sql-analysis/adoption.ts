// Adoption (`init --adopt`): the statements the differ generates to build an
// existing database from nothing, turned into desired-schema files. The
// differ reads the whole database, so this keeps only statements about
// objects in the managed schema, and sorts them into one file per kind of
// object. What it keeps is checked by the desired-schema rules afterwards,
// exactly like hand-written files: nothing here decides what V1 supports.
//
// Statements are left out when they are:
// - about objects outside the managed schema, or not in any schema (roles,
//   schemas themselves, default privileges, event triggers, casts, foreign
//   servers...): the managed schema is all super-deploy manages.
// - ownership changes (`ALTER ... OWNER TO`): ownership isn't modelled;
//   objects belong to whoever deploys them.
// - for objects a desired schema can never create and the catalog check
//   reports itself (aggregates, operators, rules, statistics objects,
//   extensions, publications...; verification/catalog.ts `other`), so each
//   is listed once with its reason (`unsupportedCatalogObject`).
import { parseSqlFile } from "./parse.ts";
import {
  defElemString,
  defElems,
  isObject,
  type Json,
  list,
  stringList,
  unwrap,
} from "./syntax-tree.ts";

export interface AdoptedFile {
  /** Path relative to the desired-schema folder, e.g. `tables.sql`. */
  readonly path: string;
  readonly text: string;
}

/** The file each kind of statement goes to, in the order files are listed. */
const fileOf: Readonly<Record<string, string>> = {
  CreateStmt: "tables.sql",
  CreateForeignTableStmt: "tables.sql",
  AlterTableStmt: "tables.sql",
  CreateSeqStmt: "sequences.sql",
  AlterSeqStmt: "sequences.sql",
  IndexStmt: "indexes.sql",
  ViewStmt: "views.sql",
  CreateTableAsStmt: "views.sql",
  CreateDomainStmt: "types.sql",
  AlterDomainStmt: "types.sql",
  CompositeTypeStmt: "types.sql",
  CreateEnumStmt: "types.sql",
  AlterEnumStmt: "types.sql",
  CreateRangeStmt: "types.sql",
  CreateFunctionStmt: "routines.sql",
  AlterFunctionStmt: "routines.sql",
  CreateTrigStmt: "triggers.sql",
  CreatePolicyStmt: "policies.sql",
  AlterPolicyStmt: "policies.sql",
  CommentStmt: "comments.sql",
  GrantStmt: "grants.sql",
};
const otherFile = "other.sql";

/** Statement types for objects the catalog check reports (see above). */
const catalogObjectStatements = new Set([
  "DefineStmt",
  "RuleStmt",
  "CreateStatsStmt",
  "AlterStatsStmt",
  "CreateOpClassStmt",
  "CreateOpFamilyStmt",
  "AlterOpFamilyStmt",
  "CreateConversionStmt",
  "CreateExtensionStmt",
  "AlterExtensionStmt",
  "AlterExtensionContentsStmt",
  "CreatePublicationStmt",
  "AlterPublicationStmt",
]);

/** COMMENT ON / GRANT ON object types the catalog check reports. */
const catalogObjectTypes = new Set([
  "OBJECT_AGGREGATE",
  "OBJECT_OPERATOR",
  "OBJECT_OPCLASS",
  "OBJECT_OPFAMILY",
  "OBJECT_COLLATION",
  "OBJECT_CONVERSION",
  "OBJECT_TSCONFIGURATION",
  "OBJECT_TSDICTIONARY",
  "OBJECT_TSPARSER",
  "OBJECT_TSTEMPLATE",
  "OBJECT_RULE",
  "OBJECT_STATISTIC_EXT",
  "OBJECT_EXTENSION",
  "OBJECT_PUBLICATION",
]);

/** Object names with a table part: `schema.table.name`. */
const threePartObjects = new Set([
  "OBJECT_COLUMN",
  "OBJECT_TABCONSTRAINT",
  "OBJECT_TRIGGER",
  "OBJECT_POLICY",
  "OBJECT_RULE",
]);

export interface AdoptionOptions {
  readonly managedSchema: string;
  /** The first lines of every file, e.g. where it came from. */
  readonly header: readonly string[];
}

/**
 * Desired-schema files from the differ's statements (each one statement,
 * in the differ's order), keeping only the managed schema's objects. Each
 * file holds one kind of object, in the differ's order. `CREATE OR REPLACE`
 * becomes `CREATE`: the desired schema defines each object once.
 */
export async function adoptedDesiredSchema(
  statements: readonly string[],
  options: AdoptionOptions,
): Promise<AdoptedFile[]> {
  const files = new Map<string, string[]>();
  for (const sql of statements) {
    const file = await fileFor(sql, options.managedSchema);
    if (file !== undefined) {
      const texts = files.get(file) ?? [];
      texts.push(desiredText(sql));
      files.set(file, texts);
    }
  }
  const order = [...new Set([...Object.values(fileOf), otherFile])];
  const header = options.header.map((line) => `-- ${line}`).join("\n");
  return order.flatMap((path) => {
    const texts = files.get(path);
    return texts === undefined
      ? []
      : [{ path, text: `${header}\n\n${texts.join("\n\n")}\n` }];
  });
}

/** The file a generated statement goes to, or undefined to leave it out. */
async function fileFor(
  sql: string,
  managedSchema: string,
): Promise<string | undefined> {
  const parsed = await parseSqlFile({ path: "generated.sql", text: sql });
  const [statement] = parsed.ok ? parsed.statements : [];
  if (statement === undefined || (parsed.ok && parsed.statements.length > 1)) {
    // Never expected from the differ; the rules report what's wrong with it.
    return otherFile;
  }
  const type = statement.nodeType;
  const node = unwrap(statement.node, type) ?? {};
  if (
    catalogObjectStatements.has(type) ||
    isOwnershipChange(type, node) ||
    isWindowFunction(type, node) ||
    ((type === "CommentStmt" || type === "GrantStmt") &&
      catalogObjectTypes.has(String(node.objtype)))
  ) {
    return undefined;
  }
  const schema = ownSchema(type, node);
  if (schema === null || (schema !== undefined && schema !== managedSchema)) {
    return undefined;
  }
  return fileOf[type] ?? otherFile;
}

function desiredText(sql: string): string {
  const text = sql.trim().replace(/^CREATE\s+OR\s+REPLACE\s+/i, "CREATE ");
  return text.endsWith(";") ? text : `${text};`;
}

function isOwnershipChange(type: string, node: Json): boolean {
  if (type === "AlterOwnerStmt") {
    return true;
  }
  const commands = list(node.cmds).map(
    (command) => unwrap(command, "AlterTableCmd")?.subtype,
  );
  return (
    type === "AlterTableStmt" &&
    commands.length > 0 &&
    commands.every((subtype) => subtype === "AT_ChangeOwner")
  );
}

/** Window functions are reported by the catalog check, like aggregates. */
function isWindowFunction(type: string, node: Json): boolean {
  return (
    type === "CreateFunctionStmt" &&
    defElems(node.options).some((option) => option.name === "window")
  );
}

/**
 * The schema a statement's own object is in: a name, undefined when it is
 * unqualified (taken to be the managed schema), or null when the object is
 * in no schema at all (a role, a schema itself, an event trigger...).
 */
function ownSchema(type: string, node: Json): string | null | undefined {
  switch (type) {
    case "CreateStmt":
    case "IndexStmt":
    case "CreateTrigStmt":
    case "AlterTableStmt":
    case "RuleStmt":
      return relationSchema(node.relation);
    case "CreateForeignTableStmt":
      return relationSchema(isObject(node.base) ? node.base.relation : null);
    case "CreateSeqStmt":
    case "AlterSeqStmt":
      return relationSchema(node.sequence);
    case "ViewStmt":
      return relationSchema(node.view);
    case "CreateTableAsStmt":
      return relationSchema(isObject(node.into) ? node.into.rel : null);
    case "CompositeTypeStmt":
      return relationSchema(node.typevar);
    case "CreatePolicyStmt":
    case "AlterPolicyStmt":
      return relationSchema(node.table);
    case "CreateFunctionStmt":
      return qualifier(stringList(node.funcname), 2);
    case "AlterFunctionStmt":
      return objectSchema(node.func, 2);
    case "CreateDomainStmt":
      return qualifier(stringList(node.domainname), 2);
    case "AlterDomainStmt":
    case "AlterEnumStmt":
    case "CreateEnumStmt":
    case "CreateRangeStmt":
      return qualifier(stringList(node.typeName), 2);
    case "CommentStmt":
      return objectSchema(
        node.object,
        threePartObjects.has(String(node.objtype)) ? 3 : 2,
      );
    case "GrantStmt": {
      if (node.targtype !== "ACL_TARGET_OBJECT") {
        // GRANT ... ON ALL ... IN SCHEMA s
        const [schema] = list(node.objects).flatMap((object) => {
          const name = defElemString(object);
          return name === undefined ? [] : [name];
        });
        return schema ?? null;
      }
      const [first] = list(node.objects);
      return objectSchema(first, 2);
    }
    default:
      return null;
  }
}

function relationSchema(value: unknown): string | null | undefined {
  const relation = unwrap(value, "RangeVar") ?? (isObject(value) ? value : {});
  if (typeof relation.relname !== "string") {
    return null;
  }
  return typeof relation.schemaname === "string"
    ? relation.schemaname
    : undefined;
}

/** The schema of a COMMENT or GRANT object: a name list, RangeVar, TypeName or routine. */
function objectSchema(
  value: unknown,
  parts: number,
): string | null | undefined {
  if (unwrap(value, "String") !== undefined) {
    // A schema, role, extension, language...: in no schema.
    return null;
  }
  const relation = unwrap(value, "RangeVar");
  if (relation !== undefined) {
    return relationSchema(relation);
  }
  const typeName = unwrap(value, "TypeName");
  if (typeName !== undefined) {
    return qualifier(stringList(typeName.names), 2);
  }
  const routine = unwrap(value, "ObjectWithArgs");
  if (routine !== undefined) {
    return qualifier(stringList(routine.objname), 2);
  }
  const items = list(unwrap(value, "List")?.items);
  const [head] = items;
  if (unwrap(head, "TypeName") !== undefined) {
    // A domain constraint: (type, name).
    return objectSchema(head, 2);
  }
  return items.length === 0 ? null : qualifier(stringList(value), parts);
}

function qualifier(
  names: readonly string[],
  parts: number,
): string | undefined {
  return names.length >= parts ? names[0] : undefined;
}
