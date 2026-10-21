// What the draft's scripts still need to cover (spec story 11): statements in
// a generated schema change that lose or reject existing data unless a
// pre-migration script handles it first. Found by reading the schema change's
// syntax trees, then counting the affected rows in `draft`'s starting point
// (the finalized migrations replayed, then the draft's seed data and
// pre-migration script), so the count reflects the rehearsal data, not any
// target's. Tables and columns the migration creates are
// exempt: they hold no data yet.
//
// A type change whose cast keeps every value (a widening of the column's
// type in the starting point, judged as finalize judges destructiveness)
// needs nothing covered. A narrowing (`narrowingOf` in destructive.ts) is
// reported with what the generated cast does to the values that don't fit,
// counting only those (QA 111): a column with no values says so rather than
// that every value fits, and a numeric's values too large for its new
// precision, which fail the cast, are counted apart from those only rounded.
// A dropped column the schema change adds again with the same type is
// pg-delta changing its collation or generation expression (QA 103): the
// warning names it as replaced, with the in-place statement
// (`columnReplacement` in destructive.ts, as finalize words it).
//
// Advisory only: `draft` reports these and carries on. Acknowledging data
// loss at finalize is ticket 11's, from the same statements.
import type {
  AlterTableCmd,
  ColumnDef,
  TypeCast,
  TypeName,
} from "@pgsql/types";
import type { Session } from "../adapters/types.ts";
import { quoteIdentifier } from "../deploy/history.ts";
import type { PlannedStatement } from "../differ/index.ts";
import {
  type ColumnReplacement,
  columnReplacement,
  keepsEveryValue,
  type Narrowing,
  narrowingOf,
  narrowingReason,
  replacedColumnReason,
} from "../sql-analysis/destructive.ts";
import { type ParsedStatement, parseSqlFile } from "../sql-analysis/parse.ts";
import {
  isObject,
  type Json,
  list,
  stringList,
  unwrap,
} from "../sql-analysis/syntax-tree.ts";

export type ScriptCoverageKind =
  /** DROP TABLE: the table's rows are lost. */
  | "dropped-table"
  /** DROP COLUMN: its values are lost (a rename is regenerated as drop and add). */
  | "dropped-column"
  /** ALTER COLUMN TYPE with a cast that may fail or lose data (not a widening). */
  | "changed-type"
  /** SET NOT NULL (or a NOT NULL constraint): fails while nulls remain. */
  | "set-not-null"
  /** ADD COLUMN ... NOT NULL without a default: fails on a table with rows. */
  | "added-required-column";

export interface ScriptCoverage {
  readonly kind: ScriptCoverageKind;
  /** The table, unqualified (it is in the managed schema). */
  readonly table: string;
  /** The column, except for `dropped-table`. */
  readonly column: string | undefined;
  /** The schema-change statement, as in `DraftResult.statements`. */
  readonly statement: string;
  /**
   * Affected rows in the rehearsal data: every row (`dropped-table`,
   * `added-required-column`), the non-null values (`dropped-column`,
   * `changed-type`) or the nulls (`set-not-null`). For a `changed-type`
   * that narrows the column, only the values it would cut or round, or that
   * are too large for it.
   */
  readonly rows: number;
  /** One line saying what is at risk and what the pre-migration script can do. */
  readonly message: string;
}

interface Candidate {
  readonly kind: ScriptCoverageKind;
  readonly schema: string | undefined;
  readonly table: string;
  readonly column: string | undefined;
  readonly statement: string;
  /** The ALTER COLUMN ... TYPE subcommand, for `changed-type`. */
  readonly retype?: AlterTableCmd | undefined;
  /**
   * For `dropped-column`: the ADD COLUMN adding it again later in the
   * schema change, pg-delta's way to change a collation or a generation
   * expression (QA 103).
   */
  readded?: { statement: ParsedStatement; column: ColumnDef };
}

