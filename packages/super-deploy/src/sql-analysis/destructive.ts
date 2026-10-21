// Destructive statements and lock warnings in deploy-time SQL (spec
// "Destructive changes and warnings"). Database-free, like every rule: it
// sees only the migration's own statements and the column types of the
// desired schema before it.
//
// Destructive (finalize needs an acknowledgement): DROP statements, dropped
// columns and constraints, column type changes that can lose data, DELETE
// (including MERGE ... DELETE) and TRUNCATE. Not destructive:
// - anything done to an object this migration created earlier, including
//   temporary tables (no structure or data from before the migration is lost);
// - dropping an object that holds no data and creating it again later in the
//   same migration, as pg-delta does to change a view, index, function,
//   trigger, type or constraint (a table or column dropped and created
//   again has lost its rows, so that stays destructive). CASCADE always is.
//
// A narrowing type change (`narrowingOf`) is destructive too, and its reason
// says that values which don't fit are cut or rounded with no error: the
// generated `USING col::newtype` is an explicit cast (QA 09).
//
// Warnings: statements that rewrite or fully scan an existing table while
// holding its lock until the deployment commits. Tables created in the same
// migration are exempt. Calling a volatile function is never a warning by
// itself; only a volatile default on a new column is (it rewrites the table).
import type {
  AlterTableCmd,
  ColumnDef,
  Constraint,
  CreateFunctionStmt,
  DropStmt,
  FunctionParameter,
  Node,
  ObjectWithArgs,
  RangeVar,
  TypeCast,
  TypeName,
} from "@pgsql/types";
import type { ParsedStatement } from "./parse.ts";
import {
  pgCatalogFunctions,
  pgCatalogVolatileFunctions,
} from "./pg-catalog-names.ts";
import { objectTypeName } from "./statement-names.ts";
import {
  alterTableCommands,
  type Json,
  statementBody,
  stringList,
  unwrap,
  walkNodes,
} from "./syntax-tree.ts";

export type DestructiveKind =
  /** DROP ..., ALTER TABLE ... DROP CONSTRAINT, ALTER DOMAIN ... DROP CONSTRAINT. */
  | "drop"
  /** ALTER TABLE ... DROP COLUMN, ALTER TYPE ... DROP ATTRIBUTE. */
  | "drop-column"
  /** ALTER COLUMN ... TYPE that is not a known widening of the current type. */
  | "lossy-type-change"
  /** DELETE, or MERGE with a DELETE action. */
  | "delete"
  | "truncate";

/** A statement that drops structure or deletes data; finalize needs it acknowledged. */
export interface DestructiveStatement {
  /** Project-relative path with forward slashes. */
  readonly file: string;
  /** 1-based line where the statement starts. */
  readonly line: number;
  readonly statement: string;
  readonly kind: DestructiveKind;
  /** One line for people: what is lost. */
  readonly message: string;
}

export type LockWarningKind =
  /** ALTER COLUMN ... TYPE: rewrites the table and its indexes. */
  | "type-change"
  /** ADD COLUMN with a volatile default: rewrites the table. */
  | "volatile-default"
  /** ADD COLUMN ... AS IDENTITY or GENERATED ... STORED, SET EXPRESSION: rewrites the table. */
  | "computed-column"
  /** SET NOT NULL: scans the table. */
  | "set-not-null"
  /** Adding or validating a constraint: scans the table (or builds an index). */
  | "constraint-validation"
  /** CREATE INDEX: scans the table, blocking writes. */
  | "create-index"
  | "truncate";

/**
 * A statement that rewrites or fully scans a table that existed before the
 * migration, holding its lock until the deployment commits.
 */
export interface LockWarning {
  /** Project-relative path with forward slashes. */
  readonly file: string;
  /** 1-based line where the statement starts. */
  readonly line: number;
  readonly statement: string;
  readonly kind: LockWarningKind;
  /** The table (for ALTER DOMAIN, the domain) whose rows are rewritten or scanned. */
  readonly object: string;
  /** One line for people: what happens and which lock is held. */
  readonly message: string;
}

/** Column types by table (or composite type) and column name, unqualified. */
export type ColumnTypes = ReadonlyMap<string, ReadonlyMap<string, TypeName>>;

/** Column types defined by CREATE TABLE and CREATE TYPE ... AS statements, e.g. a desired schema. */
export function columnTypesOf(
  statements: readonly ParsedStatement[],
): ColumnTypes {
  const tracker = new ChangeTracker("");
  for (const statement of statements) {
    tracker.remember(statement);
  }
  return tracker.columns;
}

interface Drop {
  readonly found: DestructiveStatement;
  readonly key: string;
  /** Holds no data, so creating it again later in the migration loses nothing. */
  readonly recreatable: boolean;
  /** Created again, or part of a table the migration drops later. */
  covered: boolean;
}

