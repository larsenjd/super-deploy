// The deployment engine, shared by every command that changes a target
// (deploy now; mark, rebuild, deploy-draft and disposable later).
//
// `withLockedTarget` runs a command body against a target:
//   1. connect the command session (adapter.connect() call #1): it takes the
//      target lock and runs the deploy transaction
//   2. connect the attempt-log session (call #2): autocommit, used only for
//      the history schema's attempts table
//   3. create the history schema if the target has none (its own transaction)
//   4. settle earlier attempts whose outcome was never recorded
//      (`settleAttempts`: a lost COMMIT, a command that died)
//   5. open a running attempt
//   6. take the target lock (try-lock; contention fails the attempt and
//      throws TargetLockedError)
//   7. run the body; if the project's signal aborts meanwhile, the command
//      session's server process is terminated (interruptible-session.ts)
//   8. end the attempt: succeeded, or the outcome `outcomeOf` picks (unknown
//      for a lost COMMIT, abandoned when interrupted, else failed)
//   9. release the lock and close both sessions, whatever happened
//
// `applyMigrations` is the deploy transaction itself. SQL it sends on the
// command session, in order (fault-injection wrappers match on these):
//   execute("BEGIN")
//   execute(<SET LOCAL statements joined by ";\n">)
//   per migration: execute(<one batch per deploy-time file: pre-migration
//     script, schema change, post-migration script>), execute("SET CONSTRAINTS
//     ALL IMMEDIATE"), execute("DISCARD TEMP"), then query(INSERT INTO
//     <history>.migrations ...)
//   execute("COMMIT")            or execute("ROLLBACK") after a failure
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { CommitOutcomeUnknownError, InterruptedError } from "../errors.ts";
import type { Project } from "../project.ts";
import { type ReplayUnit, runUnit } from "../rehearsal/replay.ts";
import { pinnedSettings } from "../rehearsal/throwaway.ts";
import { type Attempt, openAttempt, settleAttempts } from "./attempts.ts";
import {
  type AttemptOutcome,
  ensureHistorySchema,
  quoteIdentifier,
  recordMigration,
} from "./history.ts";
import { interruptibleSession } from "./interruptible-session.ts";
import { acquireTargetLock, type TargetLock } from "./lock.ts";
import { connectTarget, resolveTarget } from "./target.ts";

/** What a command body gets: the target, its two sessions and its attempt. */
export interface LockedTarget {
  readonly target: ResolvedTarget;
  /** Holds the target lock; runs the deploy transaction. Refuses statements (InterruptedError) once the project is interrupted. */
  readonly session: Session;
  /** The attempt log's own session (autocommit). Read-only use is fine too. */
  readonly log: Session;
  readonly attempt: Attempt;
}

/**
 * The outcome an attempt that threw ends with: `unknown` when its COMMIT's
 * result never arrived, `abandoned` when the command was interrupted,
 * otherwise `failed`.
 */
export function outcomeOf(
  error: unknown,
  signal: AbortSignal | undefined,
): Exclude<AttemptOutcome, "running" | "succeeded"> {
  if (error instanceof CommitOutcomeUnknownError) {
    return "unknown";
  }
  return signal?.aborted === true ? "abandoned" : "failed";
}

export async function withLockedTarget<T>(
  project: Project,
  targetName: string,
  command: string,
  body: (locked: LockedTarget) => Promise<T>,
): Promise<T> {
  const { historySchema } = project.config;
  const { signal } = project;
  const target = resolveTarget(project, targetName);
  const commandSession = await connectTarget(target);
  try {
    const log = await connectTarget(target);
    try {
      await ensureHistorySchema(log, historySchema);
      await settleAttempts(log, historySchema);
      const { rows } = await commandSession.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const backendPid = rows[0]?.pid;
      const attempt = await openAttempt(log, historySchema, {
        command,
        target: target.name,
        backendPid,
      });
      const { session, settle } = interruptibleSession(
        commandSession,
        log,
        backendPid,
        signal,
      );
      let lock: TargetLock | undefined;
      try {
        lock = await acquireTargetLock(
          session,
          log,
          historySchema,
          target.name,
        );
        const result = await body({ target, session, log, attempt });
        // If this fails (the log connection is gone) the command still
        // succeeded: the attempt stays running, and the next status or deploy
        // settles it as succeeded from the migrations rows it wrote.
        await attempt.end("succeeded").catch(() => {});
        return result;
      } catch (error) {
        await settle();
        const outcome = outcomeOf(error, signal);
        const failure =
          outcome === "abandoned" && !(error instanceof InterruptedError)
            ? new InterruptedError({ cause: signal?.reason ?? error })
            : error;
        await attempt
          .end(
            outcome,
            outcome === "abandoned" ? interruption(signal) : failure,
          )
          .catch(() => {});
        throw failure;
      } finally {
        // After an interruption the lock went with the terminated process;
        // releasing it then fails harmlessly.
        await settle();
        await lock?.release().catch(() => {});
      }
    } finally {
      await log.close().catch(() => {});
    }
  } finally {
    await commandSession.close().catch(() => {});
  }
}

/** What an abandoned attempt records as its error, e.g. `Interrupted (SIGINT)`. */
function interruption(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  const why =
    reason instanceof Error
      ? reason.message
      : reason === undefined
        ? ""
        : String(reason);
  return why === "" ? "Interrupted" : `Interrupted (${why})`;
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
  await commitRecorded(session, options.target.name, options.attemptId);
}

/**
 * COMMITs a transaction that wrote `migrations` rows for `attemptId`. If the
 * outcome can't be known (the connection was lost), throws
 * CommitOutcomeUnknownError, so the attempt is recorded as `unknown` and the
 * next settle decides it from those rows. Only for transactions that write
 * migrations rows: settling has nothing else to go on.
 */
export async function commitRecorded(
  session: Session,
  targetName: string,
  attemptId: number,
): Promise<void> {
  try {
    await session.execute("COMMIT");
  } catch (error) {
    if (error instanceof InterruptedError || refusedByServer(error)) {
      throw error;
    }
    throw new CommitOutcomeUnknownError(targetName, attemptId, {
      cause: error,
    });
  }
}

/**
 * Whether the server itself refused the statement (a SQLSTATE), so the
 * transaction is known to have rolled back. Connection exceptions (class 08)
 * and shutdowns or terminations (57P) say nothing about a COMMIT's outcome,
 * and neither does an error without a SQLSTATE (a dropped connection).
 */
function refusedByServer(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  return (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !code.startsWith("08") &&
    !code.startsWith("57P")
  );
}
