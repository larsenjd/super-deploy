// The target lock: a session-level advisory lock, taken with try-lock on the
// command's own session (the one that runs the deploy transaction), keyed
// from the history schema name. Session-level, so it outlives the deploy
// transaction's ROLLBACK and is released explicitly (or when the session
// closes). Every command that changes a target takes it: deploy, mark,
// rebuild, deploy-draft, disposable and init --adopt. Contention fails at
// once, naming the holder's running attempt and what its server process is
// doing (pg_stat_activity), so a user can tell a live command from a dead
// CLI's statement still running, and how to end that. When the holder's
// statement itself waits for a lock (a table another session holds), the
// description names each session it waits on (`pg_blocking_pids`), so a
// stuck deployment's cause shows in `status`.
//
// The advice is `pg_terminate_backend`, not `pg_cancel_backend` (ticket 51's
// decision said cancel): cancelling ends only the running statement, and the
// session, idle or in a failed transaction, keeps the session-level lock. That
// is exactly the case the advice is for: a half-open connection, or a server
// that can't check the client's connection (Windows). Terminating ends the
// session, which rolls its transaction back and releases the lock.
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
  // pg_stat_activity hides another role's state and query (state is null)
  // unless the session's role has pg_read_all_stats.
  const { rows } = await session.query<{
    pid: number;
    state: string | null;
    query_start: Date | null;
    query: string | null;
  }>(
    `SELECT l.pid, a.state, a.query_start, a.query
       FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid = $1::bigint::oid AND l.objid = $2::bigint::oid
      LIMIT 1`,
    [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()],
  );
  const [row] = rows;
  if (row === undefined) {
    return {
      pid: undefined,
      attempt: undefined,
      activity: undefined,
      blockedBy: [],
    };
  }
  const { pid } = row;
  const attempt = await readRunningAttemptOf(session, historySchema, pid);
  return {
    pid,
    blockedBy: await blockingSessions(session, pid),
    activity:
      row.state === null
        ? undefined
        : {
            state: row.state,
            statementStartedAt: row.query_start ?? undefined,
            statement: row.query ?? "",
          },
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

/**
 * The sessions holding a lock that server process `pid` waits for, as
 * `pg_stat_activity` shows them (its columns are null for another role's
 * session unless the reading role has pg_read_all_stats).
 */
async function blockingSessions(
  session: Session,
  pid: number,
): Promise<BlockingSession[]> {
  const { rows } = await session.query<{
    pid: number;
    application_name: string | null;
    usename: string | null;
    state: string | null;
    state_change: Date | null;
    query: string | null;
  }>(
    `SELECT b.pid, a.application_name, a.usename, a.state, a.state_change, a.query
       FROM unnest(pg_blocking_pids($1)) AS b(pid)
       LEFT JOIN pg_stat_activity a ON a.pid = b.pid
      ORDER BY b.pid`,
    [pid],
  );
  return rows.map((row) => ({
    pid: row.pid,
    applicationName: row.application_name ?? undefined,
    user: row.usename ?? undefined,
    state: row.state ?? undefined,
    stateSince: row.state_change ?? undefined,
    statement: row.query ?? undefined,
  }));
}

/** The holder of a target's lock, as recorded in its history schema. */
export interface LockHolder {
  /** The server process holding the lock. */
  readonly pid: number | undefined;
  /**
   * What that process is doing, from `pg_stat_activity`: undefined when the
   * holder is gone or the session's role may not see it.
   */
  readonly activity: LockHolderActivity | undefined;
  /**
   * The sessions holding a lock that process's statement waits for: empty
   * unless it is waiting for one.
   */
  readonly blockedBy: readonly BlockingSession[];
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

/** A lock holder's server process as `pg_stat_activity` shows it. */
export interface LockHolderActivity {
  /** `active`, `idle in transaction`, ... */
  readonly state: string;
  /** When its current statement started (its last one, unless active). */
  readonly statementStartedAt: Date | undefined;
  /** That statement's text, as the server tracks it (truncated to track_activity_query_size). */
  readonly statement: string;
}

/**
 * A session holding a lock the target lock's holder waits for, as
 * `pg_stat_activity` shows it; a field is undefined where it hides it.
 */
export interface BlockingSession {
  readonly pid: number;
  readonly applicationName: string | undefined;
  readonly user: string | undefined;
  /** `idle in transaction`, `active`, ... */
  readonly state: string | undefined;
  /** When it entered that state. */
  readonly stateSince: Date | undefined;
  /** Its current statement (its last one, unless active). */
  readonly statement: string | undefined;
}

/** Who holds a lock, briefly: "attempt #N", or "another session" when the holder recorded no running attempt. */
export function lockHolderName(holder: LockHolder): string {
  return holder.attempt === undefined
    ? "another session"
    : `attempt #${holder.attempt.id}`;
}

/**
 * Who holds a lock, in full: "attempt #N (deploy by ana, started <time>,
 * server process P, active, statement started <time>: ALTER TABLE ...)", or
 * "another session (server process P, ...)". So a user can tell a live
 * command from a dead CLI's statement still running on the server. When
 * that statement waits for a lock, it goes on ", waiting for a lock held by
 * server process N (psql, ana, idle in transaction since <time>: SELECT
 * ...)", naming every session it waits on.
 */
export function describeLockHolder(holder: LockHolder): string {
  const { attempt, pid, activity, blockedBy } = holder;
  const details = [
    ...(attempt === undefined
      ? []
      : [
          `${attempt.command} by ${attempt.osUser}`,
          `started ${attempt.startedAt.toISOString()}`,
        ]),
    ...(pid === undefined ? [] : [`server process ${pid}`]),
    ...(activity === undefined ? [] : [describeActivity(activity)]),
  ];
  const name = lockHolderName(holder);
  const described =
    details.length === 0 ? name : `${name} (${details.join(", ")})`;
  return blockedBy.length === 0
    ? described
    : `${described}, waiting for a lock held by ${blockedBy.map(describeBlocking).join(" and ")}`;
}

/** "server process N (psql, ana, idle in transaction since <time>: SELECT ...)" */
function describeBlocking(blocking: BlockingSession): string {
  const { applicationName, user, state, stateSince, statement } = blocking;
  const stateText =
    state === undefined
      ? undefined
      : stateSince === undefined
        ? state
        : `${state} since ${stateSince.toISOString()}`;
  const details = [
    applicationName === "" ? undefined : applicationName,
    user,
    stateText,
  ].filter((detail) => detail !== undefined);
  const text = oneLineStatement(statement ?? "");
  const inside =
    text === "" ? details.join(", ") : `${details.join(", ")}: ${text}`;
  return inside === ""
    ? `server process ${blocking.pid}`
    : `server process ${blocking.pid} (${inside})`;
}

/** The longest statement text a lock holder's description quotes. */
const statementLength = 200;

/** A statement on one line, cut at statementLength. */
function oneLineStatement(statement: string): string {
  const oneLine = statement.replace(/\s+/g, " ").trim();
  return oneLine.length > statementLength
    ? `${oneLine.slice(0, statementLength)}...`
    : oneLine;
}

/** "active, statement started <time>: <statement on one line>" */
function describeActivity(activity: LockHolderActivity): string {
  const { state, statementStartedAt, statement } = activity;
  const text = oneLineStatement(statement);
  const started =
    statementStartedAt === undefined
      ? []
      : [
          `${state === "active" ? "statement" : "last statement"} started ${statementStartedAt.toISOString()}`,
        ];
  const description = [state, ...started].join(", ");
  return text === "" ? description : `${description}: ${text}`;
}

/**
 * Another command holds the target's lock (deploy, mark, rebuild, deploy-draft,
 * disposable). The CLI's `status` also throws it, after its report, to exit 1.
 */
export class TargetLockedError extends SuperDeployError {
  readonly code = "target-locked";
  readonly target: string;
  readonly holder: LockHolder;

  constructor(target: string, holder: LockHolder) {
    // A CLI killed mid-statement leaves its server process running until the
    // server notices (target.ts's client connection check, where the
    // platform has one): the user can end it once they know it is dead.
    const terminate =
      holder.pid === undefined
        ? ""
        : `, or, if it is known to be dead, end its session with select pg_terminate_backend(${holder.pid})`;
    super(
      `Target ${target} is locked by ${describeLockHolder(holder)}; try again when it has finished${terminate}`,
    );
    this.target = target;
    this.holder = holder;
  }
}