/** Objects that hold no data: dropping and creating them again is not destructive. */
const recreatableKinds = new Set([
  "view",
  "matview",
  "index",
  "function",
  "trigger",
  "type",
  "constraint",
  "domain-constraint",
]);

/**
 * Follows one migration's statements in the order they run and collects
 * what is destructive. Statements are given with `statement`, after the
 * rules have looked at them.
 */
export class ChangeTracker {
  readonly columns = new Map<string, Map<string, TypeName>>();
  readonly #managedSchema: string;
  /** Keys of the objects this migration has created so far. */
  readonly #created = new Set<string>();
  readonly #found: Drop[] = [];
  /** Lock warnings so far, in the order the statements run. */
  readonly warnings: LockWarning[] = [];

  constructor(managedSchema: string, columnTypes?: ColumnTypes) {
    this.#managedSchema = managedSchema;
    for (const [table, columns] of columnTypes ?? []) {
      this.columns.set(table, new Map(columns));
    }
  }

  /** Destructive statements so far, in the order they run. */
  get destructive(): DestructiveStatement[] {
    return this.#found.flatMap((drop) => (drop.covered ? [] : [drop.found]));
  }

  statement(statement: ParsedStatement): void {
    for (const drop of this.#destructiveIn(statement)) {
      if (this.#createdHere(drop.key)) {
        continue;
      }
      if (drop.found.kind === "drop" && drop.key.startsWith("table:")) {
        // Its columns, constraints and triggers go with it.
        const table = drop.key.slice("table:".length);
        for (const earlier of this.#found) {
          if (tableOf(earlier.key) === table) {
            earlier.covered = true;
          }
        }
      }
      this.#found.push(drop);
    }
    this.warnings.push(...this.#warningsIn(statement));
    this.remember(statement);
  }

  /** Updates what the migration has created and the column types after a statement. */
  remember(statement: ParsedStatement): void {
    const body = statementBody(statement);
    for (const key of createdKeys(statement, body)) {
      this.#created.add(key);
      for (const drop of this.#found) {
        if (drop.key === key && drop.recreatable) {
          drop.covered = true;
        }
      }
    }
    this.#rememberColumns(statement, body);
  }

  #createdHere(key: string): boolean {
    const table = tableOf(key);
    return (
      this.#created.has(key) ||
      (table !== undefined && this.#created.has(`table:${table}`))
    );
  }

  #destructiveIn(statement: ParsedStatement): Drop[] {
    const body = statementBody(statement);
    const drops: Drop[] = [];
    const add = (
      kind: DestructiveKind,
      key: string,
      message: string,
      cascade: boolean,
    ) => {
      const objectKind = key.slice(0, key.indexOf(":"));
      drops.push({
        found: {
          file: statement.file,
          line: statement.line,
          statement: statement.text,
          kind,
          message: cascade
            ? `${message}, and CASCADE also drops everything that depends on it, including table columns`
            : message,
        },
        key,
        recreatable: !cascade && recreatableKinds.has(objectKind),
        covered: false,
      });
    };
    if (statement.nodeType === "DropStmt") {
      const drop = body as DropStmt;
      const cascade = drop.behavior === "DROP_CASCADE";
      const type = drop.removeType ?? "";
      const what = objectTypeName(type);
      for (const object of drop.objects ?? []) {
        const name = droppedName(type, object);
        const key = `${objectKey(type)}:${name.key}`;
        const loses =
          type === "OBJECT_TABLE"
            ? "the table and every row in it"
            : type === "OBJECT_SEQUENCE"
              ? "the sequence and its current value"
              : `the ${what}`;
        add(
          "drop",
          key,
          `DROP ${what.toUpperCase()} ${name.display} drops ${loses}`,
          cascade,
        );
      }
    }
    if (statement.nodeType === "AlterTableStmt") {
      const relation = body.relation as RangeVar | undefined;
      const table = this.#relationName(relation);
      const isType = body.objtype === "OBJECT_TYPE";
      for (const cmd of alterTableCommands(body)) {
        const cascade = cmd.behavior === "DROP_CASCADE";
        if (table !== undefined && cmd.subtype === "AT_DropColumn") {
          add(
            "drop-column",
            `column:${table}.${cmd.name ?? ""}`,
            isType
              ? `ALTER TYPE ${display(relation)} DROP ATTRIBUTE ${cmd.name ?? ""} drops the attribute and its values in every column of that type`
              : `ALTER TABLE ${display(relation)} DROP COLUMN ${cmd.name ?? ""} drops the column and its data`,
            cascade,
          );
        }
        if (table !== undefined && cmd.subtype === "AT_AlterColumnType") {
          const column = cmd.name ?? "";
          const target = unwrap(cmd.def, "ColumnDef") as ColumnDef | undefined;
          const reason = this.#typeChangeLoss(
            table,
            column,
            cmd,
            `ALTER ${isType ? "TYPE" : "TABLE"} ${display(relation)} ALTER ${isType ? "ATTRIBUTE" : "COLUMN"} ${column} TYPE ${target?.typeName === undefined ? "" : typeDisplay(target.typeName)}`,
          );
          if (reason !== undefined) {
            add(
              "lossy-type-change",
              `column:${table}.${column}`,
              reason,
              false,
            );
          }
        }
        if (table !== undefined && cmd.subtype === "AT_DropConstraint") {
          add(
            "drop",
            `constraint:${table}.${cmd.name ?? ""}`,
            `ALTER TABLE ${display(relation)} DROP CONSTRAINT ${cmd.name ?? ""} drops the constraint`,
            cascade,
          );
        }
      }
    }
    const deleting = (relation: RangeVar | undefined, message: string) => {
      const table = this.#relationName(relation);
      if (table !== undefined) {
        add(
          statement.nodeType === "TruncateStmt" ? "truncate" : "delete",
          `table:${table}`,
          message,
          false,
        );
      }
    };
    if (statement.nodeType === "DeleteStmt") {
      const relation = body.relation as RangeVar | undefined;
      deleting(relation, `DELETE FROM ${display(relation)} deletes rows`);
    }
    if (statement.nodeType === "TruncateStmt") {
      for (const item of (body.relations as Node[] | undefined) ?? []) {
        const relation = unwrap(item, "RangeVar") as RangeVar | undefined;
        deleting(
          relation,
          `TRUNCATE ${display(relation)} deletes every row in ${display(relation)}`,
        );
      }
    }
    if (
      statement.nodeType === "MergeStmt" &&
      ((body.mergeWhenClauses as Node[] | undefined) ?? []).some(
        (item) =>
          (unwrap(item, "MergeWhenClause") as { commandType?: string })
            ?.commandType === "CMD_DELETE",
      )
    ) {
      const relation = body.relation as RangeVar | undefined;
      deleting(
        relation,
        `MERGE INTO ${display(relation)} ... DELETE deletes rows`,
      );
    }
    if (statement.nodeType === "AlterDomainStmt" && body.subtype === "X") {
      const domain = stringList(body.typeName);
      add(
        "drop",
        `domain-constraint:${domain.at(-1) ?? ""}.${String(body.name ?? "")}`,
        `ALTER DOMAIN ${domain.join(".")} DROP CONSTRAINT ${String(body.name ?? "")} drops the constraint`,
        body.behavior === "DROP_CASCADE",
      );
    }
    return drops;
  }

  #warningsIn(statement: ParsedStatement): LockWarning[] {
    const body = statementBody(statement);
    const warnings: LockWarning[] = [];
    const warn = (
      kind: LockWarningKind,
      object: string,
      what: string,
      lock: Lock,
    ) =>
      warnings.push({
        file: statement.file,
        line: statement.line,
        statement: statement.text,
        kind,
        object,
        message: `${what}, ${lockEffects[lock]} until the deployment commits`,
      });
    const existing = (relation: RangeVar | undefined) => {
      const table = this.#relationName(relation);
      return table === undefined ||
        this.#created.has(`table:${table}`) ||
        this.#created.has(`matview:${table}`)
        ? undefined
        : table;
    };

    if (
      statement.nodeType === "AlterTableStmt" &&
      body.objtype === "OBJECT_TABLE"
    ) {
      const relation = body.relation as RangeVar | undefined;
      const table = existing(relation);
      const prefix = `ALTER TABLE ${display(relation)}`;
      for (const cmd of table === undefined ? [] : alterTableCommands(body)) {
        const { column, constraint } = commandDefinition(cmd);
        const name = cmd.name ?? column?.colname ?? "";
        switch (cmd.subtype) {
          case "AT_AlterColumnType":
            warn(
              "type-change",
              table as string,
              `${prefix} ALTER COLUMN ${name} TYPE ${column?.typeName === undefined ? "" : typeDisplay(column.typeName)} can rewrite ${table} and rebuild its indexes`,
              "access-exclusive",
            );
            break;
          case "AT_SetExpression":
            warn(
              "computed-column",
              table as string,
              `${prefix} ALTER COLUMN ${name} SET EXPRESSION rewrites ${table}`,
              "access-exclusive",
            );
            break;
          case "AT_SetNotNull":
            warn(
              "set-not-null",
              table as string,
              `${prefix} ALTER COLUMN ${name} SET NOT NULL scans every row of ${table}`,
              "access-exclusive",
            );
            break;
          case "AT_ValidateConstraint":
            warn(
              "constraint-validation",
              table as string,
              `${prefix} VALIDATE CONSTRAINT ${name} checks every row of ${table}`,
              "share-update-exclusive",
            );
            break;
          case "AT_AddConstraint":
            if (
              constraint !== undefined &&
              constraint.skip_validation !== true
            ) {
              const [what, lock] = constraintCheck(constraint, table as string);
              warn(
                "constraint-validation",
                table as string,
                `${prefix} ADD CONSTRAINT ${constraint.conname ?? ""} ${what}`,
                lock,
              );
            }
            break;
          case "AT_AddColumn":
            for (const [kind, what] of newColumnWork(column, table as string)) {
              warn(
                kind,
                table as string,
                `${prefix} ADD COLUMN ${name} ${what}`,
                "access-exclusive",
              );
            }
            break;
        }
      }
    }
    if (statement.nodeType === "IndexStmt") {
      const relation = body.relation as RangeVar | undefined;
      const table = existing(relation);
      if (table !== undefined) {
        warn(
          "create-index",
          table,
          `CREATE INDEX ${String(body.idxname ?? "")} reads every row of ${table}`,
          "share",
        );
      }
    }
    if (statement.nodeType === "TruncateStmt") {
      for (const item of (body.relations as Node[] | undefined) ?? []) {
        const relation = unwrap(item, "RangeVar") as RangeVar | undefined;
        const table = existing(relation);
        if (table !== undefined) {
          warn(
            "truncate",
            table,
            `TRUNCATE ${display(relation)} empties ${table}`,
            "access-exclusive",
          );
        }
      }
    }
    if (statement.nodeType === "AlterDomainStmt") {
      const names = stringList(body.typeName);
      const domain = names.at(-1) ?? "";
      const constraint = unwrap(body.def, "Constraint") as
        | Constraint
        | undefined;
      const scans =
        (body.subtype === "C" && constraint?.skip_validation !== true) ||
        body.subtype === "O" ||
        body.subtype === "V";
      if (scans && !this.#created.has(`type:${domain}`)) {
        warn(
          "constraint-validation",
          domain,
          `ALTER DOMAIN ${names.join(".")} ${body.subtype === "O" ? "SET NOT NULL" : body.subtype === "V" ? `VALIDATE CONSTRAINT ${String(body.name ?? "")}` : `ADD CONSTRAINT ${constraint?.conname ?? ""}`} checks every row of every table with a column of that domain`,
          "share",
        );
      }
    }
    return warnings;
  }

  /**
   * Why changing the column's type can lose data, or undefined for a
   * widening. A narrowing says what happens to the values that don't fit;
   * any other loss is `statement` (the change, as it reads) and its cause.
   */
  #typeChangeLoss(
    table: string,
    column: string,
    cmd: AlterTableCmd,
    statement: string,
  ): string | undefined {
    const target = unwrap(cmd.def, "ColumnDef") as ColumnDef | undefined;
    const current = this.columns.get(table)?.get(column);
    if (target?.typeName === undefined) {
      return undefined;
    }
    if (current === undefined) {
      return `${statement} can lose data: super-deploy cannot tell the column's current type`;
    }
    if (!keepsValues(target.raw_default, column)) {
      return `${statement} can lose data: the USING expression computes new values`;
    }
    if (widens(current, target.typeName)) {
      return undefined;
    }
    const narrowing = narrowingOf(current, column, cmd);
    return narrowing === undefined
      ? `${statement} can lose data: not every ${typeDisplay(current)} value fits ${typeDisplay(target.typeName)} unchanged`
      : narrowingReason(`${table}.${column}`, narrowing);
  }

  #relationName(relation: RangeVar | undefined): string | undefined {
    if (
      relation?.relname === undefined ||
      (relation.schemaname !== undefined &&
        relation.schemaname !== this.#managedSchema &&
        relation.schemaname !== "pg_temp")
    ) {
      return undefined;
    }
    return relation.relname;
  }

  #rememberColumns(statement: ParsedStatement, body: Json): void {
    const define = (relation: RangeVar | undefined, elements: unknown) => {
      const table = this.#relationName(relation);
      if (table === undefined) {
        return;
      }
      const columns = new Map<string, TypeName>();
      for (const element of Array.isArray(elements) ? elements : []) {
        const column = unwrap(element, "ColumnDef") as ColumnDef | undefined;
        if (column?.colname !== undefined && column.typeName !== undefined) {
          columns.set(column.colname, column.typeName);
        }
      }
      this.columns.set(table, columns);
    };
    if (statement.nodeType === "CreateStmt") {
      define(body.relation as RangeVar | undefined, body.tableElts);
    }
    if (statement.nodeType === "AlterTableStmt") {
      const table = this.#relationName(body.relation as RangeVar | undefined);
      const columns = table === undefined ? undefined : this.columns.get(table);
      for (const cmd of alterTableCommands(body)) {
        const column = unwrap(cmd.def, "ColumnDef") as ColumnDef | undefined;
        if (cmd.subtype === "AT_AddColumn" && column?.colname !== undefined) {
          if (column.typeName !== undefined) {
            columns?.set(column.colname, column.typeName);
          }
        } else if (
          cmd.subtype === "AT_AlterColumnType" &&
          column?.typeName !== undefined
        ) {
          columns?.set(cmd.name ?? "", column.typeName);
        } else if (cmd.subtype === "AT_DropColumn") {
          columns?.delete(cmd.name ?? "");
        }
      }
    }
    if (statement.nodeType === "RenameStmt") {
      const table = this.#relationName(body.relation as RangeVar | undefined);
      const columns = table === undefined ? undefined : this.columns.get(table);
      const renamed = String(body.newname ?? "");
      if (
        body.renameType === "OBJECT_COLUMN" ||
        body.renameType === "OBJECT_ATTRIBUTE"
      ) {
        const type = columns?.get(String(body.subname ?? ""));
        columns?.delete(String(body.subname ?? ""));
        if (type !== undefined) {
          columns?.set(renamed, type);
        }
      } else if (
        body.renameType === "OBJECT_TABLE" &&
        table !== undefined &&
        columns !== undefined
      ) {
        this.columns.delete(table);
        this.columns.set(renamed, columns);
      }
    }
    if (
      statement.nodeType === "DropStmt" &&
      (body.removeType === "OBJECT_TABLE" || body.removeType === "OBJECT_TYPE")
    ) {
      for (const object of (body.objects as unknown[] | undefined) ?? []) {
        this.columns.delete(droppedName(String(body.removeType), object).key);
      }
    }
    if (statement.nodeType === "CompositeTypeStmt") {
      define(body.typevar as RangeVar | undefined, body.coldeflist);
    }
  }
}

