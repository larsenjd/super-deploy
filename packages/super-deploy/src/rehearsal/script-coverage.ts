// What the draft's scripts still need to cover (spec story 11): statements in
// a generated schema change that lose or reject existing data unless a
// pre-migration script handles it first. Found by reading the schema change's
// syntax trees, then counting the affected rows in `draft`'s starting point
// (the finalized migrations replayed, then the draft's seed data and
// pre-migration script), so the count reflects the rehearsal data, not any
// target's. Tables and columns the migration creates are
// exempt: they hold no data yet.
//
// Advisory only: `draft` reports these and carries on. Acknowledging data
// loss at finalize is ticket 11's, from the same statements.
import type { Session } from "../adapters/types.ts";
import { quoteIdentifier } from "../deploy/history.ts";
import type { PlannedStatement } from "../differ/types.ts";
import { parseSqlFile } from "../sql-analysis/parse.ts";
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
  /** ALTER COLUMN TYPE with a plain cast, which may fail or lose data. */
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
   * `changed-type`) or the nulls (`set-not-null`).
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
}

/** What `planned` (run on `source`) needs scripts to cover, in statement order. */
export async function scriptCoverage(
  source: Session,
  planned: readonly PlannedStatement[],
  managedSchema: string,
): Promise<ScriptCoverage[]> {
  const found: ScriptCoverage[] = [];
  for (const statement of planned) {
    for (const candidate of await candidatesIn(statement.sql)) {
      const schema = candidate.schema ?? managedSchema;
      const rows = await affectedRows(source, schema, candidate);
      if (rows !== undefined) {
        found.push({
          kind: candidate.kind,
          table: candidate.table,
          column: candidate.column,
          statement: candidate.statement,
          rows,
          message: messageFor(candidate, rows),
        });
      }
    }
  }
  return found;
}

async function candidatesIn(sql: string): Promise<Candidate[]> {
  const parsed = await parseSqlFile({ path: "schema-change.sql", text: sql });
  if (!parsed.ok) {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const { node } of parsed.statements) {
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
    const push = (kind: ScriptCoverageKind, column: unknown) => {
      if (typeof column === "string") {
        candidates.push({ kind, schema, table, column, statement: sql });
      }
    };
    for (const item of list(alter.cmds)) {
      const command = unwrap(item, "AlterTableCmd");
      switch (command?.subtype) {
        case "AT_DropColumn":
          push("dropped-column", command.name);
          break;
        case "AT_AlterColumnType":
          push("changed-type", command.name);
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
          break;
        }
      }
    }
  }
  return candidates;
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

/**
 * The affected rows on `source`, or undefined when the table (or column)
 * doesn't exist there: the schema change creates it, so it holds no data.
 */
async function affectedRows(
  source: Session,
  schema: string,
  candidate: Candidate,
): Promise<number | undefined> {
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
  const column =
    candidate.column === undefined ? "" : quoteIdentifier(candidate.column);
  const where =
    candidate.kind === "dropped-column" || candidate.kind === "changed-type"
      ? ` WHERE ${column} IS NOT NULL`
      : candidate.kind === "set-not-null"
        ? ` WHERE ${column} IS NULL`
        : "";
  const counted = await source.query<{ rows: number }>(
    `SELECT count(*)::integer AS rows FROM ${relation}${where}`,
  );
  return counted.rows[0]?.rows ?? 0;
}

function messageFor(candidate: Candidate, rows: number): string {
  const { kind, table, column } = candidate;
  const subject = `${table}.${column ?? ""}`;
  const count = (one: string, many: string) =>
    `(${rows === 0 ? `no ${many}` : `${rows} ${rows === 1 ? one : many}`} in the rehearsal data)`;
  switch (kind) {
    case "dropped-table":
      return `Table ${table} is dropped with its data ${count("row", "rows")}: copy what you need in the pre-migration script`;
    case "dropped-column":
      return `Column ${subject} is dropped with its data ${count("non-null value", "non-null values")}: rename it, or copy what you need, in the pre-migration script`;
    case "changed-type":
      return `Column ${subject} changes type by a plain cast ${count("non-null value", "non-null values")}: convert it in the pre-migration script if the cast could fail or lose data`;
    case "set-not-null":
      return `Column ${subject} becomes NOT NULL ${count("null", "nulls")}: fill in the nulls in the pre-migration script`;
    case "added-required-column":
      return `Column ${subject} is added NOT NULL without a default ${count("row", "rows")}: add and backfill it in the pre-migration script`;
  }
}
