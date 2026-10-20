// Rules for the desired schema (spec "Rules: desired schema"): an allowlist
// of statements and supported object types. Everything else is refused with
// a reason. Kept apart from the deploy-time rules, which share only the
// splitter, the syntax-tree helpers and the side-effect denylist.
//
// Rule identifiers:
// - `desired-schema-statement`: a statement or clause outside the allowlist.
// - `unsupported-object`: an object type or feature V1 refuses.
// - `outside-managed-schema`, `undeclared-schema`: schema rules (schemas.ts).
// - `denylisted-call`: a built-in whose effects escape the transaction.
// - `plpgsql-dynamic-sql`, `plpgsql-transaction-control`: PL/pgSQL bodies.

import { denylistFindings } from "./denylist.ts";
import {
  grantees,
  privilegeNames,
  publicDefaults,
  schemaGrantBeyondUsage,
  schemaNames,
} from "./grants.ts";
import type { ParsedStatement } from "./parse.ts";
import { plpgsqlFindings, sqlBodyFindings } from "./routine-bodies.ts";
import type { RuleContext, RuleFinding } from "./rule-types.ts";
import { schemaFindings } from "./schemas.ts";
import { objectTypeKeyword, statementName } from "./statement-names.ts";
import {
  defElemString,
  defElems,
  isObject,
  type Json,
  list,
  statementBody,
  stringList,
  unwrap,
} from "./syntax-tree.ts";

type StatementCheck = (
  node: Json,
  statement: ParsedStatement,
  context: RuleContext,
) => RuleFinding[];

const notAllowed = (message: string): RuleFinding => ({
  rule: "desired-schema-statement",
  message,
});
const unsupported = (message: string): RuleFinding => ({
  rule: "unsupported-object",
  message,
});
const v1 = (what: string, tip = ""): RuleFinding =>
  unsupported(`${what} are not supported in V1${tip}`);

const redefinition = (clause: string): RuleFinding =>
  notAllowed(
    `${clause} is not allowed in the desired schema: define each object exactly once, so no definition can silently replace or skip another depending on load order`,
  );
const tablespaces = unsupported(
  "Tablespaces are not supported: storage layout differs between targets and rehearsals",
);

const allowed: Record<string, StatementCheck> = {
  CreateStmt: checkTable,
  ViewStmt: checkView,
  CreateTableAsStmt: checkMaterializedView,
  IndexStmt: checkIndex,
  CreateFunctionStmt: checkRoutine,
  CreateTrigStmt: checkTrigger,
  CreateDomainStmt: (node) => constraintFindings(node.constraints),
  CompositeTypeStmt: (node) => list(node.coldeflist).flatMap(columnFindings),
  CreatePolicyStmt: () => [],
  AlterTableStmt: checkAlterTable,
  CommentStmt: checkComment,
  GrantStmt: checkGrant,
  CreateExtensionStmt: checkExtension,
};

/**
 * Object types V1 refuses that a database can hold, with the reason given.
 * Shared by the rules (the statements creating them) and adoption (the
 * objects found on a target, `catalogObjectFinding`).
 */
const refusedObjects = {
  aggregates: () => v1("Custom aggregates"),
  rules: () => v1("Rules"),
  statistics: () => unsupported("CREATE STATISTICS is not supported in V1"),
  extensions: () => v1("Extensions other than plpgsql"),
  publications: () => v1("Publications and subscriptions"),
  operators: () =>
    v1("Custom operators", " (nor operator classes and families)"),
  collations: () => v1("Custom collations"),
  conversions: () => v1("Custom conversions"),
  textSearch: () =>
    v1(
      "Text-search configurations",
      " (nor their dictionaries, parsers and templates)",
    ),
  baseTypes: () => v1("Base types", ": use a domain or a composite type"),
  windowFunctions: () => routineOption("window"),
  virtualGeneratedColumns: () =>
    v1(
      "Virtual generated columns",
      " (a generated column without STORED is virtual in PostgreSQL 18): add STORED",
    ),
} satisfies Record<string, () => RuleFinding>;

