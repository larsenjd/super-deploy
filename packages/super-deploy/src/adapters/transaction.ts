// One transaction on a session, for callers whose COMMIT needs no special
// handling (deploy/engine.ts's inDeployTransaction classifies a lost COMMIT).
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
