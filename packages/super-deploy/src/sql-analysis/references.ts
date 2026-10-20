// What one desired-schema statement creates and what it needs to exist first,
// read from its PostgreSQL 18 syntax tree (ADR-0004).
//
// Only references PostgreSQL binds at CREATE matter for ordering: relations,
// types and functions named in column types, defaults, checks, generated
// expressions, view queries, index expressions, trigger WHEN clauses, policy
// expressions, function signatures and argument defaults, `BEGIN ATOMIC` /
// `RETURN` bodies, `LANGUAGE sql` string bodies (validated at CREATE because
// check_function_bodies is on), `%TYPE`, `'x'::regclass`-style literals and
// `nextval('seq')`. PL/pgSQL bodies are late-bound and ignored.
//
// Names are keys in namespaces: `rel:` (anything in pg_class: tables, views,
// indexes, sequences, composite types), `type:` (tables' and views' row
// types, composite types, domains), `func:` (every overload of a name),
// `con:table.name`, `domcon:domain.name`, `trigger:table.name`,
// `policy:table.name`, `ext:name` (extensions, which routines in their
// language wait for), plus `uniq:table` (every unique key of a table, which
// a foreign key to it waits for).
import type { Node } from "@pgsql/types";
import { parseSync } from "libpg-query";
import { generatedName } from "./generated-names.ts";
import { isObject, type Json } from "./syntax-tree.ts";

export type StatementKind =
  | "extension"
  | "type"
  | "domain"
  | "table"
  | "function"
  | "procedure"
  | "view"
  | "materialized view"
  | "constraint"
  | "index"
  | "trigger"
  | "policy"
  | "row level security"
  | "revoke"
  | "grant"
  | "comment";

/** Decorations: nothing binds to them, so they always load after every other statement. */
export const decorationKinds: ReadonlySet<StatementKind> = new Set([
  "row level security",
  "revoke",
  "grant",
  "comment",
]);

export type ReferenceKind =
  | "relation"
  | "type"
  | "function"
  | "constraint"
  | "trigger"
  | "policy";

export interface Reference {
  readonly kind: ReferenceKind;
  /** The key the reference resolves to, e.g. `rel:customers`. */
  readonly key: string;
  /** The name as written, for messages. */
  readonly name: string;
  /** Schema-qualified with the managed schema: only the desired schema may provide it. */
  readonly managedOnly: boolean;
}

export interface UniqueKey {
  readonly table: string;
  /** Sorted column names. */
  readonly columns: readonly string[];
  /** e.g. `constraint parent_code_key`, `index parent_code_uidx`. */
  readonly source: string;
  readonly primary: boolean;
}

export interface ForeignKey {
  readonly table: string;
  /** Referenced columns as written; empty means the primary key. */
  readonly columns: readonly string[];
  readonly constraint: string;
}

export interface GeneratedConstraintName {
  readonly name: string;
  /** What the name is generated for, e.g. `the primary key of table t`. */
  readonly what: string;
}

export interface Problem {
  readonly rule: string;
  readonly message: string;
}

export interface StatementFacts {
  kind: StatementKind;
  /** Identifies the object (or decoration) the statement creates; never includes file names. */
  identity: string;
  provides: string[];
  references: Reference[];
  /** Keys this statement waits for if anything provides them, but that may be absent. */
  waitsFor: string[];
  uniqueKeys: UniqueKey[];
  foreignKeys: ForeignKey[];
  /** Constraint names PostgreSQL generates (namespace-wide uniqueness). */
  generatedConstraintNames: GeneratedConstraintName[];
  /** Constraint names written explicitly. */
  constraintNames: string[];
  /** Function names used in column syntax candidates: the last field of `a.b` and `(x).b`. */
  fieldSelections: string[];
  /** For routines: the name and input argument types (identity form). */
  routine?: { name: string; arguments: string[] };
  problems: Problem[];
}