function routineOption(name: string): RuleFinding {
  return unsupported(
    `The ${name.toUpperCase()} routine option is not supported in V1`,
  );
}

/** Refused statement types, with the reason given. */
const refused: Record<string, (node: Json) => RuleFinding> = {
  CreateEnumStmt: () =>
    v1(
      "Enums",
      ": use a lookup table with a foreign key, or a CHECK constraint",
    ),
  RuleStmt: refusedObjects.rules,
  CreateEventTrigStmt: () => v1("Event triggers"),
  CreateForeignTableStmt: foreign,
  CreateFdwStmt: foreign,
  CreateForeignServerStmt: foreign,
  CreateUserMappingStmt: foreign,
  ImportForeignSchemaStmt: foreign,
  CreatePublicationStmt: refusedObjects.publications,
  CreateSubscriptionStmt: refusedObjects.publications,
  CreateCastStmt: () => v1("Custom casts"),
  CreateOpClassStmt: refusedObjects.operators,
  CreateOpFamilyStmt: refusedObjects.operators,
  CreateConversionStmt: refusedObjects.conversions,
  CreateTransformStmt: () => v1("Transforms"),
  CreateAmStmt: () => v1("Custom access methods"),
  CreatePLangStmt: () => v1("Procedural languages"),
  CreateSeqStmt: () =>
    v1(
      "Standalone sequences",
      ": use an identity column (`bigint generated always as identity`)",
    ),
  CreateStatsStmt: refusedObjects.statistics,
  CreateRangeStmt: () => v1("Range types"),
  CreateSchemaStmt: () =>
    unsupported(
      "CREATE SCHEMA is not allowed in the desired schema: super-deploy manages one schema and creates it itself",
    ),
  CreateRoleStmt: roles,
  GrantRoleStmt: roles,
  DefineStmt: (node) => {
    switch (node.kind) {
      case "OBJECT_AGGREGATE":
        return refusedObjects.aggregates();
      case "OBJECT_OPERATOR":
        return refusedObjects.operators();
      case "OBJECT_COLLATION":
        return refusedObjects.collations();
      case "OBJECT_TSCONFIGURATION":
      case "OBJECT_TSDICTIONARY":
      case "OBJECT_TSPARSER":
      case "OBJECT_TSTEMPLATE":
        return refusedObjects.textSearch();
      case "OBJECT_TYPE":
        return refusedObjects.baseTypes();
      default:
        return notAllowed(
          `${String(node.kind)} definitions are not allowed in the desired schema`,
        );
    }
  },
};

function foreign(): RuleFinding {
  return v1("Foreign tables and foreign data wrappers");
}
function roles(): RuleFinding {
  return unsupported(
    "Roles are not managed by super-deploy: they are cluster-wide, so create them outside the desired schema",
  );
}

/**
 * Why V1 refuses an object a desired schema can't create at all, found in a
 * database's managed schema (verification/catalog.ts, kind `other`):
 * `object` as pg_describe_object names it, `line` its catalog line (for
 * routines `<prokind> <signature>`). The same reasons the rules give for
 * the statements that would create it.
 */
export function catalogObjectFinding(fact: {
  readonly object: string;
  readonly line: string;
}): RuleFinding {
  const { object, line } = fact;
  const startsWith = (prefix: string) => object.startsWith(prefix);
  if (startsWith("function ")) {
    return line.startsWith("w ")
      ? refusedObjects.windowFunctions()
      : refusedObjects.aggregates();
  }
  if (startsWith("type ")) {
    return refusedObjects.baseTypes();
  }
  if (startsWith("rule ")) {
    return refusedObjects.rules();
  }
  if (startsWith("statistics object ")) {
    return refusedObjects.statistics();
  }
  if (startsWith("extension ")) {
    return refusedObjects.extensions();
  }
  if (startsWith("publication ")) {
    return refusedObjects.publications();
  }
  if (startsWith("operator ")) {
    return refusedObjects.operators();
  }
  if (startsWith("collation ")) {
    return refusedObjects.collations();
  }
  if (startsWith("conversion ")) {
    return refusedObjects.conversions();
  }
  if (startsWith("text search ")) {
    return refusedObjects.textSearch();
  }
  return unsupported(`${object} is not supported in V1`);
}