/** What `planned` (run on `source`) needs scripts to cover, in statement order. */
export async function scriptCoverage(
  source: Session,
  planned: readonly PlannedStatement[],
  managedSchema: string,
): Promise<ScriptCoverage[]> {
  const found: ScriptCoverage[] = [];
  const candidates: Candidate[] = [];
  for (const statement of planned) {
    await candidatesIn(statement.sql, candidates);
  }
  for (const candidate of candidates) {
    const schema = candidate.schema ?? managedSchema;
    const { keepsValues, narrowing } = await typeChangeOn(
      source,
      schema,
      candidate,
    );
    const affected = keepsValues
      ? undefined
      : await affectedRows(source, schema, candidate, narrowing);
    if (affected !== undefined) {
      const replacement =
        candidate.readded === undefined
          ? undefined
          : columnReplacement(
              await currentType(source, schema, candidate),
              candidate.readded.statement,
              candidate.readded.column,
              managedSchema,
            );
      found.push({
        kind: candidate.kind,
        table: candidate.table,
        column: candidate.column,
        statement: candidate.statement,
        rows: affected.rows,
        message: messageFor(candidate, affected, narrowing, replacement),
      });
    }
  }
  return found;
}

/** Appends `sql`'s candidates to `candidates`, the schema change's so far. */
async function candidatesIn(
  sql: string,
  candidates: Candidate[],
): Promise<void> {
  const parsed = await parseSqlFile({ path: "schema-change.sql", text: sql });
  if (!parsed.ok) {
    return;
  }
  for (const statement of parsed.statements) {
    const { node } = statement;
    const drop = unwrap(node, "DropStmt");
    if (drop?.removeType === "OBJECT_TABLE") {
      for (const object of list(drop.objects)) {
        const names = stringList(object);
        const table = names.at(-1);
        if (table !== undefined) {
          candidates.push({
            kind: "dropped-table",
            schema: names.length > 1 ? names[0] : undefined,
            table,
            column: undefined,
            statement: sql,
          });
        }
      }
    }
    const alter = unwrap(node, "AlterTableStmt");
    const relation = alter?.relation;
    if (alter?.objtype !== "OBJECT_TABLE" || !isObject(relation)) {
      continue;
    }
    const table = String(relation.relname);
    const schema =
      typeof relation.schemaname === "string" ? relation.schemaname : undefined;
    const push = (
      kind: ScriptCoverageKind,
      column: unknown,
      retype?: AlterTableCmd,
    ) => {
      if (typeof column === "string") {
        candidates.push({
          kind,
          schema,
          table,
          column,
          statement: sql,
          retype,
        });
      }
    };
    for (const item of list(alter.cmds)) {
      const command = unwrap(item, "AlterTableCmd");
      switch (command?.subtype) {
        case "AT_DropColumn":
          push("dropped-column", command.name);
          break;
        case "AT_AlterColumnType":
          push("changed-type", command.name, command as AlterTableCmd);
          break;
        case "AT_SetNotNull":
          push("set-not-null", command.name);
          break;
        case "AT_AddConstraint": {
          const constraint = unwrap(command.def, "Constraint");
          if (constraint?.contype === "CONSTR_NOTNULL") {
            for (const column of stringList(constraint.keys)) {
              push("set-not-null", column);
            }
          }
          break;
        }
        case "AT_AddColumn": {
          const column = unwrap(command.def, "ColumnDef");
          if (column !== undefined && isRequired(column)) {
            push("added-required-column", column.colname);
          }
          const dropped = candidates.findLast(
            (candidate) =>
              candidate.kind === "dropped-column" &&
              candidate.schema === schema &&
              candidate.table === table &&
              candidate.column === column?.colname,
          );
          if (dropped !== undefined && column !== undefined) {
            dropped.readded = { statement, column: column as ColumnDef };
          }
          break;
        }
      }
    }
  }
}

/** NOT NULL with nothing to fill existing rows: no default, identity or generation. */
function isRequired(column: Json): boolean {
  const types = list(column.constraints).map(
    (item) => unwrap(item, "Constraint")?.contype,
  );
  return (
    (column.is_not_null === true || types.includes("CONSTR_NOTNULL")) &&
    column.raw_default === undefined &&
    !types.some(
      (type) =>
        type === "CONSTR_DEFAULT" ||
        type === "CONSTR_IDENTITY" ||
        type === "CONSTR_GENERATED",
    )
  );
}