function strings(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const out: string[] = [];
  for (const item of list) {
    const value = isObject(item)
      ? (item.String as Json | undefined)
      : undefined;
    if (typeof value?.sval === "string") {
      out.push(value.sval);
    }
  }
  return out;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function relName(value: unknown): string {
  return isObject(value) ? (str(value.relname) ?? "?") : "?";
}

const serialTypes = new Set([
  "serial",
  "serial2",
  "serial4",
  "serial8",
  "smallserial",
  "bigserial",
]);

/** Walks a syntax tree collecting every reference it makes. */
class Collector {
  readonly references: Reference[] = [];
  readonly ctes = new Set<string>();
  readonly foreignKeys: {
    table: string;
    columns: string[];
    conname: string;
  }[] = [];
  readonly fieldSelections: string[] = [];
  readonly problems: Problem[] = [];

  private readonly managedSchema: string;

  constructor(managedSchema: string) {
    this.managedSchema = managedSchema;
  }

  /** The unqualified name if `parts` names something in the managed schema (or unqualified). */
  private qualified(
    parts: readonly string[],
  ): { name: string; managedOnly: boolean } | undefined {
    const name = parts.at(-1);
    if (name === undefined) {
      return undefined;
    }
    if (parts.length === 1) {
      return { name, managedOnly: false };
    }
    const schema = parts.at(-2);
    if (schema === this.managedSchema) {
      return { name, managedOnly: true };
    }
    // pg_catalog is always there; other schemas are the rules' business.
    return undefined;
  }

  add(kind: ReferenceKind, parts: readonly string[], prefix: string): void {
    const found = this.qualified(parts);
    if (found === undefined) {
      return;
    }
    this.references.push({
      kind,
      key: `${prefix}:${found.name}`,
      name: parts.join("."),
      managedOnly: found.managedOnly,
    });
  }

  relation(rangeVar: Json): void {
    const parts = [rangeVar.catalogname, rangeVar.schemaname, rangeVar.relname]
      .map(str)
      .filter((part) => part !== undefined);
    this.add("relation", parts, "rel");
  }

  typeName(typeName: Json): void {
    const names = strings(typeName.names);
    if (typeName.pct_type === true) {
      // table.column%TYPE is resolved against the table at CREATE.
      this.add("relation", names.slice(0, -1), "rel");
      return;
    }
    if (names.length === 1 && serialTypes.has(names[0] ?? "")) {
      return;
    }
    this.add("type", names, "type");
  }

  function(names: readonly string[]): void {
    this.add("function", names, "func");
  }

  walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        this.walk(item);
      }
      return;
    }
    if (!isObject(node)) {
      return;
    }
    if (typeof node.relname === "string" && "relpersistence" in node) {
      this.relation(node);
    }
    if (Array.isArray(node.names) && "typemod" in node) {
      this.typeName(node);
    }
    if (Array.isArray(node.funcname) && "funcformat" in node) {
      // A FuncCall, wrapped or not (CALL's funccall is unwrapped).
      this.funcCall(node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (!isObject(value) && !Array.isArray(value)) {
        continue;
      }
      if (isObject(value)) {
        switch (key) {
          case "CommonTableExpr":
            if (typeof value.ctename === "string") {
              this.ctes.add(value.ctename);
            }
            break;
          case "TypeCast":
            this.regLiteral(value);
            break;
          case "Constraint":
            this.constraint(value);
            break;
          case "ColumnRef":
            this.columnRef(value);
            break;
          case "A_Indirection":
            this.indirection(value);
            break;
        }
      }
      this.walk(value);
    }
  }

  private funcCall(call: Json): void {
    const names = strings(call.funcname);
    this.function(names);
    // nextval('seq') and friends resolve their sequence at CREATE.
    const name = names.at(-1);
    if (name === "nextval" || name === "currval" || name === "setval") {
      const literal = stringLiteral(
        Array.isArray(call.args) ? call.args[0] : undefined,
      );
      if (literal !== undefined) {
        this.add("relation", splitQualifiedName(literal), "rel");
      }
    }
  }

  /** 'name'::regclass, ::regtype, ::regproc and ::regprocedure literals resolve to OIDs at CREATE. */
  private regLiteral(cast: Json): void {
    const target = strings((cast.typeName as Json | undefined)?.names).at(-1);
    const literal = stringLiteral(cast.arg);
    if (target === undefined || literal === undefined) {
      return;
    }
    if (target === "regclass") {
      this.add("relation", splitQualifiedName(literal), "rel");
    } else if (target === "regproc" || target === "regprocedure") {
      this.add(
        "function",
        splitQualifiedName(literal.replace(/\(.*$/s, "")),
        "func",
      );
    }
    // regtype accepts any SQL type syntax ('integer', 'int[]'), so it is left to PostgreSQL.
  }

  private constraint(constraint: Json): void {
    if (
      constraint.contype !== "CONSTR_FOREIGN" ||
      !isObject(constraint.pktable)
    ) {
      return;
    }
    const table = this.qualified(
      [constraint.pktable.schemaname, constraint.pktable.relname]
        .map(str)
        .filter((part) => part !== undefined),
    );
    if (table !== undefined) {
      this.foreignKeys.push({
        table: table.name,
        columns: strings(constraint.pk_attrs),
        conname: str(constraint.conname) ?? "",
      });
    }
  }

  private columnRef(ref: Json): void {
    const fields = Array.isArray(ref.fields) ? ref.fields : [];
    if (fields.length < 2) {
      return;
    }
    const last = strings([fields.at(-1)])[0];
    if (last !== undefined) {
      this.fieldSelections.push(last);
    }
  }

  private indirection(indirection: Json): void {
    for (const name of strings(indirection.indirection)) {
      this.fieldSelections.push(name);
    }
  }
}

