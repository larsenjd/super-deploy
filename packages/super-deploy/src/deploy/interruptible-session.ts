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
import type { Session } from "../adapters/types.ts";
import { cleanupOnAbort, throwIfInterrupted } from "../interruption.ts";

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
      // Waits up to 10 s for the server process to exit.
      await log
        .query("SELECT pg_terminate_backend($1, 10000)", [backendPid])
        .catch(() => {});
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