function createdKeys(statement: ParsedStatement, body: Json): string[] {
  const relation = (field: string) =>
    (body[field] as RangeVar | undefined)?.relname ?? "";
  switch (statement.nodeType) {
    case "CreateStmt":
      return [`table:${relation("relation")}`];
    case "CreateTableAsStmt": {
      const name =
        (body.into as { rel?: RangeVar } | undefined)?.rel?.relname ?? "";
      return [
        body.objtype === "OBJECT_MATVIEW" ? `matview:${name}` : `table:${name}`,
      ];
    }
    case "ViewStmt":
      return [`view:${relation("view")}`];
    case "IndexStmt":
      return [`index:${String(body.idxname ?? "")}`];
    case "CreateFunctionStmt": {
      const create = body as CreateFunctionStmt;
      const kind = create.is_procedure === true ? "procedure" : "function";
      return [
        `${kind}:${signature(stringList(create.funcname), inputTypes(create.parameters))}`,
      ];
    }
    case "CreateTrigStmt":
      return [`trigger:${relation("relation")}.${String(body.trigname ?? "")}`];
    case "CreateDomainStmt":
      return [`type:${stringList(body.domainname).at(-1) ?? ""}`];
    case "CompositeTypeStmt":
      return [`type:${relation("typevar")}`];
    case "AlterTableStmt": {
      const table = relation("relation");
      return alterTableCommands(body).flatMap((cmd) => {
        const { column, constraint } = commandDefinition(cmd);
        if (cmd.subtype === "AT_AddColumn" && column?.colname !== undefined) {
          return [`column:${table}.${column.colname}`];
        }
        if (
          cmd.subtype === "AT_AddConstraint" &&
          constraint?.conname !== undefined
        ) {
          return [`constraint:${table}.${constraint.conname}`];
        }
        return [];
      });
    }
    case "AlterDomainStmt": {
      const constraint = unwrap(body.def, "Constraint") as
        | Constraint
        | undefined;
      return body.subtype === "C" && constraint?.conname !== undefined
        ? [
            `domain-constraint:${stringList(body.typeName).at(-1) ?? ""}.${constraint.conname}`,
          ]
        : [];
    }
    default:
      return [];
  }
}

