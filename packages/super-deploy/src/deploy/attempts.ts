// The attempt log: one row per command run against a target, written on its
// own session in autocommit, outside the deploy transaction, so it records
// failures the deploy transaction rolls back. An attempt opens as `running`
// and ends exactly once as succeeded, failed, abandoned or unknown.
import { userInfo } from "node:os";
import type { Session } from "../adapters/types.ts";
import { SqlFileFailedError } from "../errors.ts";
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
  /** Records the range of migrations it applies. */
  setRange(fromMigration: number, toMigration: number): Promise<void>;
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
    async setRange(fromMigration, toMigration) {
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
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s*\n\s*/g, " ");
}

function errorFile(error: unknown): string | null {
  return error instanceof SqlFileFailedError ? error.file : null;
}