/**
 * Why V1 refuses a virtual generated column found in a database's managed
 * schema (`isVirtualGeneratedColumn` in verification/catalog.ts), as the
 * rules refuse a statement declaring one.
 */
export function virtualGeneratedColumnFinding(): RuleFinding {
  return refusedObjects.virtualGeneratedColumns();
}

/** Every rule finding for one desired-schema statement. */
export function desiredSchemaFindings(
  statement: ParsedStatement,
  context: RuleContext,
): RuleFinding[] {
  const node = statementBody(statement);
  const refusal = refused[statement.nodeType];
  if (refusal !== undefined) {
    return [refusal(node)];
  }
  const check = allowed[statement.nodeType];
  if (check === undefined) {
    return [
      notAllowed(
        `${statementName(statement.nodeType)} is not allowed in the desired schema`,
      ),
    ];
  }
  return [
    ...check(node, statement, context),
    ...schemaFindings(statement, context),
    ...denylistFindings(statement.node),
  ];
}

// --- tables, columns and constraints ---------------------------------------

function checkTable(node: Json): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const relation = isObject(node.relation) ? node.relation : {};
  if (node.partspec !== undefined || node.partbound !== undefined) {
    findings.push(v1("Partitioned tables"));
  }
  if (list(node.inhRelations).length > 0 && node.partbound === undefined) {
    findings.push(unsupported("Table inheritance is not supported in V1"));
  }
  if (node.ofTypename !== undefined) {
    findings.push(v1("Typed tables (CREATE TABLE ... OF type)"));
  }
  findings.push(...persistence(relation, "tables"));
  if (node.tablespacename !== undefined) {
    findings.push(tablespaces);
  }
  if (node.accessMethod !== undefined) {
    findings.push(v1("Table access methods"));
  }
  if (list(node.options).length > 0) {
    findings.push(v1("Table storage parameters"));
  }
  if (node.if_not_exists === true) {
    findings.push(redefinition("CREATE TABLE IF NOT EXISTS"));
  }
  // CREATE TABLE ... (LIKE) is refused by ordering (`table-like`).
  for (const element of list(node.tableElts)) {
    const column = unwrap(element, "ColumnDef");
    if (column !== undefined) {
      findings.push(...columnFindings({ ColumnDef: column }));
    }
    findings.push(...constraintFindings([element]));
  }
  findings.push(...constraintFindings(node.constraints));
  return findings;
}

function persistence(relation: Json, what: "tables" | "views"): RuleFinding[] {
  if (relation.relpersistence === "t") {
    const name = what === "tables" ? "Temporary tables" : "Temporary views";
    return [unsupported(`${name} are not allowed in the desired schema`)];
  }
  if (relation.relpersistence === "u") {
    return [v1("Unlogged tables")];
  }
  return [];
}

const serialTypes = new Set([
  "serial",
  "serial4",
  "bigserial",
  "serial8",
  "smallserial",
  "serial2",
]);

function columnFindings(element: unknown): RuleFinding[] {
  const column = unwrap(element, "ColumnDef");
  if (column === undefined) {
    return [];
  }
  const findings: RuleFinding[] = [];
  const typeNames = stringList(
    isObject(column.typeName) ? column.typeName.names : undefined,
  );
  const [only] = typeNames;
  if (typeNames.length === 1 && only !== undefined && serialTypes.has(only)) {
    findings.push(
      unsupported(
        `${only} columns are not supported: use an identity column, e.g. \`bigint generated always as identity\``,
      ),
    );
  }
  if (column.storage_name !== undefined || column.compression !== undefined) {
    findings.push(v1("Column STORAGE and COMPRESSION settings"));
  }
  findings.push(...constraintFindings(column.constraints));
  return findings;
}