type Lock =
  | "access-exclusive"
  | "share-row-exclusive"
  | "share"
  | "share-update-exclusive";

const lockEffects: Record<Lock, string> = {
  "access-exclusive":
    "holding an ACCESS EXCLUSIVE lock that blocks every read and write of it",
  "share-row-exclusive": "holding a lock that blocks writes to it",
  share: "holding a SHARE lock that blocks writes to it",
  "share-update-exclusive":
    "holding a SHARE UPDATE EXCLUSIVE lock that blocks other schema changes to it",
};

/** What adding a constraint does to the table's existing rows, and the lock it takes. */
function constraintCheck(
  constraint: Constraint,
  table: string,
): [string, Lock] {
  switch (constraint.contype) {
    case "CONSTR_PRIMARY":
    case "CONSTR_UNIQUE":
    case "CONSTR_EXCLUSION":
      return [`builds an index from every row of ${table}`, "access-exclusive"];
    case "CONSTR_FOREIGN":
      return [
        `checks every row of ${table} against ${display(constraint.pktable)}`,
        "share-row-exclusive",
      ];
    default:
      return [`checks every row of ${table}`, "access-exclusive"];
  }
}

/** Rewrites and scans a new column causes on an existing table. */
function newColumnWork(
  column: ColumnDef | undefined,
  table: string,
): [LockWarningKind, string][] {
  const constraints = (column?.constraints ?? []).flatMap((item) => {
    const constraint = unwrap(item, "Constraint") as Constraint | undefined;
    return constraint === undefined ? [] : [constraint];
  });
  const work: [LockWarningKind, string][] = [];
  const hasDefault = constraints.some((c) => c.contype === "CONSTR_DEFAULT");
  for (const constraint of constraints) {
    switch (constraint.contype) {
      case "CONSTR_DEFAULT":
        if (isVolatile(constraint.raw_expr)) {
          work.push([
            "volatile-default",
            `with a volatile default rewrites ${table} to give every row its own value`,
          ]);
        }
        break;
      case "CONSTR_IDENTITY":
        work.push([
          "computed-column",
          `as an identity column rewrites ${table} to number every row`,
        ]);
        break;
      case "CONSTR_GENERATED":
        work.push([
          "computed-column",
          `as a stored generated column rewrites ${table} to compute every row`,
        ]);
        break;
      case "CONSTR_NOTNULL":
        if (!hasDefault) {
          work.push([
            "constraint-validation",
            `NOT NULL checks every row of ${table}`,
          ]);
        }
        break;
      case "CONSTR_CHECK":
      case "CONSTR_FOREIGN":
      case "CONSTR_PRIMARY":
      case "CONSTR_UNIQUE":
        work.push([
          "constraint-validation",
          `${constraintCheck(constraint, table)[0]} for its constraint`,
        ]);
        break;
    }
  }
  return work;
}

