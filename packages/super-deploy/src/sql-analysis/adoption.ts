// Adoption (`init --adopt`): the statements the differ generates to build an
// existing database from nothing, turned into desired-schema files. The
// differ reads the whole database, so this keeps only statements about
// objects in the managed schema, and sorts them into one file per kind of
// object. What it keeps is checked by the desired-schema rules afterwards,
// exactly like hand-written files: nothing here decides what V1 supports.
//
// Statements are left out when they are:
// - about objects outside the managed schema, or not in any schema (roles,
//   schemas themselves, event triggers, casts, foreign servers...): the
//   managed schema is all super-deploy manages.
// - ownership changes (`ALTER ... OWNER TO`): ownership isn't modelled;
//   objects belong to whoever deploys them.
// - for objects a desired schema can never create and the catalog check
//   reports itself (aggregates, operators, rules, statistics objects,
//   extensions, publications...; verification/catalog.ts `other`), so each
//   is listed once with its reason (`unsupportedCatalogObject`).
//
// The differ never generates grants, default privileges, policies or
// row-level security (differ/pg-delta.ts): they stay on the target.
//
// A serial column comes as a CREATE SEQUENCE and an ALTER SEQUENCE ... OWNED
// BY. They are kept (the column's DEFAULT nextval() references the
// sequence), and adoption refuses the column once instead of the two
// statements (`isSequenceStatement`, commands/adopt.ts).
//
// ALTER TABLEs the differ splits off a table's CREATE TABLE (columns,
// storage parameters) are folded back into it (adoption-folding.ts).
//
// Rehearsals never contain external schemas, so a generated statement that
// references one where PostgreSQL resolves it at CREATE (a view, a foreign
// key, a LANGUAGE sql body...) can never load. Adoption finds them all
// statically (`externalSchemaReferences`) and refuses them at once, named
// by object (`adoptedObject`), rather than at the first statement the
// throwaway database refuses.
import { foldTableAlters, type KeptStatement } from "./adoption-folding.ts";
import { overrideObject } from "./overrides.ts";
import { type ParsedStatement, parseSqlFile, type SqlFile } from "./parse.ts";
import { statementFacts } from "./references.ts";
import { externalSchemasBoundAtCreate } from "./routine-bodies.ts";
import type { RuleContext } from "./rule-types.ts";
import {
  alterTableCommands,
  defElems,
  isObject,
  type Json,
  list,
  rangeVar,
  schemaQualifier,
  statementBody,
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
  CommentStmt: "comments.sql",
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

/** COMMENT ON object types the catalog check reports. */
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
  /** Each managed table's column names in the target's order (attnum). */
  readonly columnOrder: Readonly<Record<string, readonly string[]>>;
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
  const kept: (KeptStatement & { readonly file: string })[] = [];
  for (const sql of statements) {
    const statement = await parsedStatement(sql);
    const file = fileFor(statement, options);
    if (file !== undefined) {
      kept.push({ sql, file, type: "", node: {}, ...statement });
    }
  }
  const files = new Map<string, string[]>();
  for (const { sql, file } of foldTableAlters(kept, options.columnOrder)) {
    const texts = files.get(file) ?? [];
    texts.push(desiredText(sql));
    files.set(file, texts);
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

/**
 * Whether `sql` is a CREATE SEQUENCE or ALTER SEQUENCE of one of
 * `sequences` (names in the managed schema).
 */
export async function isSequenceStatement(
  sql: string,
  sequences: readonly string[],
): Promise<boolean> {
  const statement = await parsedStatement(sql);
  return (
    (statement?.type === "CreateSeqStmt" ||
      statement?.type === "AlterSeqStmt") &&
    sequences.includes(String(rangeVar(statement.node.sequence).relname))
  );
}

/** A generated statement that references external schemas bound at CREATE. */
export interface ExternalSchemaReference {
  /** What the statement creates, as `adoptedObject` names it. */
  readonly object: string;
  /** How to find that object on the target, to name it as its catalogs do. */
  readonly reference: CatalogReference | undefined;
  /** The declared external schemas it references. */
  readonly schemas: readonly string[];
}

/**
 * Every statement in the generated files, in file order, that references a
 * declared external schema where PostgreSQL resolves it at CREATE
 * (`externalSchemasBoundAtCreate`). A file that doesn't parse is skipped:
 * the rules report it.
 */
export async function externalSchemaReferences(
  files: readonly SqlFile[],
  context: RuleContext,
): Promise<ExternalSchemaReference[]> {
  const references: ExternalSchemaReference[] = [];
  for (const file of files) {
    const parsed = await parseSqlFile(file);
    for (const statement of parsed.ok ? parsed.statements : []) {
      const schemas = externalSchemasBoundAtCreate(
        statement,
        context.externalSchemas,
      );
      if (schemas.length > 0) {
        references.push({
          object: adoptedObject(statement, context.managedSchema),
          reference: adoptedObjectReference(statement, context.managedSchema),
          schemas,
        });
      }
    }
  }
  return references;
}

/**
 * The object a generated statement creates, named as override markers name
 * it (`overrideObject`, e.g. `function user_name(bigint)`), except that an
 * ALTER TABLE adding one constraint names the constraint as the drift check
 * does: `constraint profiles_user_id_fkey on table profiles`.
 */
export function adoptedObject(
  statement: ParsedStatement,
  managedSchema: string,
): string {
  const object = overrideObject(statement, managedSchema);
  if (statement.nodeType !== "AlterTableStmt") {
    return object;
  }
  const commands = alterTableCommands(statementBody(statement));
  const constraint = unwrap(commands[0]?.def, "Constraint");
  return commands.length === 1 &&
    commands[0]?.subtype === "AT_AddConstraint" &&
    typeof constraint?.conname === "string"
    ? `constraint ${constraint.conname} on ${object}`
    : object;
}

/**
 * How to find the object a generated statement creates in the target's
 * catalogs, by name: a relation (`to_regclass`), a type (`to_regtype`), a
 * routine (`to_regprocedure`), or a trigger or constraint (`member`) on a
 * relation. Names are quoted and qualified, routines' argument types as
 * the statement writes them, so they resolve with the managed schema and
 * pg_catalog on the search path.
 */
export interface CatalogReference {
  readonly kind: "relation" | "type" | "routine" | "trigger" | "constraint";
  readonly name: string;
  readonly member?: string;
}

/**
 * The catalog reference for the object a generated statement creates (or,
 * for an ALTER TABLE, alters: a constraint it adds, else the table), or
 * undefined for a statement adoption names by `adoptedObject` alone.
 */
export function adoptedObjectReference(
  statement: ParsedStatement,
  managedSchema: string,
): CatalogReference | undefined {
  const node = statementBody(statement);
  /** A relation's name, or `name` in the relation's schema. */
  const relation = (value: unknown, name?: unknown): string | undefined => {
    const found = rangeVar(value);
    const own = name ?? found.relname;
    return typeof own === "string"
      ? qualified(managedSchema, [
          ...(typeof found.schemaname === "string" ? [found.schemaname] : []),
          own,
        ])
      : undefined;
  };
  const reference = (
    kind: CatalogReference["kind"],
    name: string | undefined,
    member?: unknown,
  ): CatalogReference | undefined => {
    if (name === undefined) {
      return undefined;
    }
    if (kind !== "trigger" && kind !== "constraint") {
      return { kind, name };
    }
    return typeof member === "string" ? { kind, name, member } : undefined;
  };
  switch (statement.nodeType) {
    case "CreateStmt":
      return reference("relation", relation(node.relation));
    case "CreateSeqStmt":
    case "AlterSeqStmt":
      return reference("relation", relation(node.sequence));
    case "CreateForeignTableStmt":
      return reference(
        "relation",
        relation(isObject(node.base) ? node.base.relation : undefined),
      );
    case "ViewStmt":
      return reference("relation", relation(node.view));
    case "CreateTableAsStmt":
      return reference(
        "relation",
        relation(isObject(node.into) ? node.into.rel : undefined),
      );
    case "IndexStmt":
      return typeof node.idxname === "string"
        ? reference("relation", relation(node.relation, node.idxname))
        : undefined;
    case "CompositeTypeStmt":
      return reference("type", relation(node.typevar));
    case "CreateEnumStmt":
    case "CreateRangeStmt":
    case "AlterEnumStmt":
    case "AlterDomainStmt":
      return reference(
        "type",
        qualified(managedSchema, stringList(node.typeName)),
      );
    case "CreateDomainStmt":
      return reference(
        "type",
        qualified(managedSchema, stringList(node.domainname)),
      );
    case "CreateFunctionStmt": {
      const routine = statementFacts(statement.node, managedSchema)?.routine;
      return routine === undefined
        ? undefined
        : reference(
            "routine",
            `${qualified(managedSchema, stringList(node.funcname))}(${routine.arguments.join(",")})`,
          );
    }
    case "CreateTrigStmt":
      return reference("trigger", relation(node.relation), node.trigname);
    case "AlterTableStmt": {
      const commands = alterTableCommands(node);
      const constraint = unwrap(commands[0]?.def, "Constraint");
      return commands.length === 1 &&
        commands[0]?.subtype === "AT_AddConstraint"
        ? reference("constraint", relation(node.relation), constraint?.conname)
        : reference("relation", relation(node.relation));
    }
    default:
      return undefined;
  }
}

/** `names` (schema-qualified or not) as a quoted name in `schema` by default. */
function qualified(schema: string, names: readonly string[]): string {
  const parts = names.length === 1 ? [schema, ...names] : names;
  return parts.map((part) => `"${part.replaceAll('"', '""')}"`).join(".");
}

/**
 * A generated statement's type and syntax tree, or undefined unless it is
 * exactly one statement.
 */
async function parsedStatement(
  sql: string,
): Promise<{ type: string; node: Json } | undefined> {
  const parsed = await parseSqlFile({ path: "generated.sql", text: sql });
  const [statement] = parsed.ok ? parsed.statements : [];
  if (statement === undefined || (parsed.ok && parsed.statements.length > 1)) {
    return undefined;
  }
  return { type: statement.nodeType, node: statementBody(statement) };
}

/** The file a generated statement goes to, or undefined to leave it out. */
function fileFor(
  statement: { type: string; node: Json } | undefined,
  { managedSchema }: AdoptionOptions,
): string | undefined {
  if (statement === undefined) {
    // Never expected from the differ; the rules report what's wrong with it.
    return otherFile;
  }
  const { type, node } = statement;
  if (
    catalogObjectStatements.has(type) ||
    isOwnershipChange(type, node) ||
    isWindowFunction(type, node) ||
    (type === "CommentStmt" && catalogObjectTypes.has(String(node.objtype)))
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
    default:
      return null;
  }
}

function relationSchema(value: unknown): string | null | undefined {
  const relation = rangeVar(value);
  if (typeof relation.relname !== "string") {
    return null;
  }
  return typeof relation.schemaname === "string"
    ? relation.schemaname
    : undefined;
}

/** The schema of a COMMENT object: a name list, RangeVar, TypeName or routine. */
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
