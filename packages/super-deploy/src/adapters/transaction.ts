// One transaction on a session, for callers whose COMMIT needs no special
// handling (deploy/engine.ts's inDeployTransaction classifies a lost COMMIT),
// and `rolledBack`, for a statement tried only to see whether PostgreSQL
// accepts it (deploy/ownership.ts's extension test).
import type { Session } from "./types.ts";

/**
 * Sends `begin` (BEGIN, or a batch starting with it), runs `body`, then
 * COMMITs; if `body` or the COMMIT throws, ROLLBACKs (best effort) and
 * rethrows.
 */
export async function inTransaction<T>(
  session: Session,
  body: () => Promise<T>,
  begin = "BEGIN",
): Promise<T> {
  await session.execute(begin);
  try {
    const result = await body();
    await session.execute("COMMIT");
    return result;
  } catch (error) {
    await session.execute("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * Runs `body` and undoes all it did, leaving the session's transaction state
 * as it was: in a savepoint, rolled back to and released, when the caller
 * has a transaction open, else in a transaction of its own, rolled back. A
 * failure in `body` never aborts the caller's transaction; it is rethrown
 * after the undo, which is best effort then, as in `inTransaction`.
 *
 * A transaction is open when it started before this statement. In
 * autocommit, PostgreSQL starts each statement's transaction at the
 * statement's own timestamp, so the two are equal; a transaction a caller
 * opened started at its BEGIN, an earlier message. Asking this way, rather
 * than trying SAVEPOINT and catching "can only be used in transaction
 * blocks", puts no ERROR in the server's log.
 */
export async function rolledBack<T>(
  session: Session,
  body: () => Promise<T>,
): Promise<T> {
  const [state] = await session.execute(
    "SELECT pg_catalog.transaction_timestamp() < pg_catalog.statement_timestamp() AS open",
  );
  const open = state?.rows[0]?.open === true;
  await session.execute(open ? `SAVEPOINT ${savepoint}` : "BEGIN");
  const undo = open
    ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`
    : "ROLLBACK";
  let result: T;
  try {
    result = await body();
  } catch (error) {
    await session.execute(undo).catch(() => {});
    throw error;
  }
  await session.execute(undo);
  return result;
}

const savepoint = "super_deploy_rolled_back";
