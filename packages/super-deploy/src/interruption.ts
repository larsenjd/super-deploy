// Interruption. A project loaded with an AbortSignal (`loadProject({ signal })`)
// interrupts whatever command is running on it when the signal aborts: the
// command stops, cleans up, and rejects with InterruptedError.
//
// How commands take part:
// - Throwaway databases need nothing: loadProject wraps the rehearsal adapter
//   so every throwaway database is dropped as soon as the signal aborts (which
//   also ends any statement still running in it), and its sessions then refuse
//   further statements with InterruptedError.
// - Anything else that must be undone at once (e.g. a deploy transaction:
//   closing its session makes the server roll back and release session locks)
//   registers with `cleanupOnAbort(project.signal, ...)` and calls the returned
//   function on the normal path too, so the cleanup runs exactly once.
// - Cleanup that should run in order as the command unwinds (recording an
//   attempt as abandoned, releasing a lock on a session that stays open) goes
//   in `finally`, checking `project.signal?.aborted`.
// - Long stretches without database work call `throwIfInterrupted`.
//
// `settleCleanups(signal)` waits for every cleanup the abort started; the CLI
// calls it before closing the project and exiting.

import type {
  RehearsalAdapter,
  Session,
  ThrowawayDatabase,
} from "./adapters/types.ts";
import { SuperDeployError } from "./errors.ts";

const started = new WeakMap<AbortSignal, Set<Promise<void>>>();

/**
 * Registers `cleanup` to run as soon as `signal` aborts (at once if it already
 * has). Returns a function that runs it on the normal path instead. Either
 * way it runs at most once, and every caller awaits the same run.
 */
export function cleanupOnAbort(
  signal: AbortSignal | undefined,
  cleanup: () => Promise<void>,
): () => Promise<void> {
  let running: Promise<void> | undefined;
  const run = () => {
    signal?.removeEventListener("abort", onAbort);
    running ??= cleanup();
    return running;
  };
  const onAbort = () => {
    const promise = run().catch(() => {});
    if (signal !== undefined) {
      const set = started.get(signal) ?? new Set();
      started.set(signal, set);
      set.add(promise);
    }
  };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  return run;
}

/** Waits for every cleanup that `signal` aborting has started. Never rejects. */
export async function settleCleanups(signal: AbortSignal): Promise<void> {
  await Promise.all(started.get(signal) ?? []);
}

/** Throws InterruptedError if `signal` has aborted. */
export function throwIfInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new InterruptedError({ cause: signal.reason });
  }
}

/** @internal Wraps a rehearsal adapter so its throwaway databases are dropped when `signal` aborts. */
export function interruptibleRehearsal(
  adapter: RehearsalAdapter,
  signal: AbortSignal | undefined,
): RehearsalAdapter {
  if (signal === undefined) {
    return adapter;
  }
  const wrapped: RehearsalAdapter = {
    async createDatabase(request) {
      throwIfInterrupted(signal);
      const database = await adapter.createDatabase(request);
      const drop = cleanupOnAbort(signal, () => database.drop());
      if (signal.aborted) {
        await drop().catch(() => {});
        throwIfInterrupted(signal);
      }
      const interruptible: ThrowawayDatabase = {
        name: database.name,
        async connect() {
          throwIfInterrupted(signal);
          return refusingOnceInterrupted(
            await guarded(signal, () => database.connect()),
            signal,
          );
        },
        drop: () => guarded(signal, drop),
      };
      return interruptible;
    },
  };
  if (adapter.close !== undefined) {
    wrapped.close = () => adapter.close?.() ?? Promise.resolve();
  }
  return wrapped;
}

/** A session that refuses statements once `signal` aborts, and reports failures caused by the interruption as InterruptedError. */
function refusingOnceInterrupted(
  session: Session,
  signal: AbortSignal,
): Session {
  return {
    query: <Row>(sql: string, values?: readonly unknown[]) => {
      throwIfInterrupted(signal);
      return guarded(signal, () => session.query<Row>(sql, values));
    },
    execute: (sql) => {
      throwIfInterrupted(signal);
      return guarded(signal, () => session.execute(sql));
    },
    serverVersion: () => guarded(signal, () => session.serverVersion()),
    close: () => session.close(),
  };
}

/** Runs `run`, reporting a failure as InterruptedError if `signal` has aborted by then. */
async function guarded<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (signal.aborted) {
      throw new InterruptedError({ cause: error });
    }
    throw error;
  }
}

/**
 * The project's interruption signal aborted while a command was running. The
 * command has cleaned up (rolled back, dropped throwaway databases) by the
 * time this is thrown; `cause` is the signal's abort reason.
 */
export class InterruptedError extends SuperDeployError {
  readonly code = "interrupted";

  constructor(options?: ErrorOptions) {
    super("Interrupted", options);
  }
}