function stringLiteral(node: unknown): string | undefined {
  if (!isObject(node) || !isObject(node.A_Const)) {
    return undefined;
  }
  const sval = node.A_Const.sval;
  return isObject(sval) && typeof sval.sval === "string"
    ? sval.sval
    : undefined;
}

/** Splits `a."B".c` the way PostgreSQL reads a qualified name in a string. */
export function splitQualifiedName(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let wasQuoted = false;
  const finish = () => {
    parts.push(wasQuoted ? current : current.trim().toLowerCase());
    current = "";
    wasQuoted = false;
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        current += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (character === ".") {
      finish();
    } else {
      current += character;
    }
  }
  finish();
  return parts;
}

/** A type name as it appears in a routine's identity: `int4`, `text[]`, `customers`. */
function typeText(typeName: unknown): string {
  if (!isObject(typeName)) {
    return "?";
  }
  const names = strings(typeName.names);
  const shown = names[0] === "pg_catalog" ? names.slice(1) : names;
  const suffix = typeName.pct_type === true ? "%type" : "";
  const array = Array.isArray(typeName.arrayBounds)
    ? "[]".repeat(typeName.arrayBounds.length)
    : "";
  return `${shown.join(".")}${suffix}${array}`;
}

const inputModes = new Set([
  "FUNC_PARAM_DEFAULT",
  "FUNC_PARAM_IN",
  "FUNC_PARAM_INOUT",
  "FUNC_PARAM_VARIADIC",
]);

function functionArgumentTypes(parameters: unknown): string[] {
  if (!Array.isArray(parameters)) {
    return [];
  }
  return parameters
    .map((parameter) =>
      isObject(parameter) ? parameter.FunctionParameter : undefined,
    )
    .filter(isObject)
    .filter((parameter) =>
      inputModes.has(str(parameter.mode) ?? "FUNC_PARAM_DEFAULT"),
    )
    .map((parameter) => typeText(parameter.argType));
}

function objectWithArgs(value: unknown): { names: string[]; text: string } {
  if (!isObject(value)) {
    return { names: [], text: "?" };
  }
  const names = strings(value.objname);
  const args = Array.isArray(value.objargs)
    ? value.objargs.map((arg) =>
        typeText(isObject(arg) ? arg.TypeName : undefined),
      )
    : undefined;
  return {
    names,
    text: `${names.join(".")}${args === undefined ? "" : `(${args.join(",")})`}`,
  };
}

function unqualified(names: readonly string[]): string {
  return names.at(-1) ?? "?";
}