/**
 * True when the expression calls a volatile function: a volatile pg_catalog
 * built-in, or any other function (CREATE FUNCTION's default volatility).
 */
function isVolatile(expression: unknown): boolean {
  let volatile = false;
  walkNodes(expression, ({ type, node }) => {
    if (type === "FuncCall") {
      const parts = stringList(node.funcname);
      const name = parts.at(-1) ?? "";
      const builtin =
        (parts.length === 1 || parts.at(-2) === "pg_catalog") &&
        pgCatalogFunctions.has(name);
      if (!builtin || pgCatalogVolatileFunctions.has(name)) {
        volatile = true;
      }
    }
    return undefined;
  });
  return volatile;
}

/** The table a column, constraint or trigger key belongs to. */
function tableOf(key: string): string | undefined {
  return /^(?:column|constraint|trigger):([^.]*)\./.exec(key)?.[1];
}

const objectKeys: Record<string, string> = {
  OBJECT_TABLE: "table",
  OBJECT_VIEW: "view",
  OBJECT_MATVIEW: "matview",
  OBJECT_INDEX: "index",
  OBJECT_SEQUENCE: "sequence",
  OBJECT_FUNCTION: "function",
  OBJECT_PROCEDURE: "procedure",
  OBJECT_ROUTINE: "function",
  OBJECT_TRIGGER: "trigger",
  OBJECT_TYPE: "type",
  OBJECT_DOMAIN: "type",
};

