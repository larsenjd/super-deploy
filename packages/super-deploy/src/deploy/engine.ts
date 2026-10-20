// The deployment engine, shared by every command that changes a target
// (deploy now; mark, rebuild, deploy-draft and disposable later).
//
// `withLockedTarget` runs a command body against a target:
//   1. connect the command session (adapter.connect() call #1): it takes the
//      target lock and runs the deploy transaction
//   2. connect the attempt-log session (call #2): autocommit, used only for
//      the history schema's attempts table
//   3. create the history schema if the target has none (its own transaction)
//   4. open a running attempt
//   5. take the target lock (try-lock; contention fails the attempt and
//      throws TargetLockedError)
//   6. run the body
//   7. end the attempt: succeeded, or the outcome `outcomeOf(error)` picks
//   8. release the lock and close both sessions, whatever happened
//
// `applyMigrations` is the deploy transaction itself. SQL it sends on the
// command session, in order (fault-injection wrappers match on these):
//   execute("BEGIN")
//   execute(<SET LOCAL statements joined by ";\n">)
//   execute(<one batch per deploy-time file>), then query(INSERT INTO <history>.migrations ...) per migration
//   execute("COMMIT")            or execute("ROLLBACK") after a failure
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import type { Project } from "../project.ts";
import { type ReplayUnit, runUnit } from "../rehearsal/replay.ts";
import { pinnedSettings } from "../rehearsal/throwaway.ts";
import { type Attempt, openAttempt } from "./attempts.ts";
import {
  type AttemptOutcome,
  ensureHistorySchema,
  quoteIdentifier,
  recordMigration,
} from "./history.ts";
import { acquireTargetLock } from "./lock.ts";
import { connectTarget, resolveTarget } from "./target.ts";

/** What a command body gets: the target, its two sessions and its attempt. */
export interface LockedTarget {
  readonly target: ResolvedTarget;
  /** Holds the target lock; runs the deploy transaction. */
  readonly session: Session;
  /** The attempt log's own session (autocommit). Read-only use is fine too. */
  readonly log: Session;
  readonly attempt: Attempt;
}

/**
 * The outcome an attempt that threw ends with. Ticket 14 refines it: a COMMIT
 * whose result never arrived is `unknown`, an interruption `abandoned`.
 */
export function outcomeOf(
  _error: unknown,
): Exclude<AttemptOutcome, "running" | "succeeded"> {
  return "failed";
}

export async function withLockedTarget<T>(
  project: Project,
  targetName: string,
  command: string,
  body: (locked: LockedTarget) => Promise<T>,
): Promise<T> {
  const { historySchema } = project.config;
  const target = resolveTarget(project, targetName);
  const session = await connectTarget(target);
  try {
    const log = await connectTarget(target);
    try {
      await ensureHistorySchema(log, historySchema);
      const { rows } = await session.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const attempt = await openAttempt(log, historySchema, {
        command,
        target: target.name,
        backendPid: rows[0]?.pid,
      });
      try {
        const lock = await acquireTargetLock(
          session,
          log,
          historySchema,
          target.name,
        );
        try {
          const result = await body({ target, session, log, attempt });
          await attempt.end("succeeded");
          return result;
        } finally {
          await lock.release().catch(() => {});
        }
      } catch (error) {
        await attempt.end(outcomeOf(error), error).catch(() => {});
        throw error;
      }
    } finally {
      await log.close().catch(() => {});
    }
  } finally {
    await session.close().catch(() => {});
  }
}

/** A pending migration as the deploy transaction applies it. */
export interface MigrationToApply {
  readonly number: number;
  readonly name: string;
  readonly contentHash: string;
  readonly chainHash: string;
  /** Undefined for the original scripts, K for Recovery K (ticket 17). */
  readonly recovery: number | undefined;
  /** Its deploy-time files, in the order they run. */
  readonly unit: ReplayUnit;
}

export interface ApplyOptions {
  readonly managedSchema: string;
  readonly historySchema: string;
  readonly target: ResolvedTarget;
  readonly attemptId: number;
}

/** The `SET LOCAL` statements a deploy transaction starts with. */
export function deploymentSettings(
  managedSchema: string,
  target: ResolvedTarget,
): string[] {
  return [
    ...pinnedSettings(managedSchema),
    `SET LOCAL lock_timeout TO '${target.lockTimeoutMs}ms'`,
    ...(target.statementTimeoutMs === undefined
      ? []
      : [`SET LOCAL statement_timeout TO '${target.statementTimeoutMs}ms'`]),
  ];
}

/**
 * Applies every migration in ONE transaction (ADR-0001), recording each in
 * the history schema inside it: the target reaches the last one or is left
 * exactly as it was. The managed schema is created here if the target lacks
 * it, so that too rolls back.
 */
export async function applyMigrations(
  session: Session,
  migrations: readonly MigrationToApply[],
  options: ApplyOptions,
): Promise<void> {
  await session.execute("BEGIN");
  try {
    await session.execute(
      deploymentSettings(options.managedSchema, options.target).join(";\n"),
    );
    // Checked first: CREATE SCHEMA IF NOT EXISTS needs the CREATE privilege
    // on the database even when the schema exists.
    const managed = await session.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = $1",
      [options.managedSchema],
    );
    if (managed.rows.length === 0) {
      await session.execute(
        `CREATE SCHEMA ${quoteIdentifier(options.managedSchema)}`,
      );
    }
    for (const migration of migrations) {
      await runUnit(session, migration.unit);
      await recordMigration(session, options.historySchema, {
        number: migration.number,
        name: migration.name,
        contentHash: migration.contentHash,
        chainHash: migration.chainHash,
        recovery: migration.recovery,
        attemptId: options.attemptId,
        recordedHow: "deployed",
      });
    }
  } catch (error) {
    await session.execute("ROLLBACK").catch(() => {});
    throw error;
  }
  await session.execute("COMMIT");
}