/** Facts about one statement. `node` is the statement's syntax tree. */
export function statementFacts(
  node: Node,
  managedSchema: string,
): StatementFacts | undefined {
  const [type, body] = Object.entries(node)[0] ?? [];
  if (type === undefined || !isObject(body)) {
    return undefined;
  }
  const collector = new Collector(managedSchema);
  const facts: StatementFacts = {
    kind: "table",
    identity: "",
    provides: [],
    references: collector.references,
    waitsFor: [],
    uniqueKeys: [],
    foreignKeys: [],
    generatedConstraintNames: [],
    constraintNames: [],
    fieldSelections: collector.fieldSelections,
    problems: collector.problems,
  };
  const extracted = extractors[type]?.(body, facts, collector, managedSchema);
  if (extracted === undefined) {
    return undefined;
  }
  for (const foreign of collector.foreignKeys) {
    facts.waitsFor.push(`uniq:${foreign.table}`);
    facts.foreignKeys.push({
      table: foreign.table,
      columns: foreign.columns,
      constraint: foreign.conname,
    });
  }
  return facts;
}

type Extractor = (
  body: Json,
  facts: StatementFacts,
  collector: Collector,
  managedSchema: string,
) => true | undefined;

/** Table-level and column-level constraints of a CREATE TABLE, with the columns they cover. */
function tableConstraints(
  tableElts: unknown,
): { constraint: Json; column?: string }[] {
  const out: { constraint: Json; column?: string }[] = [];
  for (const element of Array.isArray(tableElts) ? tableElts : []) {
    if (!isObject(element)) {
      continue;
    }
    if (isObject(element.Constraint)) {
      out.push({ constraint: element.Constraint });
    }
    const column = element.ColumnDef;
    if (isObject(column)) {
      for (const item of Array.isArray(column.constraints)
        ? column.constraints
        : []) {
        if (isObject(item) && isObject(item.Constraint)) {
          out.push({
            constraint: item.Constraint,
            column: str(column.colname) ?? "?",
          });
        }
      }
    }
  }
  return out;
}

const constraintWords: Record<string, string> = {
  CONSTR_CHECK: "check",
  CONSTR_UNIQUE: "unique",
  CONSTR_FOREIGN: "foreign key",
  CONSTR_EXCLUSION: "exclusion",
  CONSTR_PRIMARY: "primary key",
  CONSTR_NOTNULL: "not null",
};

/**
 * Records what a table constraint provides. Unnamed primary keys and NOT
 * NULL constraints get PostgreSQL's generated names; every other constraint
 * must be named, because generated names can depend on what exists first.
 */
function addTableConstraint(
  table: string,
  constraint: Json,
  column: string | undefined,
  facts: StatementFacts,
): void {
  const contype = str(constraint.contype) ?? "";
  const word = constraintWords[contype];
  if (word === undefined) {
    return;
  }
  const keys = column === undefined ? strings(constraint.keys) : [column];
  let name = str(constraint.conname);
  if (name === undefined) {
    if (contype === "CONSTR_PRIMARY") {
      name = generatedName(table, undefined, "pkey");
      facts.generatedConstraintNames.push({
        name,
        what: `the primary key of table ${table}`,
      });
    } else if (contype === "CONSTR_NOTNULL") {
      const target = keys[0] ?? "?";
      name = generatedName(table, target, "not_null");
      facts.generatedConstraintNames.push({
        name,
        what: `the NOT NULL constraint on ${table}.${target}`,
      });
    } else {
      facts.problems.push({
        rule: "unnamed-constraint",
        message: `The ${word} constraint on ${column === undefined ? `table ${table}` : `${table}.${column}`} has no name; name it (CONSTRAINT <name> ...), because generated names can depend on load order`,
      });
      return;
    }
  } else {
    facts.constraintNames.push(name);
  }
  facts.provides.push(`con:${table}.${name}`);
  if (
    contype === "CONSTR_PRIMARY" ||
    contype === "CONSTR_UNIQUE" ||
    contype === "CONSTR_EXCLUSION"
  ) {
    // The constraint's index takes the constraint's name.
    facts.provides.push(`rel:${str(constraint.indexname) ?? name}`);
  }
  if (contype === "CONSTR_PRIMARY" || contype === "CONSTR_UNIQUE") {
    facts.provides.push(`uniq:${table}`);
    if (constraint.deferrable !== true) {
      facts.uniqueKeys.push({
        table,
        columns: [...keys].sort(),
        source: `constraint ${name}`,
        primary: contype === "CONSTR_PRIMARY",
      });
    }
  }
}