/** What a candidate affects in the rehearsal data. */
interface Affected {
  /** As `ScriptCoverage.rows`. */
  readonly rows: number;
  /** The column's non-null values (counted for a narrowing only). */
  readonly values: number;
  /**
   * Of `rows`, the values too large for a numeric's new precision: the cast
   * fails on them, so they aren't rounded. Zero for other candidates.
   */
  readonly tooLarge: number;
}

/**
 * The affected rows on `source`, or undefined when the table (or column)
 * doesn't exist there: the schema change creates it, so it holds no data.
 * For a `narrowing`, only the values it would change or fail on.
 */
async function affectedRows(
  source: Session,
  schema: string,
  candidate: Candidate,
  narrowing: Narrowing | undefined,
): Promise<Affected | undefined> {
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(candidate.table)}`;
  const existing = await source.query<{ found: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL
       AND ($2::text IS NULL OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute
         WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped
       )) AS found`,
    [
      relation,
      candidate.kind === "added-required-column"
        ? null
        : (candidate.column ?? null),
    ],
  );
  if (existing.rows[0]?.found !== true) {
    return undefined;
  }
  const where = (condition: string | undefined) =>
    condition === undefined ? "" : ` FILTER (WHERE ${condition})`;
  const column =
    narrowing === undefined || candidate.column === undefined
      ? undefined
      : quoteIdentifier(candidate.column);
  const tooLarge =
    column === undefined ? "false" : tooLargeFor(column, narrowing);
  const counted = await source.query<Affected>(
    `SELECT count(*)${where(affectedCondition(candidate, narrowing))}::integer AS rows,
       ${column === undefined ? "0" : `count(${column})`}::integer AS values,
       count(*) FILTER (WHERE ${tooLarge})::integer AS "tooLarge"
     FROM ${relation}`,
  );
  return counted.rows[0] ?? { rows: 0, values: 0, tooLarge: 0 };
}

/**
 * The condition on `column`'s values that are too large for a numeric
 * narrowing's new type once rounded to its scale (numeric(4,1) holds up to
 * 999.9), so the cast fails with "numeric field overflow".
 */
function tooLargeFor(column: string, narrowing: Narrowing | undefined): string {
  if (narrowing?.kind !== "scale" || !narrowing.overflows) {
    return "false";
  }
  const limit = `1${"0".repeat(narrowing.precision - narrowing.scale)}`;
  return `${column} <> 'NaN' AND abs(round(${column}, ${narrowing.scale})) >= ${limit}`;
}

/** The condition on the rows a candidate affects; undefined when all are. */
function affectedCondition(
  candidate: Candidate,
  narrowing: Narrowing | undefined,
): string | undefined {
  const column =
    candidate.column === undefined ? "" : quoteIdentifier(candidate.column);
  if (narrowing?.kind === "length") {
    return `length(${column}) > ${narrowing.length}`;
  }
  if (narrowing?.kind === "scale") {
    return `${column} <> round(${column}, ${narrowing.scale}) OR (${tooLargeFor(column, narrowing)})`;
  }
  switch (candidate.kind) {
    case "dropped-column":
    case "changed-type":
      return `${column} IS NOT NULL`;
    case "set-not-null":
      return `${column} IS NULL`;
    case "dropped-table":
    case "added-required-column":
      return undefined;
  }
}

/**
 * For a type change, judged against the column's current type on `source`:
 * whether it keeps every value, and how it narrows the column. Neither for
 * any other candidate.
 */
async function typeChangeOn(
  source: Session,
  schema: string,
  candidate: Candidate,
): Promise<{
  readonly keepsValues: boolean;
  readonly narrowing: Narrowing | undefined;
}> {
  const neither = { keepsValues: false, narrowing: undefined };
  const { retype, column } = candidate;
  if (retype === undefined || column === undefined) {
    return neither;
  }
  const current = await currentType(source, schema, candidate);
  return current === undefined
    ? neither
    : {
        keepsValues: keepsEveryValue(current, column, retype),
        narrowing: narrowingOf(current, column, retype),
      };
}

