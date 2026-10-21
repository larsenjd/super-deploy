// A target session that ends under a command, or waits too long, as the
// command reports it (QA 142). Without this, a session the server ended
// (`pg_terminate_backend`, a shutdown, the idle-in-transaction timeout of
// deploy/target.ts) or a lost connection surfaced as the driver's bare text,
// or, inside the deploy transaction, as a file PostgreSQL refused.
//
// Which errors count:
// - `sessionEnding` (errors.ts): SQLSTATE 57P01-57P05 and 25P03 are the server ending
//   the session; class 08, or an error with no SQLSTATE at all (node-postgres
//   reports a dropped connection so), is a lost connection. Either way
//   nothing the session had not committed survives. The deploy-time SQL
//   runner (rehearsal/replay.ts) passes these on unwrapped, since they are no
//   refusal of the file, and a lost COMMIT is told apart by them
//   (deploy/engine.ts, CommitOutcomeUnknownError).
// - Lock (55P03) and statement (57014) timeouts outside a deploy-time file
//   (the drift check, adoption's reads) become TargetTimeoutError, naming the
//   target's setting. Inside a file they stay SqlFileFailedError.
//
// Only errors a target's own sessions threw are reported as the target's:
// withLockedTarget traces both its sessions (`tracedSession`), so a
// rehearsal's throwaway database losing its connection isn't blamed on the
// target. An error thrown out of a deploy transaction is marked
// (`markRolledBack`), so the report says that transaction rolled back.

import type { QueryResult, Session } from "../adapters/types.ts";
import { durationText, type ResolvedTarget } from "../config/config.ts";
import {
  errorReason,
  type SessionEnding,
  SuperDeployError,
  sessionEnding,
  sqlStateOf,
} from "../errors.ts";
import type { InterruptedRollback } from "../interruption.ts";
import { unchangedTarget } from "../rehearsal/replay.ts";

const fromTarget = new WeakSet<object>();
const rolledBack = new WeakSet<object>();

/** `session`, remembering the errors its statements throw as a target's. */
export function tracedSession(session: Session): Session {
  const traced = (error: unknown): never => {
    if (typeof error === "object" && error !== null) {
      fromTarget.add(error);
    }
    throw error;
  };
  return {
    async query<Row>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      try {
        return await session.query<Row>(sql, values);
      } catch (error) {
        return traced(error);
      }
    },
    async execute(sql) {
      try {
        return await session.execute(sql);
      } catch (error) {
        return traced(error);
      }
    },
    serverVersion: () => session.serverVersion(),
    close: () => session.close(),
  };
}

/** Records that `error` came out of a deploy transaction, which rolled back. */
export function markRolledBack(error: unknown): void {
  if (typeof error === "object" && error !== null) {
    rolledBack.add(error);
  }
}

/** What a rolled-back command did not change, for TargetSessionEndedError. */
export interface SessionRollback {
  /** What rolled back, e.g. `deployment`. */
  readonly noun: string;
  /** What the target records; undefined when it couldn't be read. */
  readonly recorded: InterruptedRollback | undefined;
}

/**
 * The error a command under the target lock reports for `error`: a traced
 * session ending as TargetSessionEndedError, a traced timeout as
 * TargetTimeoutError, anything else as it is. `rollback` is asked for only
 * when the session ended inside a deploy transaction.
 */
export async function targetFailure(
  error: unknown,
  target: ResolvedTarget,
  rollback: () => Promise<SessionRollback>,
): Promise<unknown> {
  if (typeof error !== "object" || error === null || !fromTarget.has(error)) {
    return error;
  }
  const ending = sessionEnding(error);
  if (ending !== undefined) {
    return new TargetSessionEndedError(target.name, ending, {
      cause: error,
      rollback: rolledBack.has(error) ? await rollback() : undefined,
    });
  }
  const sqlState = sqlStateOf(error);
  if (sqlState === "55P03" || sqlState === "57014") {
    return new TargetTimeoutError(
      target,
      sqlState === "55P03" ? "lockTimeout" : "statementTimeout",
      { cause: error },
    );
  }
  return error;
}

/**
 * A target's session ended while a command held the target lock: the server
 * ended it (`pg_terminate_backend`, a shutdown, the idle-in-transaction
 * timeout) or the connection was lost. Nothing it hadn't committed survives:
 * either it ended before anything changed, or inside a transaction that
 * rolled back (`rollback`). A lost COMMIT is CommitOutcomeUnknownError
 * instead.
 */
export class TargetSessionEndedError extends SuperDeployError {
  readonly code = "target-session-ended";
  readonly target: string;
  readonly ending: SessionEnding;
  /** Set when the session ended inside a transaction, which rolled back. */
  readonly rollback: SessionRollback | undefined;

  constructor(
    target: string,
    ending: SessionEnding,
    options: ErrorOptions & { rollback?: SessionRollback | undefined },
  ) {
    const { rollback } = options;
    const reason = errorReason(options.cause);
    super(
      [
        ending === "ended"
          ? `The server ended the session on target ${target} (${reason}).`
          : `The connection to target ${target} was lost (${reason}).`,
        rollback === undefined
          ? `Nothing changed on target ${target}.`
          : `The ${rollback.noun} rolled back: ${
              rollback.recorded === undefined
                ? `target ${target} is unchanged`
                : unchangedTarget(target, rollback.recorded.lastRecorded)
            }.`,
        `Next: retry once target ${target} is reachable${ending === "ended" ? "; if its session was ended on purpose, find out why first" : ""}.`,
      ].join(" "),
      options,
    );
    this.target = target;
    this.ending = ending;
    this.rollback = rollback;
  }
}

/**
 * Outside a deploy-time file (the drift check, adoption's reads of the
 * target), a statement on the target ran into a lock or statement timeout.
 * Nothing changed on the target.
 */
export class TargetTimeoutError extends SuperDeployError {
  readonly code = "target-timeout";
  readonly target: string;
  /** The target setting that ran out. */
  readonly setting: "lockTimeout" | "statementTimeout";

  constructor(
    target: ResolvedTarget,
    setting: "lockTimeout" | "statementTimeout",
    options: ErrorOptions,
  ) {
    const reason = errorReason(options.cause);
    const name = target.name;
    const where = `for target ${name} in super-deploy.config.ts`;
    const statementTimeout = target.statementTimeoutMs;
    super(
      [
        setting === "lockTimeout"
          ? `Target ${name}'s lockTimeout (${durationText(target.lockTimeoutMs)}) ran out waiting for a lock (${reason}).`
          : statementTimeout === undefined
            ? `The server's statement_timeout for target ${name}'s deploy role cancelled a statement (${reason}).`
            : `Target ${name}'s statementTimeout (${durationText(statementTimeout)}) cancelled a statement (${reason}).`,
        `Nothing changed on target ${name}.`,
        setting === "lockTimeout"
          ? `Next: retry once whatever held the lock has finished, or raise lockTimeout ${where}.`
          : statementTimeout === undefined
            ? `Next: retry once whatever held it up has finished, or set statementTimeout ${where}, which overrides it.`
            : `Next: retry once whatever held it up has finished, or raise statementTimeout ${where}.`,
      ].join(" "),
      options,
    );
    this.target = name;
    this.setting = setting;
  }
}