/** PostgreSQL 18 gives primary-key columns without a NOT NULL constraint a generated one. */
function primaryKeyNotNulls(
  table: string,
  constraints: readonly { constraint: Json; column?: string }[],
  facts: StatementFacts,
): void {
  const notNull = new Set<string>();
  const keyColumns: string[] = [];
  for (const { constraint, column } of constraints) {
    const columns = column === undefined ? strings(constraint.keys) : [column];
    if (constraint.contype === "CONSTR_NOTNULL") {
      for (const name of columns) {
        notNull.add(name);
      }
    } else if (constraint.contype === "CONSTR_PRIMARY") {
      keyColumns.push(...columns);
    }
  }
  for (const column of keyColumns) {
    if (!notNull.has(column)) {
      notNull.add(column);
      const name = generatedName(table, column, "not_null");
      facts.generatedConstraintNames.push({
        name,
        what: `the NOT NULL constraint on primary-key column ${table}.${column}`,
      });
      facts.provides.push(`con:${table}.${name}`);
    }
  }
}

function identitySequences(
  table: string,
  tableElts: unknown,
  facts: StatementFacts,
): void {
  for (const element of Array.isArray(tableElts) ? tableElts : []) {
    const column = isObject(element) ? element.ColumnDef : undefined;
    if (!isObject(column)) {
      continue;
    }
    for (const item of Array.isArray(column.constraints)
      ? column.constraints
      : []) {
      const constraint = isObject(item) ? item.Constraint : undefined;
      if (!isObject(constraint) || constraint.contype !== "CONSTR_IDENTITY") {
        continue;
      }
      const options = Array.isArray(constraint.options)
        ? constraint.options
        : [];
      const named = options
        .map((option) => (isObject(option) ? option.DefElem : undefined))
        .filter(isObject)
        .find((option) => option.defname === "sequence_name");
      const explicit = isObject(named?.arg)
        ? strings((named.arg.List as Json | undefined)?.items).at(-1)
        : undefined;
      facts.provides.push(
        `rel:${explicit ?? generatedName(table, str(column.colname) ?? "?", "seq")}`,
      );
    }
  }
}

