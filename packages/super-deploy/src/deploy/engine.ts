// The deployment engine, shared by every command that changes a target
// (deploy, disposable, deploy-draft, rebuild, mark, init --adopt).
//
// `withLockedTarget` runs a command body against a target:
//   1. connect the command session (adapter.connect() call #1): it takes the
//      target lock and runs the deploy transaction
//   2. connect the attempt-log session (call #2): autocommit, used only for
//      the history schema's attempts table
//   3. create the history schema if the target has none (its own
//      transaction); a deploy role without CREATE on the database is refused
//      first, naming the grant (HistorySchemaNotCreatableError, nothing
//      logged: there is nowhere to log it yet)
//   4. settle earlier attempts whose outcome was never recorded
//      (`settleAttempts`: a lost COMMIT, a command that died)
//   5. open a running attempt
//   6. take the target lock (try-lock; contention fails the attempt and
//      throws TargetLockedError)
//   7. run the body; if the project's signal aborts meanwhile, the command
//      session's server process is terminated (interruptible-session.ts)
//   8. end the attempt: succeeded, or the outcome `outcomeOf` picks (unknown
//      for a lost COMMIT, abandoned when interrupted, else failed); an
//      abandoned one throws InterruptedError naming the migration the target
//      is still at (`rollback`), for the CLI's closing line, and a failed SQL
//      file (SqlFileFailedError) is told the target, so a timeout's message
//      quotes the target's own lockTimeout or statementTimeout
//   9. release the lock and close both sessions, whatever happened
//
// `applyMigrations` is the deploy transaction itself. SQL it sends on the
// command session, in order (fault-injection wrappers match on these):
//   execute("BEGIN")
//   execute(<SET LOCAL statements joined by ";\n">)
//   per migration: execute(<each statement of each deploy-time file, one at
//     a time and without its semicolon: pre-migration script, schema change,
//     post-migration script>), execute("SET CONSTRAINTS ALL IMMEDIATE"),
//     execute("DISCARD TEMP"), then query(INSERT INTO <history>.migrations
//     ...)
//   execute("COMMIT")            or execute("ROLLBACK") after a failure
// Its frame (BEGIN, the SET LOCALs, COMMIT or ROLLBACK, a lost COMMIT's
// classification) is `inDeployTransaction`, which deploy-draft and rebuild
// also use with bodies of their own, so fault-injection wrappers see the
// same statements from them. Before it, the drift check (deploy, mark) reads
// the catalogs on the same session, opening with one batch of `BEGIN READ
// ONLY` and the same timeouts, and the attempt-log session sends its own
// BEGIN and COMMIT when it creates the history schema: a wrapper finds the
// deploy transaction as the first batch containing `lock_timeout` and not
// `READ ONLY`.