function constraintFindings(nodes: unknown): RuleFinding[] {
  const findings: RuleFinding[] = [];
  for (const item of list(nodes)) {
    const constraint = unwrap(item, "Constraint");
    if (constraint === undefined) {
      continue;
    }
    const type = constraint.contype;
    if (
      type === "CONSTR_ATTR_NOT_ENFORCED" ||
      ((type === "CONSTR_CHECK" || type === "CONSTR_FOREIGN") &&
        constraint.is_enforced !== true)
    ) {
      findings.push(v1("NOT ENFORCED constraints"));
    }
    if (type === "CONSTR_GENERATED" && constraint.generated_kind !== "s") {
      findings.push(refusedObjects.virtualGeneratedColumns());
    }
    if (constraint.indexspace !== undefined) {
      findings.push(tablespaces);
    }
  }
  return findings;
}

// --- views, materialized views, indexes ------------------------------------

const viewOptions = new Set([
  "security_invoker",
  "security_barrier",
  "check_option",
]);

function checkView(node: Json): RuleFinding[] {
  const findings = persistence(isObject(node.view) ? node.view : {}, "views");
  if (node.replace === true) {
    findings.push(redefinition("CREATE OR REPLACE VIEW"));
  }
  for (const { name } of defElems(node.options)) {
    if (!viewOptions.has(name)) {
      findings.push(unsupported(`View option ${name} is not supported in V1`));
    }
  }
  return findings;
}

function checkMaterializedView(node: Json): RuleFinding[] {
  if (node.objtype !== "OBJECT_MATVIEW") {
    return [
      notAllowed(
        "CREATE TABLE AS is not allowed in the desired schema: declare the table with CREATE TABLE",
      ),
    ];
  }
  const into = isObject(node.into) ? node.into : {};
  const findings: RuleFinding[] = [];
  if (node.if_not_exists === true) {
    findings.push(redefinition("CREATE MATERIALIZED VIEW IF NOT EXISTS"));
  }
  if (into.tableSpaceName !== undefined) {
    findings.push(tablespaces);
  }
  if (into.accessMethod !== undefined) {
    findings.push(v1("Table access methods"));
  }
  if (list(into.options).length > 0) {
    findings.push(v1("Materialized view storage parameters"));
  }
  return findings;
}

function checkIndex(node: Json): RuleFinding[] {
  const findings: RuleFinding[] = [];
  if (node.concurrent === true) {
    findings.push(
      notAllowed(
        "CREATE INDEX CONCURRENTLY is not allowed: it cannot run inside the deployment's transaction",
      ),
    );
  }
  if (node.tableSpace !== undefined) {
    findings.push(tablespaces);
  }
  if (node.if_not_exists === true) {
    findings.push(redefinition("CREATE INDEX IF NOT EXISTS"));
  }
  return findings;
}

// --- routines and triggers --------------------------------------------------

const routineOptions = new Set([
  "as",
  "language",
  "volatility",
  "strict",
  "security",
  "leakproof",
  "parallel",
  "cost",
  "rows",
  "set",
]);

function checkRoutine(
  node: Json,
  statement: ParsedStatement,
  context: RuleContext,
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const kind = node.is_procedure === true ? "PROCEDURE" : "FUNCTION";
  if (node.replace === true) {
    findings.push(redefinition(`CREATE OR REPLACE ${kind}`));
  }
  const options = defElems(node.options);
  for (const { name } of options) {
    if (!routineOptions.has(name)) {
      findings.push(routineOption(name));
    }
  }
  const language = defElemString(
    options.find((option) => option.name === "language")?.arg,
  )?.toLowerCase();
  if (language !== undefined && language !== "sql" && language !== "plpgsql") {
    findings.push(
      unsupported(
        `Functions in language ${language} are not supported: write routines in sql or plpgsql`,
      ),
    );
    return findings;
  }
  const body = options.find((option) => option.name === "as")?.arg;
  if (language === "plpgsql") {
    findings.push(...plpgsqlFindings(statement, body, context));
  } else if (language === "sql" && node.sql_body === undefined) {
    findings.push(...sqlBodyFindings(statement, body, context));
  }
  return findings;
}