/** The column's type on `source`, or undefined when it doesn't exist there. */
async function currentType(
  source: Session,
  schema: string,
  candidate: Candidate,
): Promise<TypeName | undefined> {
  const current = await source.query<{ type: string }>(
    `SELECT pg_catalog.format_type(atttypid, atttypmod) AS type
     FROM pg_catalog.pg_attribute
     WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`,
    [
      `${quoteIdentifier(schema)}.${quoteIdentifier(candidate.table)}`,
      candidate.column,
    ],
  );
  const type = current.rows[0]?.type;
  return type === undefined ? undefined : await parseTypeName(type);
}

/** The syntax tree of a type as `format_type` prints it, e.g. `character varying(10)`. */
async function parseTypeName(type: string): Promise<TypeName | undefined> {
  const parsed = await parseSqlFile({
    path: "column-type.sql",
    text: `SELECT NULL::${type}`,
  });
  const select = parsed.ok
    ? unwrap(parsed.statements[0]?.node, "SelectStmt")
    : undefined;
  const target = unwrap(list(select?.targetList)[0], "ResTarget");
  return unwrap<TypeCast>(target?.val, "TypeCast")?.typeName;
}

function messageFor(
  candidate: Candidate,
  affected: Affected,
  narrowing: Narrowing | undefined,
  replacement: ColumnReplacement | undefined,
): string {
  const { kind, table, column } = candidate;
  const subject = `${table}.${column ?? ""}`;
  if (narrowing !== undefined) {
    return `${narrowingReason(subject, narrowing)} ${narrowingCount(affected, narrowing)}`;
  }
  const { rows } = affected;
  const count = (one: string, many: string) =>
    `(${rows === 0 ? `no ${many}` : `${rows} ${rows === 1 ? one : many}`} in the rehearsal data)`;
  switch (kind) {
    case "dropped-table":
      return `Table ${table} is dropped with its data ${count("row", "rows")}: copy what you need in the pre-migration script`;
    case "dropped-column":
      if (replacement !== undefined) {
        return replacedColumnReason(
          `Column ${subject}`,
          replacement,
          ` ${count("non-null value", "non-null values")}`,
        );
      }
      return `Column ${subject} is dropped with its data ${count("non-null value", "non-null values")}: rename it, or copy what you need, in the pre-migration script`;
    case "changed-type":
      return `Column ${subject} changes type by a plain cast ${count("non-null value", "non-null values")}: convert it in the pre-migration script if the cast could fail or lose data`;
    case "set-not-null":
      return `Column ${subject} becomes NOT NULL ${count("null", "nulls")}: fill in the nulls in the pre-migration script`;
    case "added-required-column":
      return `Column ${subject} is added NOT NULL without a default ${count("row", "rows")}: add and backfill it in the pre-migration script`;
  }
}

/**
 * A narrowing's count in the rehearsal data and what to do: no values, every
 * value fitting, the values cut (length), or those rounded and those too
 * large (scale), e.g. `(1 value in the rehearsal data is rounded; 1 is too
 * large for numeric(4,1) and makes the rehearsal fail)`.
 */
function narrowingCount(
  { rows, values, tooLarge }: Affected,
  narrowing: Narrowing,
): string {
  const advice =
    "shorten or move them in the pre-migration script if they matter";
  if (values === 0) {
    return `(no non-null values in the rehearsal data): if a target holds values that don't fit, ${advice}`;
  }
  if (rows === 0) {
    return `(every value in the rehearsal data fits): if a target holds values that don't, ${advice}`;
  }
  const valuesIn = (n: number) =>
    `${n} ${n === 1 ? "value" : "values"} in the rehearsal data`;
  if (narrowing.kind === "length") {
    return `(${valuesIn(rows)} ${rows === 1 ? "doesn't" : "don't"} fit): ${advice}`;
  }
  const parts = (
    [
      [rows - tooLarge, () => "rounded"],
      [
        tooLarge,
        (n: number) =>
          `too large for ${narrowing.to} and ${n === 1 ? "makes" : "make"} the rehearsal fail`,
      ],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(
      ([n, what], index) =>
        `${index === 0 ? valuesIn(n) : n} ${n === 1 ? "is" : "are"} ${what(n)}`,
    );
  return `(${parts.join("; ")}): ${tooLarge > 0 ? "change or move them in the pre-migration script" : advice}`;
}
