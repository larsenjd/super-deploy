// `disposable --target X --set yes|no`: flags a target as disposable (or not)
// in its own history schema, never in config, so editing the config can never
// make production disposable. A guarded command (guard/guard.ts):
// terminal-only, YES typed exactly, a manual attempt, the target lock.
//
// Marking a target disposable also shows how much its managed schema holds
// (tables and estimated rows), so a production-like database stands out
// from an empty one before YES. The rows are PostgreSQL's estimate, not a
// count(*): `reltuples`, or for a table never analyzed or vacuumed
// (reltuples -1) the statistics' live-row count, so a freshly loaded table
// doesn't look empty. A partitioned table counts as one table, holding its
// partitions' rows: the partitions are counted for their rows only.
import type { Session } from "../adapters/types.ts";
import { historyTable } from "../deploy/history.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";

export interface DisposableOptions {
  /** The target's name in config. */
  target: string;
  /** True marks it disposable, false marks it not disposable. */
  set: boolean;
}

export interface DisposableResult {
  readonly target: string;
  /** The target's flag afterwards. */
  readonly disposable: boolean;
  /** False when the target already had that value (nothing was asked or written). */
  readonly changed: boolean;
  /** The manual attempt that changed it; undefined when nothing changed. */
  readonly attemptId: number | undefined;
}

/**
 * Terminal-only: shows the target's details at this process's terminal and
 * goes ahead only when the person there types YES. Refuses with
 * TerminalRequiredError in CI or without a terminal on stdin and stdout
 * (before touching the target), and NotConfirmedError for any other answer.
 * No option skips that.
 */
export async function disposable(
  project: Project,
  options: DisposableOptions,
): Promise<DisposableResult> {
  const { historySchema, managedSchema } = project.config;
  return runGuarded<undefined, DisposableResult>(project, {
    command: "disposable",
    target: options.target,
    async check(view, session) {
      if (view.disposable === options.set) {
        return {
          nothingToDo: {
            target: view.target.name,
            disposable: options.set,
            changed: false,
            attemptId: undefined,
          },
        };
      }
      return {
        action: options.set
          ? `Mark target ${view.target.name} as disposable`
          : `Mark target ${view.target.name} as not disposable`,
        details: options.set
          ? [
              await describeContents(session, managedSchema),
              "deploy-draft will then be allowed to deploy a draft and its seed data to it, and rebuild to wipe it",
            ]
          : ["deploy-draft and rebuild will then refuse it"],
        plan: undefined,
      };
    },
    async run({ target, session, attempt }) {
      await session.query(
        `UPDATE ${historyTable(historySchema, "settings")} SET disposable = $1`,
        [options.set],
      );
      return {
        target: target.name,
        disposable: options.set,
        changed: true,
        attemptId: attempt.id,
      };
    },
  });
}

/** E.g. `Schema public holds 12 tables, about 48,000 rows`. */
async function describeContents(
  session: Session,
  schema: string,
): Promise<string> {
  const { rows } = await session.query<{ tables: number; rows: number }>(
    `SELECT (count(*) FILTER (WHERE NOT c.relispartition))::int AS tables,
            coalesce(sum(CASE WHEN c.relkind <> 'r' THEN 0
                              WHEN c.reltuples >= 0 THEN c.reltuples
                              ELSE pg_catalog.pg_stat_get_live_tuples(c.oid) END), 0)::float8 AS rows
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
    [schema],
  );
  const tables = rows[0]?.tables ?? 0;
  if (tables === 0) {
    return `Schema ${schema} holds no tables`;
  }
  const estimate = Math.round(rows[0]?.rows ?? 0);
  return `Schema ${schema} holds ${tables} ${tables === 1 ? "table" : "tables"}, about ${estimate.toLocaleString("en-US")} ${estimate === 1 ? "row" : "rows"}`;
}