function objectKey(objectType: string): string {
  return objectKeys[objectType] ?? objectType.toLowerCase();
}

/** The name a DROP statement gives one object: a key (unqualified) and how to show it. */
function droppedName(
  objectType: string,
  object: unknown,
): { key: string; display: string } {
  const routine = unwrap(object, "ObjectWithArgs") as
    | ObjectWithArgs
    | undefined;
  if (routine !== undefined) {
    const parts = stringList(routine.objname);
    const args = (routine.objargs ?? []).flatMap((arg) => {
      const type = unwrap(arg, "TypeName") as TypeName | undefined;
      return type === undefined ? [] : [type];
    });
    return {
      key: signature(parts, args),
      display: `${parts.join(".")}(${args.map(typeDisplay).join(", ")})`,
    };
  }
  const type = unwrap(object, "TypeName") as TypeName | undefined;
  const parts =
    type !== undefined ? stringList(type.names) : stringList(object);
  // Triggers are named [schema.]table.name.
  if (objectType === "OBJECT_TRIGGER") {
    const [table, name] = parts.slice(-2);
    return {
      key: `${table ?? ""}.${name ?? ""}`,
      display: `${name ?? ""} on ${parts.slice(0, -1).join(".")}`,
    };
  }
  return { key: parts.at(-1) ?? "", display: parts.join(".") };
}

/** Input argument types of a CREATE FUNCTION/PROCEDURE (what identifies it). */
function inputTypes(parameters: readonly Node[] | undefined): TypeName[] {
  return (parameters ?? []).flatMap((item) => {
    const parameter = unwrap(item, "FunctionParameter") as
      | FunctionParameter
      | undefined;
    const mode = parameter?.mode ?? "FUNC_PARAM_DEFAULT";
    return parameter?.argType === undefined ||
      mode === "FUNC_PARAM_OUT" ||
      mode === "FUNC_PARAM_TABLE"
      ? []
      : [parameter.argType];
  });
}