import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { SuperDeployError } from "../errors.ts";
import { InterruptedError, type InterruptedRollback } from "../interruption.ts";
import type { Project } from "../project.ts";
import {
  type ReplayUnit,
  runUnit,
  SqlFileFailedError,
} from "../rehearsal/replay.ts";
import { pinnedSettings } from "../rehearsal/throwaway.ts";
import { migrationFolderName } from "../store/migrations.ts";
import { type Attempt, openAttempt, settleAttempts } from "./attempts.ts";
import {
  type AttemptOutcome,
  ensureHistorySchema,
  type MigrationVariantIdentity,
  quoteIdentifier,
  readRecordedMigrations,
  recordMigration,
} from "./history.ts";
import { interruptibleSession } from "./interruptible-session.ts";
import { acquireTargetLock, type TargetLock } from "./lock.ts";
import { requireHistorySchemaCreatable } from "./preflight.ts";
import { connectTarget, resolveTarget, targetTimeouts } from "./target.ts";

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
  const commandSession = await connectTarget(target, signal);
  try {
    const log = await connectTarget(target, signal);
    try {
      await requireHistorySchemaCreatable(log, target.name, historySchema);
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
          outcome === "abandoned"
            ? new InterruptedError({
                cause:
                  error instanceof InterruptedError
                    ? error.cause
                    : (signal?.reason ?? error),
                rollback: await rolledBack(log, historySchema, target.name),
              })
            : error instanceof SqlFileFailedError
              ? error.onTarget(target)
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

/**
 * What an abandoned attempt left the target at: its deploy transaction rolled
 * back (a COMMIT already sent finishes first, and then the attempt
 * succeeds), so the target still records what it did before. Undefined if
 * that can't be read.
 */
async function rolledBack(
  log: Session,
  historySchema: string,
  target: string,
): Promise<InterruptedRollback | undefined> {
  try {
    const last = (await readRecordedMigrations(log, historySchema)).at(-1);
    return {
      target,
      lastRecorded:
        last === undefined
          ? undefined
          : migrationFolderName(last.number, last.name),
    };
  } catch {
    return undefined;
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
export interface MigrationToApply extends MigrationVariantIdentity {
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
  return [...pinnedSettings(managedSchema), ...targetTimeouts(target)];
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
  await inDeployTransaction(session, options, async () => {
    await ensureManagedSchemaInTransaction(session, options.managedSchema);
    await runMigrations(session, migrations, options);
  });
}

/**
 * Runs `body` in one deploy transaction on the command session: BEGIN, the
 * pinned settings and the target's timeouts, `body`, COMMIT (ROLLBACK if
 * `body` throws). A COMMIT whose result never arrived becomes
 * CommitOutcomeUnknownError, so `body` must write rows that settleAttempts
 * reads (migrations or deployed_draft) with the attempt's id.
 */
export async function inDeployTransaction(
  session: Session,
  options: ApplyOptions,
  body: () => Promise<void>,
): Promise<void> {
  await session.execute("BEGIN");
  try {
    await session.execute(
      deploymentSettings(options.managedSchema, options.target).join(";\n"),
    );
    await body();
  } catch (error) {
    await session.execute("ROLLBACK").catch(() => {});
    throw error;
  }
  await commitRecorded(session, options.target.name, options.attemptId);
}

/**
 * COMMITs a transaction that wrote `migrations` rows (or deploy-draft's
 * `deployed_draft` row) for `attemptId`. If the outcome can't be known (the
 * connection was lost), throws CommitOutcomeUnknownError, so the attempt is
 * recorded as `unknown` and the next settle decides it from those rows. Only
 * for transactions that write such rows: settling has nothing else to go on.
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

/** Inside a deploy transaction: creates the managed schema if the target lacks it. */
export async function ensureManagedSchemaInTransaction(
  session: Session,
  managedSchema: string,
): Promise<void> {
  // Checked first: CREATE SCHEMA IF NOT EXISTS needs the CREATE privilege
  // on the database even when the schema exists.
  const managed = await session.query(
    "SELECT 1 FROM pg_namespace WHERE nspname = $1",
    [managedSchema],
  );
  if (managed.rows.length === 0) {
    await session.execute(`CREATE SCHEMA ${quoteIdentifier(managedSchema)}`);
  }
}

/** Inside a deploy transaction: runs each migration's files and records it as deployed. */
export async function runMigrations(
  session: Session,
  migrations: readonly MigrationToApply[],
  options: ApplyOptions,
): Promise<void> {
  for (const migration of migrations) {
    await runUnit(session, migration.unit);
    await recordMigration(session, options.historySchema, {
      ...migration,
      attemptId: options.attemptId,
      recordedHow: "deployed",
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

/**
 * The connection to a target was lost while its deploy transaction was
 * committing, so whether the deployment landed is unknown. The attempt is
 * recorded as `unknown`; the next `status` or `deploy` settles it as
 * succeeded or failed from the migrations rows the transaction wrote.
 */
export class CommitOutcomeUnknownError extends SuperDeployError {
  readonly code = "commit-outcome-unknown";
  readonly target: string;
  readonly attemptId: number;

  constructor(target: string, attemptId: number, options?: ErrorOptions) {
    const cause = options?.cause;
    const reason =
      cause === undefined
        ? ""
        : ` (${cause instanceof Error ? cause.message : String(cause)})`;
    super(
      `Lost the connection to target ${target} during COMMIT, so it is unknown whether attempt #${attemptId} landed; the next status or deploy settles it${reason}`,
      options,
    );
    this.target = target;
    this.attemptId = attemptId;
  }
}
