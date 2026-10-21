// The attempt log: one row per command run against a target, written on its
// own session in autocommit, outside the deploy transaction, so it records
// failures the deploy transaction rolls back. An attempt opens as `running`
// and ends exactly once as succeeded, failed, abandoned or unknown.
import { userInfo } from "node:os";
import type { Session } from "../adapters/types.ts";
import { errorReason } from "../errors.ts";
import { SqlFileFailedError } from "../rehearsal/replay.ts";
import { toolVersion } from "../version.ts";
import { type AttemptOutcome, historyTable } from "./history.ts";

export interface AttemptStart {
  /** e.g. `deploy`. */
  readonly command: string;
  /** The target's name in config. */
  readonly target: string;
  /** Server process of the command's own session (the lock holder). */
  readonly backendPid: number | undefined;
}

export interface Attempt {
  readonly id: number;
  /** Records the range of migrations it applies: the first's number to the last's; nothing when empty. */
  setRange(migrations: readonly { readonly number: number }[]): Promise<void>;
  /** Ends a running attempt; later calls do nothing. */
  end(
    outcome: Exclude<AttemptOutcome, "running">,
    error?: unknown,
  ): Promise<void>;
}

/** Opens a running attempt on `log`, a session used for nothing else. */
export async function openAttempt(
  log: Session,
  historySchema: string,
  start: AttemptStart,
): Promise<Attempt> {
  const table = historyTable(historySchema, "attempts");
  const { rows } = await log.query<{ id: string }>(
    `INSERT INTO ${table} (command, target, os_user, tool_version, backend_pid)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      start.command,
      start.target,
      osUsername(),
      toolVersion,
      start.backendPid ?? null,
    ],
  );
  const id = Number(rows[0]?.id);
  let ended = false;
  return {
    id,
    async setRange(migrations) {
      const fromMigration = migrations[0]?.number;
      const toMigration = migrations.at(-1)?.number;
      if (fromMigration === undefined || toMigration === undefined) {
        return;
      }
      await log.query(
        `UPDATE ${table} SET from_migration = $2, to_migration = $3 WHERE id = $1`,
        [id, fromMigration, toMigration],
      );
    },
    async end(outcome, error) {
      if (ended) {
        return;
      }
      ended = true;
      await log.query(
        `UPDATE ${table}
            SET outcome = $2, ended_at = clock_timestamp(), error = $3, error_file = $4
          WHERE id = $1 AND outcome = 'running'`,
        [id, outcome, errorMessage(error), errorFile(error)],
      );
    },
  };
}

/** The OS username running this process, recorded in attempts. */
export function osUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

function errorMessage(error: unknown): string | null {
  if (error === undefined) {
    return null;
  }
  return errorReason(error).replace(/\s*\n\s*/g, " ");
}

function errorFile(error: unknown): string | null {
  return error instanceof SqlFileFailedError ? error.file : null;
}

/** An attempt `settleAttempts` gave its final outcome. */
export interface SettledAttempt {
  readonly id: number;
  readonly outcome: "succeeded" | "failed" | "abandoned";
}

/**
 * Settles every attempt whose outcome its command could not record: `unknown`
 * ones (the COMMIT's result was lost) and `running` ones whose command went
 * away without ending them (a crash, a forced exit). Only once the attempt's
 * server process is gone, so its transaction is over: then the migrations
 * rows (or, for deploy-draft, the deployed_draft row) written inside that
 * transaction say whether it committed. With rows it
 * succeeded; without, an `unknown` attempt failed and a `running` one was
 * abandoned. A server process id reused by a newer backend counts as gone.
 * Runs on any session to the target, in autocommit; the history schema must
 * exist.
 */
export async function settleAttempts(
  session: Session,
  historySchema: string,
): Promise<SettledAttempt[]> {
  const attempts = historyTable(historySchema, "attempts");
  const migrations = historyTable(historySchema, "migrations");
  const deployedDraft = historyTable(historySchema, "deployed_draft");
  const { rows } = await session.query<{
    id: string;
    outcome: SettledAttempt["outcome"];
  }>(
    `WITH settled AS (
       SELECT a.id,
              CASE
                WHEN EXISTS (SELECT 1 FROM ${migrations} m WHERE m.attempt_id = a.id)
                  OR EXISTS (SELECT 1 FROM ${deployedDraft} d WHERE d.attempt_id = a.id) THEN 'succeeded'
                WHEN a.outcome = 'unknown' THEN 'failed'
                ELSE 'abandoned'
              END AS outcome
         FROM ${attempts} a
        WHERE a.outcome IN ('unknown', 'running')
          AND a.backend_pid IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_stat_activity s
             WHERE s.pid = a.backend_pid
               AND (s.backend_start IS NULL OR s.backend_start <= a.started_at))
          FOR UPDATE OF a SKIP LOCKED)
     UPDATE ${attempts} a
        SET outcome = settled.outcome,
            ended_at = coalesce(a.ended_at, clock_timestamp()),
            error = concat_ws('; ',
              coalesce(a.error, CASE WHEN a.outcome = 'running' THEN 'The command ended without recording an outcome' END),
              CASE settled.outcome
                WHEN 'succeeded' THEN 'settled as succeeded: ' || CASE WHEN a.command = 'deploy-draft' THEN 'its draft is' ELSE 'its migrations are' END || ' recorded'
                ELSE 'settled as ' || settled.outcome || ': ' || CASE WHEN a.command = 'deploy-draft' THEN 'its draft is not' ELSE 'none of its migrations are' END || ' recorded'
              END)
       FROM settled
      WHERE a.id = settled.id AND a.outcome IN ('unknown', 'running')
      RETURNING a.id, a.outcome`,
  );
  return rows
    .map((row) => ({ id: Number(row.id), outcome: row.outcome }))
    .sort((a, b) => a.id - b.id);
}