function signature(name: readonly string[], args: readonly TypeName[]): string {
  return `${name.at(-1) ?? ""}(${args.map(typeKey).join(",")})`;
}

/** Type names as PostgreSQL resolves them: aliases folded, pg_catalog dropped. */
const typeAliases: Record<string, string> = {
  int: "int4",
  integer: "int4",
  smallint: "int2",
  bigint: "int8",
  real: "float4",
  float: "float8",
  "double precision": "float8",
  decimal: "numeric",
  "character varying": "varchar",
  character: "bpchar",
  char: "bpchar",
  boolean: "bool",
  "bit varying": "varbit",
};

function baseTypeName(type: TypeName): string {
  const parts = stringList(type.names);
  const name = parts.at(-1) ?? "";
  const qualified = parts.length > 1 && parts.at(-2) !== "pg_catalog";
  return qualified ? parts.slice(-2).join(".") : (typeAliases[name] ?? name);
}

function typeKey(type: TypeName): string {
  return `${baseTypeName(type)}${"[]".repeat((type.arrayBounds ?? []).length)}`;
}

/** Names messages show instead of PostgreSQL's internal ones. */
const typeDisplayNames: Record<string, string> = { bpchar: "char" };

function typeDisplay(type: TypeName): string {
  const mods = typeModifiers(type);
  const name = baseTypeName(type);
  return `${typeDisplayNames[name] ?? name}${mods.length === 0 ? "" : `(${mods.join(",")})`}${"[]".repeat((type.arrayBounds ?? []).length)}`;
}

/** Integer literal type modifiers, e.g. [10, 2] for numeric(10,2). */
function typeModifiers(type: TypeName): number[] {
  return (type.typmods ?? []).map((mod) => {
    const value = (unwrap(mod, "A_Const") as { ival?: { ival?: number } })
      ?.ival;
    return value?.ival ?? 0;
  });
}

/** Decimal digits each integer type can hold. */
const integerDigits: Record<string, number> = { int2: 5, int4: 10, int8: 19 };

/** Exactly representable in a float's mantissa. */
const floatHolds: Record<string, readonly string[]> = {
  float4: ["int2"],
  float8: ["int2", "int4", "float4"],
};

const textTypes = new Set(["text", "varchar"]);
const timeTypes = new Set(["timestamp", "timestamptz", "time", "timetz"]);

/**
 * True when `command` (ALTER COLUMN ... TYPE on `column`, currently of type
 * `current`) keeps every value unchanged: a known widening with no USING
 * expression computing new values. The same judgement that keeps a type
 * change from being destructive at finalize; the draft's script coverage
 * uses it too.
 */
export function keepsEveryValue(
  current: TypeName,
  column: string,
  command: AlterTableCmd,
): boolean {
  const target = unwrap<ColumnDef>(command.def, "ColumnDef");
  return (
    target?.typeName !== undefined &&
    keepsValues(target.raw_default, column) &&
    widens(current, target.typeName)
  );
}

/**
 * True when every value of `from` converts to `to` unchanged: the known
 * widenings. Anything else (including every type super-deploy does not
 * know, such as domains) counts as lossy.
 */
function widens(from: TypeName, to: TypeName): boolean {
  if ((from.arrayBounds ?? []).length !== (to.arrayBounds ?? []).length) {
    return false;
  }
  const source = baseTypeName(from);
  const target = baseTypeName(to);
  const [length, scale = 0] = typeModifiers(from);
  const [newLength, newScale = 0] = typeModifiers(to);
  if (typeDisplay(from) === typeDisplay(to)) {
    return true;
  }
  const digits = integerDigits[source];
  if (digits !== undefined) {
    if (target === "numeric") {
      return newLength === undefined || newLength - newScale >= digits;
    }
    const newDigits = integerDigits[target];
    return (
      (newDigits !== undefined && newDigits >= digits) ||
      (floatHolds[target] ?? []).includes(source)
    );
  }
  if (source === "float4") {
    return target === "float8";
  }
  if (source === "numeric" && target === "numeric") {
    return (
      newLength === undefined ||
      (length !== undefined &&
        newScale >= scale &&
        newLength - newScale >= length - scale)
    );
  }
  if (textTypes.has(source) && textTypes.has(target)) {
    return (
      target === "text" ||
      newLength === undefined ||
      (source === "varchar" && length !== undefined && newLength >= length)
    );
  }
  if (source === target && (source === "bpchar" || source === "varbit")) {
    return (
      newLength === undefined || (length !== undefined && newLength >= length)
    );
  }
  if (source === target && timeTypes.has(source)) {
    // Without a precision these types keep microseconds (6).
    return newLength === undefined || newLength >= (length ?? 6);
  }
  return false;
}

/**
 * A type change that shortens values rather than refusing them (QA 09).
 * pg-delta generates every type change with `USING col::newtype`, an
 * explicit cast, which cuts text and bit strings to the new length and
 * rounds numerics to the new scale, with no error. That `USING` is kept on
 * purpose and warned about here instead. Without it PostgreSQL's assignment
 * cast refuses an over-long string (so that is no narrowing), but still
 * rounds.
 */
