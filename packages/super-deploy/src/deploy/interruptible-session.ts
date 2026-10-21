// Interrupting a command that holds a target. When the project's signal
// aborts, the command session's server process is terminated at once (from the
// attempt-log session): that rolls back any open transaction, ends a statement
// still running in it, and releases the session-level target lock. Closing the
// connection alone would not do: a server process busy with a statement does
// not notice its client is gone until the statement ends.
//
// A COMMIT already sent is let finish first, so an interruption never turns a
// deployment's outcome into an unknown one: it either committed (and the
// attempt succeeds) or it didn't.
//
// A command that only reads a target, with no attempt-log session
// (`init --adopt`'s read), uses `terminatedOnAbort`: on abort it connects
// once more just to terminate the reading session's server process, so a
// statement waiting for a lock doesn't keep the command waiting until the
// lock clears or lockTimeout passes.
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { cleanupOnAbort, throwIfInterrupted } from "../interruption.ts";
import { connectTarget } from "./target.ts";

export interface InterruptibleSession {
  /** The command session, refusing statements once the signal has aborted. */
  readonly session: Session;
  /**
   * Resolves once an interruption's termination has finished (at once if
   * there was none). Call it before recording the attempt's outcome.
   */
  settle(): Promise<void>;
}

export function interruptibleSession(
  session: Session,
  log: Session,
  backendPid: number | undefined,
  signal: AbortSignal | undefined,
): InterruptibleSession {
  let committing: Promise<unknown> | undefined;
  const settle = cleanupOnAbort(signal, async () => {
    if (signal?.aborted !== true) {
      return;
    }
    await committing?.catch(() => {});
    if (backendPid !== undefined) {
      await terminateFrom(log, backendPid);
    }
    await session.close().catch(() => {});
  });
  return {
    session: {
      query: <Row>(sql: string, values?: readonly unknown[]) => {
        throwIfInterrupted(signal);
        return session.query<Row>(sql, values);
      },
      execute: (sql) => {
        throwIfInterrupted(signal);
        const result = session.execute(sql);
        if (/^\s*COMMIT\s*;?\s*$/i.test(sql)) {
          committing = result;
        }
        return result;
      },
      serverVersion: () => session.serverVersion(),
      close: () => session.close(),
    },
    settle,
  };
}

/**
 * Registers `session`, a session to `target` that only reads, to have its
 * server process terminated as soon as `signal` aborts (see the header).
 * Returns the function that closes the session, which the command calls on
 * every path; it waits for a termination under way.
 */
export async function terminatedOnAbort(
  target: ResolvedTarget,
  session: Session,
  signal: AbortSignal | undefined,
): Promise<() => Promise<void>> {
  let backendPid: number | undefined;
  try {
    const { rows } = await session.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    backendPid = rows[0]?.pid;
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
  return cleanupOnAbort(signal, async () => {
    if (signal?.aborted === true && backendPid !== undefined) {
      // The command's signal has aborted, so this connect goes without it.
      const terminator = await connectTarget(target, undefined).catch(
        () => undefined,
      );
      if (terminator !== undefined) {
        await terminateFrom(terminator, backendPid);
        await terminator.close().catch(() => {});
      }
    }
    await session.close().catch(() => {});
  });
}

/** Terminates server process `pid` from `session`, waiting up to 10 s for it to exit; never rejects. */
async function terminateFrom(session: Session, pid: number): Promise<void> {
  await session
    .query("SELECT pg_terminate_backend($1, 10000)", [pid])
    .catch(() => {});
}
