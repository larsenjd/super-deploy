// A target session that ends under a command, or waits too long, as the
// command reports it (QA 142). Without this, a session the server ended
// (`pg_terminate_backend`, a shutdown, the idle-in-transaction timeout of
// deploy/target.ts) or a lost connection surfaced as the driver's bare text,
// or, inside the deploy transaction, as a file PostgreSQL refused.
//
// Which errors count:
// - `sessionEnding` (errors.ts): SQLSTATE 57P01-57P05 and 25P03 are the
//   server ending the session; class 08, or an error with no SQLSTATE at all
//   (node-postgres reports a dropped connection so), is a lost connection.
//   Either way nothing the session had not committed survives. The
//   deploy-time SQL runner (rehearsal/replay.ts) passes these on unwrapped,
//   since they are no refusal of the file, and a lost COMMIT is told apart
//   by them (deploy/engine.ts, CommitOutcomeUnknownError).
// - Lock (55P03) and statement (57014) timeouts outside a deploy-time file
//   (the drift check, adoption's read before it takes the lock) become
//   TargetTimeoutError, naming the target's setting and its value. Inside a
//   file they stay SqlFileFailedError, told the target here so its next step
//   quotes the same (deploy/target.ts, `timeoutRanOut`).
//
// A command that changes a target in autocommit (`disposable`'s one UPDATE)
// is reported as having changed nothing if its session ends during that
// statement, though the server may have run it.
//
// Only errors a target's own sessions threw are reported as the target's:
// withLockedTarget traces both its sessions (`tracedSession`), so a
// rehearsal's throwaway database losing its connection isn't blamed on the
// target. An error thrown out of a deploy transaction is marked
// (`markRolledBack`), so the report says that transaction rolled back.

import type { QueryResult, Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import {
  errorReason,
  type SessionEnding,
  SuperDeployError,
  sessionEnding,
  sqlStateOf,
} from "../errors.ts";
import type { InterruptedRollback } from "../interruption.ts";
import { SqlFileFailedError, unchangedTarget } from "../rehearsal/replay.ts";
import {
  isTimeoutState,
  type TargetTimeoutSettings,
  type TimeoutState,
  timeoutRanOut,
} from "./target.ts";

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
 * TargetTimeoutError, a failed deploy-time file told the target (so a
 * timeout's next step quotes its settings, QA 145), anything else as it is.
 * `rollback` is asked for only when the session ended inside a deploy
 * transaction.
 */
export async function targetFailure(
  error: unknown,
  target: ResolvedTarget,
  rollback: () => Promise<SessionRollback>,
): Promise<unknown> {
  if (error instanceof SqlFileFailedError) {
    return error.onTarget(target);
  }
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
  return isTimeoutState(sqlState)
    ? new TargetTimeoutError(target, sqlState, { cause: error })
    : error;
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
 * Outside a deploy-time file, a statement on the target ran into its lock or
 * statement timeout: under the target lock (the drift check, the
 * pre-flight), or in a read before it (`outsideLock`, init --adopt's read of
 * the managed schema). Nothing changed on the target. The message words the
 * timeout as every timeout message does (deploy/target.ts, `timeoutRanOut`).
 */
export class TargetTimeoutError extends SuperDeployError {
  readonly code = "target-timeout";
  readonly target: string;
  /** The target setting that ran out. */
  readonly setting: "lockTimeout" | "statementTimeout";

  constructor(
    target: TargetTimeoutSettings,
    sqlState: TimeoutState,
    options: ErrorOptions & {
      /**
       * What the statement was part of when it ran outside the target lock,
       * e.g. `init --adopt read the target's managed schema`: the message
       * names it and says nothing was written, without pointing to
       * `status`, which shows only the target lock's holder.
       */
      outsideLock?: string | undefined;
    },
  ) {
    const { name } = target;
    const { what, next, blocker } = timeoutRanOut(target, sqlState);
    const { outsideLock } = options;
    super(
      [
        `${what}${outsideLock === undefined ? "" : ` while ${outsideLock}`} (${errorReason(options.cause)}).`,
        outsideLock === undefined
          ? `Nothing changed on target ${name}.`
          : `Nothing was written, to the project or to target ${name}.`,
        `Next: ${next}.`,
        outsideLock === undefined ? blocker : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(" "),
      options,
    );
    this.target = name;
    this.setting = sqlState === "55P03" ? "lockTimeout" : "statementTimeout";
  }
}