export type Narrowing = {
  /** The current and new types, as messages show them. */
  readonly from: string;
  readonly to: string;
} & (
  | {
      readonly kind: "length";
      /** Longer values are cut to this many characters or bits. */
      readonly length: number;
      readonly unit: "characters" | "bits";
    }
  | {
      readonly kind: "scale";
      /** The new type's precision: how many digits a value may have in all. */
      readonly precision: number;
      /** Values are rounded to this many decimal places. */
      readonly scale: number;
      /**
       * The new type allows fewer digits before the decimal point than the
       * old one, so a value too large for it fails the cast (numeric field
       * overflow) and with it the deployment.
       */
      readonly overflows: boolean;
    }
);

/** Types an explicit cast cuts to length, with what the length counts. */
const lengthFamilies: readonly (readonly [
  ReadonlySet<string>,
  "characters" | "bits",
])[] = [
  [new Set(["text", "varchar", "bpchar"]), "characters"],
  [new Set(["bit", "varbit"]), "bits"],
];

/**
 * How `command` (ALTER COLUMN ... TYPE on `column`, currently of type
 * `current`) narrows the column, or undefined when it is no narrowing:
 * to `varchar(n)`, `char(n)`, `bit(n)` or `varbit(n)` from a text or bit
 * type with no length or a greater one, by an explicit cast; or to
 * `numeric(p,s)` from a numeric with a greater scale (or none).
 */
export function narrowingOf(
  current: TypeName,
  column: string,
  command: AlterTableCmd,
): Narrowing | undefined {
  const definition = unwrap<ColumnDef>(command.def, "ColumnDef");
  const target = definition?.typeName;
  if (
    target === undefined ||
    (current.arrayBounds ?? []).length > 0 ||
    (target.arrayBounds ?? []).length > 0 ||
    !keepsValues(definition?.raw_default, column)
  ) {
    return undefined;
  }
  const source = baseTypeName(current);
  const destination = baseTypeName(target);
  const types = { from: typeDisplay(current), to: typeDisplay(target) };
  const [length, scale = 0] = typeModifiers(current);
  const [newLength, newScale = 0] = typeModifiers(target);
  if (source === "numeric" && destination === "numeric") {
    return newLength !== undefined && (length === undefined || newScale < scale)
      ? {
          ...types,
          kind: "scale",
          precision: newLength,
          scale: newScale,
          overflows:
            length === undefined || newLength - newScale < length - scale,
        }
      : undefined;
  }
  const family = lengthFamilies.find(
    ([names]) => names.has(source) && names.has(destination),
  );
  const using = unwrap<TypeCast>(definition?.raw_default, "TypeCast");
  return family !== undefined &&
    newLength !== undefined &&
    (length === undefined || length > newLength) &&
    using?.typeName !== undefined &&
    typeDisplay(using.typeName) === types.to
    ? { ...types, kind: "length", length: newLength, unit: family[1] }
    : undefined;
}

/** What a narrowing of `subject` (`table.column`) does on every target. */
export function narrowingReason(subject: string, narrowing: Narrowing): string {
  const happens =
    narrowing.kind === "length"
      ? `values longer than ${narrowing.length} ${narrowing.unit} are cut to ${narrowing.length}`
      : `values are rounded to ${narrowing.scale === 0 ? "whole numbers" : `${narrowing.scale} decimal place${narrowing.scale === 1 ? "" : "s"}`}`;
  const overflows =
    narrowing.kind === "scale" && narrowing.overflows
      ? `, and values too large for ${narrowing.to} make the deployment fail`
      : "";
  return `${subject} narrows from ${narrowing.from} to ${narrowing.to}: ${happens} on every target, without an error${overflows}`;
}

/** USING keeps the values when it is absent, the column itself, or a cast of it. */
function keepsValues(using: Node | undefined, column: string): boolean {
  if (using === undefined) {
    return true;
  }
  const cast = unwrap(using, "TypeCast") as { arg?: Node } | undefined;
  const reference = unwrap(cast?.arg ?? using, "ColumnRef") as
    | { fields?: Node[] }
    | undefined;
  const fields = stringList(reference?.fields);
  return fields.length === 1 && fields[0] === column;
}

function display(relation: RangeVar | undefined): string {
  return [relation?.schemaname, relation?.relname]
    .filter((part) => part !== undefined)
    .join(".");
}

/** The column or constraint an ALTER TABLE subcommand defines, if any. */
function commandDefinition(cmd: AlterTableCmd): {
  column: ColumnDef | undefined;
  constraint: Constraint | undefined;
} {
  return {
    column: unwrap<ColumnDef>(cmd.def, "ColumnDef"),
    constraint: unwrap<Constraint>(cmd.def, "Constraint"),
  };
}
