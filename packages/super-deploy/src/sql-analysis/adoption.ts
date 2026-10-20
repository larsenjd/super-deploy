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
// - grants on the managed schema to its owner or the deploy role (target
//   setup, which the catalog comparison counts as the owner's), and REVOKEs
//   from roles other than PUBLIC: the differ emits them before each GRANT,
//   and on a new object they change nothing.
//
// The managed schema's own grants are kept, and a REVOKE ALL of PUBLIC's
// default privileges is written with the privilege it takes away, as the
// rules require (`REVOKE EXECUTE ON FUNCTION`, `REVOKE USAGE ON TYPE`).
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
  schemaQualifier,
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
  /**
   * Roles whose privileges on the managed schema are target setup, not the
   * desired schema's: its owner and the deploy role. Default none.
   */
  readonly schemaRoles?: readonly string[];
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
    const file = await fileFor(sql, options);
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
  { managedSchema, schemaRoles = [] }: AdoptionOptions,
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
  if (type === "GrantStmt") {
    const grantees = list(node.grantees).map((grantee) => {
      const role = unwrap(grantee, "RoleSpec") ?? {};
      return role.roletype === "ROLESPEC_PUBLIC" ? null : role.rolename;
    });
    if (
      node.is_grant === true
        ? node.objtype === "OBJECT_SCHEMA" &&
          grantees.every(
            (role) => typeof role === "string" && schemaRoles.includes(role),
          )
        : !grantees.includes(null)
    ) {
      return undefined;
    }
    if (
      node.objtype === "OBJECT_SCHEMA" &&
      node.targtype === "ACL_TARGET_OBJECT"
    ) {
      const schemas = list(node.objects).map(
        (object) => unwrap(object, "String")?.sval,
      );
      return schemas.every((schema) => schema === managedSchema)
        ? fileOf[type]
        : undefined;
    }
  }
  const schema = ownSchema(type, node);
  if (schema === null || (schema !== undefined && schema !== managedSchema)) {
    return undefined;
  }
  return fileOf[type] ?? otherFile;
}

/** PUBLIC's default privilege on each object type the differ revokes ALL of. */
const publicDefaults: Readonly<Record<string, string>> = {
  FUNCTION: "EXECUTE",
  PROCEDURE: "EXECUTE",
  ROUTINE: "EXECUTE",
  TYPE: "USAGE",
  DOMAIN: "USAGE",
  SCHEMA: "USAGE",
};

function desiredText(sql: string): string {
  const text = sql
    .trim()
    .replace(/^CREATE\s+OR\s+REPLACE\s+/i, "CREATE ")
    .replace(
      /^REVOKE\s+ALL\s+ON\s+(FUNCTION|PROCEDURE|ROUTINE|TYPE|DOMAIN|SCHEMA)\s(?=[\s\S]*\sFROM\s+PUBLIC;?$)/i,
      (_all, kind: string) =>
        `REVOKE ${publicDefaults[kind.toUpperCase()]} ON ${kind} `,
    );
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
      return schemaQualifier(stringList(node.funcname), 2);
    case "AlterFunctionStmt":
      return objectSchema(node.func, 2);
    case "CreateDomainStmt":
      return schemaQualifier(stringList(node.domainname), 2);
    case "AlterDomainStmt":
    case "AlterEnumStmt":
    case "CreateEnumStmt":
    case "CreateRangeStmt":
      return schemaQualifier(stringList(node.typeName), 2);
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
    return schemaQualifier(stringList(typeName.names), 2);
  }
  const routine = unwrap(value, "ObjectWithArgs");
  if (routine !== undefined) {
    return schemaQualifier(stringList(routine.objname), 2);
  }
  const items = list(unwrap(value, "List")?.items);
  const [head] = items;
  if (unwrap(head, "TypeName") !== undefined) {
    // A domain constraint: (type, name).
    return objectSchema(head, 2);
  }
  return items.length === 0 ? null : schemaQualifier(stringList(value), parts);
}