function checkTrigger(node: Json): RuleFinding[] {
  const findings: RuleFinding[] = [];
  if (node.replace === true) {
    findings.push(redefinition("CREATE OR REPLACE TRIGGER"));
  }
  if (node.isconstraint === true) {
    findings.push(v1("Constraint triggers"));
  }
  return findings;
}

// --- ALTER TABLE, COMMENT, GRANT, CREATE EXTENSION ---------------------------

const alterTableCommands = new Set([
  "AT_EnableRowSecurity",
  "AT_ForceRowSecurity",
  "AT_AddConstraint",
]);

function checkAlterTable(node: Json): RuleFinding[] {
  const onlyThese = notAllowed(
    "Only ALTER TABLE ... ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY or ADD CONSTRAINT is allowed in the desired schema; declare everything else in CREATE TABLE",
  );
  if (node.objtype !== "OBJECT_TABLE") {
    return [onlyThese];
  }
  const commands = list(node.cmds).map(
    (command) => unwrap(command, "AlterTableCmd") ?? {},
  );
  if (
    commands.some((command) => !alterTableCommands.has(String(command.subtype)))
  ) {
    return [onlyThese];
  }
  const findings: RuleFinding[] = [];
  if (commands.length !== 1) {
    findings.push(
      notAllowed(
        "Write one ALTER TABLE statement per change in the desired schema",
      ),
    );
  }
  if (node.missing_ok === true) {
    findings.push(redefinition("ALTER TABLE IF EXISTS"));
  }
  for (const command of commands) {
    findings.push(...constraintFindings([command.def]));
  }
  return findings;
}

const commentTypes = new Set([
  "OBJECT_TABLE",
  "OBJECT_COLUMN",
  "OBJECT_VIEW",
  "OBJECT_MATVIEW",
  "OBJECT_INDEX",
  "OBJECT_SEQUENCE",
  "OBJECT_TABCONSTRAINT",
  "OBJECT_DOMCONSTRAINT",
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_ROUTINE",
  "OBJECT_TRIGGER",
  "OBJECT_POLICY",
  "OBJECT_TYPE",
  "OBJECT_DOMAIN",
]);

function checkComment(node: Json): RuleFinding[] {
  return commentTypes.has(String(node.objtype))
    ? []
    : [
        notAllowed(
          `COMMENT ON ${objectTypeKeyword(node.objtype)} is not allowed in the desired schema: comment only on the objects it defines`,
        ),
      ];
}

const grantTypes = new Set([
  "OBJECT_TABLE",
  "OBJECT_SEQUENCE",
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_ROUTINE",
  "OBJECT_TYPE",
  "OBJECT_DOMAIN",
]);

const objectTypePlurals: Readonly<Record<string, string>> = {
  OBJECT_FUNCTION: "functions",
  OBJECT_PROCEDURE: "procedures",
  OBJECT_ROUTINE: "routines",
  OBJECT_TYPE: "types",
  OBJECT_DOMAIN: "domains",
  OBJECT_TABLE: "tables",
  OBJECT_SEQUENCE: "sequences",
};