const extractors: Record<string, Extractor> = {
  CreateExtensionStmt(body, facts) {
    facts.kind = "extension";
    facts.identity = `extension ${str(body.extname) ?? "?"}`;
    facts.provides.push(`ext:${str(body.extname) ?? "?"}`);
    return true;
  },

  CreateStmt(body, facts, collector) {
    const table = relName(body.relation);
    facts.kind = "table";
    facts.identity = `table ${table}`;
    facts.provides.push(`rel:${table}`, `type:${table}`);
    const elements = Array.isArray(body.tableElts) ? body.tableElts : [];
    if (
      elements.some(
        (element) => isObject(element) && "TableLikeClause" in element,
      )
    ) {
      facts.problems.push({
        rule: "table-like",
        message: `CREATE TABLE ${table} (LIKE ...) copies whatever the other table has when it runs, so the result depends on load order; write the columns out`,
      });
    }
    const constraints = tableConstraints(body.tableElts);
    for (const { constraint, column } of constraints) {
      addTableConstraint(table, constraint, column, facts);
    }
    primaryKeyNotNulls(table, constraints, facts);
    identitySequences(table, body.tableElts, facts);
    collector.walk(body.tableElts);
    collector.walk(body.inhRelations);
    collector.walk(body.ofTypename);
    return true;
  },

  ViewStmt(body, facts, collector) {
    return viewFacts("view", relName(body.view), body, facts, collector);
  },

  CreateTableAsStmt(body, facts, collector) {
    if (body.objtype !== "OBJECT_MATVIEW") {
      return undefined;
    }
    return viewFacts(
      "materialized view",
      relName((body.into as Json | undefined)?.rel),
      body,
      facts,
      collector,
    );
  },

  CompositeTypeStmt(body, facts, collector) {
    const name = relName(body.typevar);
    facts.kind = "type";
    facts.identity = `type ${name}`;
    facts.provides.push(`type:${name}`, `rel:${name}`);
    collector.walk(body.coldeflist);
    return true;
  },

  CreateDomainStmt(body, facts, collector) {
    const name = unqualified(strings(body.domainname));
    facts.kind = "domain";
    facts.identity = `domain ${name}`;
    facts.provides.push(`type:${name}`);
    for (const item of Array.isArray(body.constraints)
      ? body.constraints
      : []) {
      const constraint = isObject(item) ? item.Constraint : undefined;
      if (!isObject(constraint)) {
        continue;
      }
      const conname = str(constraint.conname);
      if (conname !== undefined) {
        facts.provides.push(`domcon:${name}.${conname}`);
      } else if (constraint.contype === "CONSTR_NOTNULL") {
        facts.provides.push(
          `domcon:${name}.${generatedName(name, undefined, "not_null")}`,
        );
      } else if (constraint.contype === "CONSTR_CHECK") {
        facts.problems.push({
          rule: "unnamed-constraint",
          message: `The check constraint on domain ${name} has no name; name it (CONSTRAINT <name> CHECK ...), because generated names can depend on load order`,
        });
      }
    }
    collector.walk(body.typeName);
    collector.walk(body.constraints);
    return true;
  },

  CreateFunctionStmt(body, facts, collector) {
    const names = strings(body.funcname);
    const name = unqualified(names);
    const args = functionArgumentTypes(body.parameters);
    facts.kind = body.is_procedure === true ? "procedure" : "function";
    facts.identity = `${facts.kind} ${name}(${args.join(",")})`;
    facts.routine = { name, arguments: args };
    facts.provides.push(`func:${name}`);
    collector.walk(body.parameters);
    collector.walk(body.returnType);
    const options = (Array.isArray(body.options) ? body.options : [])
      .map((option) => (isObject(option) ? option.DefElem : undefined))
      .filter(isObject);
    const languageArg = options.find(
      (option) => option.defname === "language",
    )?.arg;
    const language =
      (isObject(languageArg)
        ? str((languageArg.String as Json | undefined)?.sval)
        : undefined) ?? (body.sql_body === undefined ? undefined : "sql");
    if (language !== undefined) {
      facts.waitsFor.push(`ext:${language}`);
    }
    if (body.sql_body !== undefined) {
      // BEGIN ATOMIC and RETURN bodies are parsed and bound at CREATE.
      collector.walk(body.sql_body);
    } else if (language === "sql") {
      // A string body is validated at CREATE (check_function_bodies = on).
      const asArg = options.find((option) => option.defname === "as")?.arg;
      const source = isObject(asArg)
        ? strings((asArg.List as Json | undefined)?.items)[0]
        : undefined;
      if (source !== undefined && source.trim() !== "") {
        try {
          collector.walk((parseSync(source) as { stmts?: unknown }).stmts);
        } catch (error) {
          const details = (error as { sqlDetails?: { message?: string } })
            .sqlDetails;
          facts.problems.push({
            rule: "syntax-error",
            message: `Syntax error in the body of ${facts.identity}: ${details?.message ?? String(error)}`,
          });
        }
      }
    }
    // Other languages (PL/pgSQL) resolve names when they run: no ordering needed.
    dropCteReferences(collector);
    return true;
  },

  IndexStmt(body, facts, collector) {
    const table = relName(body.relation);
    const name = str(body.idxname);
    facts.kind = "index";
    facts.identity = `index ${name ?? `on ${table}`}`;
    if (name === undefined) {
      facts.problems.push({
        rule: "unnamed-index",
        message: `The index on ${table} has no name; name it (CREATE INDEX <name> ON ...), because generated names can depend on load order`,
      });
    } else {
      facts.provides.push(`rel:${name}`);
    }
    if (body.unique === true) {
      facts.provides.push(`uniq:${table}`);
      const params = (Array.isArray(body.indexParams) ? body.indexParams : [])
        .map((param) => (isObject(param) ? param.IndexElem : undefined))
        .filter(isObject);
      const columns = params.map((param) => str(param.name));
      if (
        body.whereClause === undefined &&
        columns.every((c) => c !== undefined)
      ) {
        facts.uniqueKeys.push({
          table,
          columns: (columns as string[]).sort(),
          source: `index ${name ?? "(unnamed)"}`,
          primary: false,
        });
      }
    }
    collector.walk(body.relation);
    collector.walk(body.indexParams);
    collector.walk(body.indexIncludingParams);
    collector.walk(body.whereClause);
    return true;
  },

  CreateTrigStmt(body, facts, collector) {
    const table = relName(body.relation);
    const name = str(body.trigname) ?? "?";
    facts.kind = "trigger";
    facts.identity = `trigger ${name} on ${table}`;
    facts.provides.push(`trigger:${table}.${name}`);
    collector.walk(body.relation);
    collector.function(strings(body.funcname));
    collector.walk(body.whenClause);
    collector.walk(body.constrrel);
    return true;
  },

  CreatePolicyStmt(body, facts, collector) {
    const table = relName(body.table);
    const name = str(body.policy_name) ?? "?";
    facts.kind = "policy";
    facts.identity = `policy ${name} on ${table}`;
    facts.provides.push(`policy:${table}.${name}`);
    collector.walk(body.table);
    collector.walk(body.qual);
    collector.walk(body.with_check);
    dropCteReferences(collector);
    return true;
  },

  AlterTableStmt(body, facts, collector) {
    const table = relName(body.relation);
    const commands = (Array.isArray(body.cmds) ? body.cmds : [])
      .map((command) => (isObject(command) ? command.AlterTableCmd : undefined))
      .filter(isObject);
    collector.walk(body.relation);
    const rowSecurity = new Set([
      "AT_EnableRowSecurity",
      "AT_ForceRowSecurity",
    ]);
    if (
      commands.length > 0 &&
      commands.every((command) => rowSecurity.has(str(command.subtype) ?? ""))
    ) {
      facts.kind = "row level security";
      const what = commands
        .map((command) =>
          command.subtype === "AT_EnableRowSecurity" ? "enable" : "force",
        )
        .join(", ");
      facts.identity = `row level security ${what} on ${table}`;
      return true;
    }
    const [command] = commands;
    const definition = isObject(command?.def)
      ? command.def.Constraint
      : undefined;
    if (
      commands.length !== 1 ||
      command?.subtype !== "AT_AddConstraint" ||
      !isObject(definition)
    ) {
      return undefined;
    }
    facts.kind = "constraint";
    facts.identity = `constraint ${str(definition.conname) ?? "(unnamed)"} on ${table}`;
    addTableConstraint(table, definition, undefined, facts);
    collector.walk(command.def);
    return true;
  },

  GrantStmt(body, facts, collector) {
    facts.kind = body.is_grant === true ? "grant" : "revoke";
    const objtype = str(body.objtype) ?? "";
    const targets: string[] = [];
    for (const object of Array.isArray(body.objects) ? body.objects : []) {
      if (!isObject(object)) {
        continue;
      }
      if (isObject(object.RangeVar)) {
        collector.relation(object.RangeVar);
        targets.push(relName(object.RangeVar));
      } else if (isObject(object.ObjectWithArgs)) {
        const routine = objectWithArgs(object.ObjectWithArgs);
        collector.function(routine.names);
        collector.walk(object.ObjectWithArgs.objargs);
        targets.push(routine.text);
      } else if (isObject(object.List)) {
        const names = strings(object.List.items);
        if (objtype === "OBJECT_TYPE" || objtype === "OBJECT_DOMAIN") {
          collector.add("type", names, "type");
        }
        targets.push(names.join("."));
      } else {
        targets.push(strings([object]).join("."));
      }
    }
    const privileges = (Array.isArray(body.privileges) ? body.privileges : [])
      .map((privilege) =>
        isObject(privilege) ? privilege.AccessPriv : undefined,
      )
      .filter(isObject)
      .map((privilege) => {
        const columns = strings(privilege.cols);
        return `${str(privilege.priv_name) ?? "all"}${columns.length ? ` (${columns.join(", ")})` : ""}`;
      });
    const grantees = (Array.isArray(body.grantees) ? body.grantees : [])
      .map((grantee) => (isObject(grantee) ? grantee.RoleSpec : undefined))
      .filter(isObject)
      .map(
        (role) =>
          str(role.rolename) ??
          (role.roletype === "ROLESPEC_PUBLIC"
            ? "public"
            : String(role.roletype)),
      );
    const all =
      body.targtype === "ACL_TARGET_ALL_IN_SCHEMA" ? "all in schema " : "";
    facts.identity = `${facts.kind} ${privileges.length ? privileges.join(", ") : "all"} on ${all}${objtype.replace("OBJECT_", "").toLowerCase()} ${targets.join(", ")} ${body.is_grant === true ? "to" : "from"} ${grantees.join(", ")}`;
    return true;
  },

  CommentStmt(body, facts, collector) {
    facts.kind = "comment";
    const objtype = str(body.objtype) ?? "";
    const object = body.object;
    const list =
      isObject(object) && isObject(object.List) ? object.List.items : undefined;
    const names = strings(list);
    let target = names.join(".");
    switch (objtype) {
      case "OBJECT_TABLE":
      case "OBJECT_VIEW":
      case "OBJECT_MATVIEW":
      case "OBJECT_INDEX":
      case "OBJECT_SEQUENCE":
        collector.add("relation", names, "rel");
        break;
      case "OBJECT_COLUMN":
        collector.add("relation", names.slice(0, -1), "rel");
        break;
      case "OBJECT_TABCONSTRAINT":
      case "OBJECT_TRIGGER":
      case "OBJECT_POLICY": {
        const table = names.slice(0, -1);
        const name = names.at(-1) ?? "?";
        collector.add("relation", table, "rel");
        const kind =
          objtype === "OBJECT_TABCONSTRAINT"
            ? "constraint"
            : objtype === "OBJECT_TRIGGER"
              ? "trigger"
              : "policy";
        const prefix = kind === "constraint" ? "con" : kind;
        const found = table.at(-1);
        if (found !== undefined) {
          collector.references.push({
            kind,
            key: `${prefix}:${found}.${name}`,
            name: `${name} on ${table.join(".")}`,
            managedOnly: false,
          });
        }
        target = `${name} on ${table.join(".")}`;
        break;
      }
      case "OBJECT_DOMCONSTRAINT": {
        const items = Array.isArray(list) ? list : [];
        const domain = isObject(items[0])
          ? strings((items[0].TypeName as Json | undefined)?.names)
          : [];
        const name = strings(items.slice(1)).at(-1) ?? "?";
        collector.add("type", domain, "type");
        const found = domain.at(-1);
        if (found !== undefined) {
          collector.references.push({
            kind: "constraint",
            key: `domcon:${found}.${name}`,
            name: `${name} on domain ${domain.join(".")}`,
            managedOnly: false,
          });
        }
        target = `${name} on domain ${domain.join(".")}`;
        break;
      }
      case "OBJECT_FUNCTION":
      case "OBJECT_PROCEDURE":
      case "OBJECT_ROUTINE": {
        const routine = objectWithArgs(
          isObject(object) ? object.ObjectWithArgs : undefined,
        );
        collector.function(routine.names);
        collector.walk(
          isObject(object)
            ? (object.ObjectWithArgs as Json | undefined)?.objargs
            : undefined,
        );
        target = routine.text;
        break;
      }
      case "OBJECT_TYPE":
      case "OBJECT_DOMAIN": {
        const typeName = isObject(object) ? object.TypeName : undefined;
        collector.walk(typeName);
        target = typeText(typeName);
        break;
      }
      case "OBJECT_EXTENSION":
      case "OBJECT_SCHEMA":
        target = isObject(object) ? (strings([object])[0] ?? "?") : "?";
        break;
      default:
        return undefined;
    }
    facts.identity = `comment on ${objtype.replace("OBJECT_", "").toLowerCase()} ${target}`;
    return true;
  },
};

/** A view or materialized view: provides its relation and row type; references what its query does. */
function viewFacts(
  kind: "view" | "materialized view",
  view: string,
  body: Json,
  facts: StatementFacts,
  collector: Collector,
): true {
  facts.kind = kind;
  facts.identity = `${kind} ${view}`;
  facts.provides.push(`rel:${view}`, `type:${view}`);
  collector.walk(body.query);
  dropCteReferences(collector);
  return true;
}

/** Unqualified relation names that match a CTE in the statement refer to the CTE. */
function dropCteReferences(collector: Collector): void {
  const kept = collector.references.filter(
    (reference) =>
      !(
        reference.kind === "relation" &&
        !reference.managedOnly &&
        !reference.name.includes(".") &&
        collector.ctes.has(reference.name)
      ),
  );
  collector.references.splice(0, collector.references.length, ...kept);
}
