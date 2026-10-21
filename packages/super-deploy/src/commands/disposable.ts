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
//
// Marking a target holding a deployed draft not disposable goes ahead (it is
// the safe direction), but its confirmation says what that leaves (QA 167):
// deploy refuses the target until rebuild resets it, and rebuild then needs
// it flagged disposable again.
//
// The confirmation starts with the flag as it is now. The menu's question
// names it too (`readDisposableFlag`, read before the guard connects), with
// no preselected whatever the flag (QA 176).
import type { Session } from "../adapters/types.ts";
import { historyTable, readTargetSettings } from "../deploy/history.ts";
import { connectTarget, resolveTarget } from "../deploy/target.ts";
import { errorReason } from "../errors.ts";
import { runGuarded } from "../guard/guard.ts";
import { throwIfInterrupted } from "../interruption.ts";
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
    disposableSet: options.set,
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
        details: [
          `Now: ${view.disposable ? "disposable" : "not disposable"}`,
          ...(options.set
            ? [
                await describeContents(session, managedSchema),
                "deploy-draft will then be allowed to deploy a draft and its seed data to it, and rebuild to wipe it",
              ]
            : [
                "deploy-draft and rebuild will then refuse it",
                ...(view.draft === undefined
                  ? []
                  : [
                      `It holds deployed draft ${view.draft.name}: deploy refuses it until rebuild resets it, and rebuild will first need it flagged disposable again`,
                    ]),
              ]),
        ],
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

/** A target's disposable flag, or why it couldn't be read. */
export type DisposableFlag =
  | { readonly read: true; readonly disposable: boolean }
  | { readonly read: false; readonly reason: string };

/**
 * Reads target `targetName`'s flag without the guard or the lock, for the
 * menu's question (QA 176). An unreachable target gives the reason instead;
 * an interruption still throws.
 */
export async function readDisposableFlag(
  project: Project,
  targetName: string,
): Promise<DisposableFlag> {
  const target = resolveTarget(project, targetName);
  try {
    const session = await connectTarget(target, project.signal);
    try {
      const settings = await readTargetSettings(
        session,
        project.config.historySchema,
      );
      return { read: true, disposable: settings.disposable };
    } finally {
      await session.close().catch(() => {});
    }
  } catch (error) {
    throwIfInterrupted(project.signal);
    return { read: false, reason: errorReason(error) };
  }
}