function checkGrant(
  node: Json,
  _statement: ParsedStatement,
  context: RuleContext,
): RuleFinding[] {
  const verb = node.is_grant === true ? "GRANT" : "REVOKE";
  if (node.targtype !== "ACL_TARGET_OBJECT") {
    return [
      notAllowed(
        `${verb} ... ON ALL ... IN SCHEMA is not allowed in the desired schema: it depends on which objects exist when it runs, so ${verb.toLowerCase()} on each object`,
      ),
    ];
  }
  if (node.objtype === "OBJECT_SCHEMA") {
    const others = schemaNames(node).filter(
      (schema) => schema !== context.managedSchema,
    );
    if (others.length > 0) {
      return [
        notAllowed(
          `${verb} ON SCHEMA ${others.join(", ")} is not allowed in the desired schema: grant USAGE only on the managed schema "${context.managedSchema}"; other schemas are set up outside super-deploy`,
        ),
      ];
    }
  } else if (!grantTypes.has(String(node.objtype))) {
    return [
      notAllowed(
        `${verb} ON ${objectTypeKeyword(node.objtype)} is not allowed in the desired schema: ${verb.toLowerCase()} only on the objects it defines`,
      ),
    ];
  }
  if (node.is_grant !== true) {
    return checkRevoke(node, context);
  }
  const beyondUsage = schemaGrantBeyondUsage(node);
  if (beyondUsage !== undefined) {
    return [
      notAllowed(
        `GRANT ${beyondUsage.toUpperCase()} ON SCHEMA is not allowed in the desired schema: grant only USAGE on the managed schema; objects are created by the deploy role`,
      ),
    ];
  }
  return [];
}

/**
 * REVOKE is allowed only to take away PostgreSQL's default privileges for
 * PUBLIC on objects the desired schema defines (ADR-0002): the desired
 * schema declares what is granted, so every other REVOKE would only undo
 * one of its own GRANTs.
 */
function checkRevoke(node: Json, context: RuleContext): RuleFinding[] {
  const others = grantees(node).filter((role) => role !== null);
  if (others.length > 0) {
    return [
      notAllowed(
        `REVOKE FROM ${others.join(", ")} is not allowed in the desired schema: it declares what is granted, so remove the GRANT instead; only PostgreSQL's default privileges for PUBLIC may be revoked`,
      ),
    ];
  }
  if (node.grant_option === true) {
    return [
      notAllowed(
        "REVOKE GRANT OPTION FOR is not allowed in the desired schema: PUBLIC holds no grant options by default",
      ),
    ];
  }
  if (node.grantor !== undefined) {
    return [
      notAllowed(
        "REVOKE ... GRANTED BY is not allowed in the desired schema: PUBLIC's default privileges are granted by the owner, so revoke them without GRANTED BY",
      ),
    ];
  }
  const objtype = String(node.objtype);
  const privileges = privilegeNames(node);
  const expected =
    objtype === "OBJECT_SCHEMA" && context.managedSchema !== "public"
      ? undefined
      : publicDefaults[objtype];
  const what =
    objtype === "OBJECT_SCHEMA"
      ? `schema ${context.managedSchema}`
      : (objectTypePlurals[objtype] ?? objectTypeKeyword(objtype));
  if (expected === undefined) {
    return [
      notAllowed(
        `PUBLIC has no privileges on ${what} by default, so there is nothing to revoke: the desired schema declares what is granted, so remove the GRANT instead`,
      ),
    ];
  }
  if (privileges.length === 0) {
    return [
      notAllowed(
        `REVOKE ALL is not allowed in the desired schema: name the default privilege, REVOKE ${expected.toUpperCase()}`,
      ),
    ];
  }
  const other = privileges.find((privilege) => privilege !== expected);
  if (other !== undefined) {
    return [
      notAllowed(
        `PUBLIC has no ${other.toUpperCase()} privilege on ${what} by default: revoke ${expected.toUpperCase()}, its only default privilege`,
      ),
    ];
  }
  return [];
}

function checkExtension(node: Json): RuleFinding[] {
  if (node.extname !== "plpgsql") {
    return [refusedObjects.extensions()];
  }
  return list(node.options).length > 0
    ? [
        unsupported(
          "CREATE EXTENSION plpgsql takes no options in the desired schema",
        ),
      ]
    : [];
}

/**
 * True for `CREATE EXTENSION [IF NOT EXISTS] plpgsql`: plpgsql is installed
 * in every database, so loading skips the statement (PostgreSQL would refuse
 * it without IF NOT EXISTS).
 */
export function isAlreadyInstalled(statement: ParsedStatement): boolean {
  return unwrap(statement.node, "CreateExtensionStmt")?.extname === "plpgsql";
}
