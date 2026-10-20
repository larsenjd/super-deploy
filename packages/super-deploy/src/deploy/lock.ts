// The target lock: a session-level advisory lock, taken with try-lock on the
// command's own session (the one that runs the deploy transaction), keyed
// from the history schema name. Session-level, so it outlives the deploy
// transaction's ROLLBACK and is released explicitly (or when the session
// closes). Every command that changes a target takes it: deploy, mark,
// rebuild, deploy-draft, disposable and init --adopt. Contention fails at
// once, naming the holder's running attempt.
//
// Advisory locks are per database, so the key only has to tell projects
// apart that share one database with different history schemas.

import { createHash } from "node:crypto";
import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
import { readRunningAttemptOf } from "./history.ts";

export type LockPurpose = "target" | "create-history";

/**
 * The advisory lock key (a signed 64-bit integer, as a decimal string) for
 * `historySchema`: the first 8 bytes of a SHA-256 of a fixed prefix, the
 * purpose and the schema name.
 */
export function lockKey(
  historySchema: string,
  purpose: LockPurpose = "target",
): string {
  const digest = createHash("sha256")
    .update(`super-deploy ${purpose} lock\n${historySchema}`)
    .digest();
  return digest.readBigInt64BE(0).toString();
}

export interface TargetLock {
  /** Releases the lock (idempotent; closing the session releases it too). */
  release(): Promise<void>;
}

/**
 * Takes the target lock on `session` or throws TargetLockedError naming the
 * holder. `log` reads the attempt log (any session to the same database).
 */
export async function acquireTargetLock(
  session: Session,
  log: Session,
  historySchema: string,
  targetName: string,
): Promise<TargetLock> {
  const key = lockKey(historySchema);
  const { rows } = await session.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS locked",
    [key],
  );
  if (rows[0]?.locked !== true) {
    throw new TargetLockedError(
      targetName,
      await lockHolder(log, historySchema),
    );
  }
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      await session.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
    },
  };
}

/** Who holds the target lock of `historySchema` in the session's database, if anyone. */
export async function lockHolder(
  session: Session,
  historySchema: string,
): Promise<LockHolder> {
  const key = BigInt(lockKey(historySchema));
  const unsigned = BigInt.asUintN(64, key);
  // A bigint key shows in pg_locks as classid = high 32 bits, objid = low 32
  // bits, objsubid = 1.
  const { rows } = await session.query<{ pid: number }>(
    `SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = $1::bigint::oid AND objid = $2::bigint::oid
      LIMIT 1`,
    [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()],
  );
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    return { pid: undefined, attempt: undefined };
  }
  const attempt = await readRunningAttemptOf(session, historySchema, pid);
  return {
    pid,
    attempt:
      attempt === undefined
        ? undefined
        : {
            id: attempt.id,
            command: attempt.command,
            osUser: attempt.osUser,
            startedAt: attempt.startedAt,
          },
  };
}

/** The holder of a target's lock, as recorded in its history schema. */
export interface LockHolder {
  /** The server process holding the lock. */
  readonly pid: number | undefined;
  /** The running attempt that process recorded, if one is found. */
  readonly attempt:
    | {
        readonly id: number;
        readonly command: string;
        readonly osUser: string;
        readonly startedAt: Date;
      }
    | undefined;
}

/** Another command holds the target's lock (deploy, mark, rebuild, deploy-draft, disposable). */
export class TargetLockedError extends SuperDeployError {
  readonly code = "target-locked";
  readonly target: string;
  readonly holder: LockHolder;

  constructor(target: string, holder: LockHolder) {
    const { attempt, pid } = holder;
    const who =
      attempt !== undefined
        ? `attempt #${attempt.id} (${attempt.command} by ${attempt.osUser}, started ${attempt.startedAt.toISOString()})`
        : pid !== undefined
          ? `another session (server process ${pid})`
          : "another session";
    super(
      `Target ${target} is locked by ${who}; try again when it has finished`,
    );
    this.target = target;
    this.holder = holder;
  }
}
