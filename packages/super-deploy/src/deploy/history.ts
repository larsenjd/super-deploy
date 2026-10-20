// The history schema each target keeps (default `deployment_history`, config
// `historySchema`): which migrations it has recorded, every attempt to change
// it, and its settings. Layout version 1:
//
//   migrations   one row per recorded migration. Written INSIDE the deploy
//                transaction, so a row exists exactly when its migration
//                committed (ticket 14 settles lost COMMITs by reading them).
//     number         integer primary key
//     name           text      kebab-case name (folder = 00001-<name>)
//     content_hash   text      the migration's content hash from index.json
//     chain_hash     text      its chain hash
//     recovery       integer   null = the original scripts, K = Recovery K (ticket 17)
//     attempt_id     bigint    the attempt that recorded it
//     recorded_how   text      'deployed' or 'marked' (ticket 20)
//     recorded_at    timestamptz
//   attempts     one row per command run against the target (deploy, and
//                later mark, rebuild, deploy-draft, disposable). Written on
//                a SECOND connection outside the deploy transaction, so a
//                failed or rolled-back deployment is still recorded.
//     id             bigint identity primary key
//     command        text      e.g. 'deploy'
//     target         text      the target's name in config
//     from_migration, to_migration   integer, the range it applies (null when nothing is pending)
//     os_user        text      the OS username running the command
//     tool_version   text
//     backend_pid    integer   server process of the command's own session,
//                              which holds the target lock (names the holder)
//     started_at, ended_at     timestamptz
//     outcome        text      running | succeeded | failed | abandoned | unknown
//     error          text      one-line message when it didn't succeed
//     error_file     text      project-relative file that failed, if any
//   settings     exactly one row
//     disposable     boolean   false for new targets (ticket 18 sets it)
//     layout_version integer   1; bump with an upgrade step when columns change
//   deployed_draft  at most one row: the draft `deploy-draft` put on this
//                (disposable) target. Written INSIDE that command's
//                transaction, deleted inside `rebuild`'s. While it exists the
//                target's structure is no longer that of a recorded
//                migration, so deploy and mark refuse it (deploy/preflight.ts).
//     name           text      the draft's name
//     content_hash   text      sha256 of the files it ran (draftContentHash)
//     base_migration integer   the last recorded migration it went on top of (null: none)
//     seed_data      boolean   whether its seed data was loaded
//     attempt_id     bigint    the deploy-draft attempt (settles a lost COMMIT)
//     deployed_at    timestamptz
//
// Every statement schema-qualifies its tables: deploy transactions pin
// search_path to the managed schema and pg_catalog.
import type { Session } from "../adapters/types.ts";
import { lockKey } from "./lock.ts";

export const historyLayoutVersion = 1;

export type AttemptOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "abandoned"
  | "unknown";

/** A migration as a target's history schema records it. */
export interface RecordedMigration {
  readonly number: number;
  readonly name: string;
  readonly contentHash: string;
  readonly chainHash: string;
  /** Undefined for the original scripts, K for Recovery K. */
  readonly recovery: number | undefined;
  readonly attemptId: number;
  readonly recordedHow: "deployed" | "marked";
  readonly recordedAt: Date;
}

/** One row of the attempt log. */
export interface AttemptRecord {
  readonly id: number;
  readonly command: string;
  readonly target: string;
  /** First and last migration number it applies, when known. */
  readonly fromMigration: number | undefined;
  readonly toMigration: number | undefined;
  readonly osUser: string;
  readonly toolVersion: string;
  readonly startedAt: Date;
  readonly endedAt: Date | undefined;
  readonly outcome: AttemptOutcome;
  readonly error: string | undefined;
  readonly errorFile: string | undefined;
}

/** Double-quotes an identifier for SQL. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** `"<schema>"."<table>"` for one of the history tables. */
export function historyTable(
  schema: string,
  table: "migrations" | "attempts" | "settings" | "deployed_draft",
): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export async function historySchemaExists(
  session: Session,
  schema: string,
): Promise<boolean> {
  const { rows } = await session.query(
    "SELECT 1 FROM pg_namespace WHERE nspname = $1",
    [schema],
  );
  return rows.length > 0;
}

/**
 * Creates the history schema with all three tables in one transaction of its
 * own, unless it already exists. The first deployment does this before
 * opening its attempt: the attempt log is written outside the deploy
 * transaction and must survive that transaction rolling back, so its table
 * cannot be created inside it. Concurrent first commands are serialised by a
 * transaction-level advisory lock (a different key from the target lock).
 */
export async function ensureHistorySchema(
  session: Session,
  schema: string,
): Promise<void> {
  if (await historySchemaExists(session, schema)) {
    return;
  }
  const migrations = historyTable(schema, "migrations");
  const attempts = historyTable(schema, "attempts");
  const settings = historyTable(schema, "settings");
  const deployedDraft = historyTable(schema, "deployed_draft");
  await session.execute("BEGIN");
  try {
    await session.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      lockKey(schema, "create-history"),
    ]);
    await session.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};
CREATE TABLE IF NOT EXISTS ${attempts} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command text NOT NULL,
  target text NOT NULL,
  from_migration integer,
  to_migration integer,
  os_user text NOT NULL,
  tool_version text NOT NULL,
  backend_pid integer,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  outcome text NOT NULL DEFAULT 'running'
    CHECK (outcome IN ('running', 'succeeded', 'failed', 'abandoned', 'unknown')),
  error text,
  error_file text
);
CREATE TABLE IF NOT EXISTS ${migrations} (
  number integer PRIMARY KEY CHECK (number > 0),
  name text NOT NULL,
  content_hash text NOT NULL,
  chain_hash text NOT NULL,
  recovery integer CHECK (recovery > 0),
  attempt_id bigint NOT NULL REFERENCES ${attempts} (id),
  recorded_how text NOT NULL CHECK (recorded_how IN ('deployed', 'marked')),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${settings} (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  disposable boolean NOT NULL DEFAULT false,
  layout_version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS ${deployedDraft} (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  name text NOT NULL,
  content_hash text NOT NULL,
  base_migration integer,
  seed_data boolean NOT NULL,
  attempt_id bigint NOT NULL REFERENCES ${attempts} (id),
  deployed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ${settings} (layout_version) VALUES (${historyLayoutVersion})
  ON CONFLICT (singleton) DO NOTHING`);
    await session.execute("COMMIT");
  } catch (error) {
    await session.execute("ROLLBACK").catch(() => {});
    throw error;
  }
}

/** The target's recorded migrations in number order; none if it has no history schema yet. */
export async function readRecordedMigrations(
  session: Session,
  schema: string,
): Promise<RecordedMigration[]> {
  if (!(await historySchemaExists(session, schema))) {
    return [];
  }
  const { rows } = await session.query<{
    number: number;
    name: string;
    content_hash: string;
    chain_hash: string;
    recovery: number | null;
    attempt_id: string;
    recorded_how: "deployed" | "marked";
    recorded_at: Date;
  }>(
    `SELECT number, name, content_hash, chain_hash, recovery, attempt_id, recorded_how, recorded_at
       FROM ${historyTable(schema, "migrations")} ORDER BY number`,
  );
  return rows.map((row) => ({
    number: row.number,
    name: row.name,
    contentHash: row.content_hash,
    chainHash: row.chain_hash,
    recovery: row.recovery ?? undefined,
    attemptId: Number(row.attempt_id),
    recordedHow: row.recorded_how,
    recordedAt: row.recorded_at,
  }));
}

/** What a deployment writes for each migration, inside its transaction. */
export interface MigrationRecord {
  readonly number: number;
  readonly name: string;
  readonly contentHash: string;
  readonly chainHash: string;
  readonly recovery: number | undefined;
  readonly attemptId: number;
  readonly recordedHow: "deployed" | "marked";
}

export async function recordMigration(
  session: Session,
  schema: string,
  record: MigrationRecord,
): Promise<void> {
  await session.query(
    `INSERT INTO ${historyTable(schema, "migrations")}
       (number, name, content_hash, chain_hash, recovery, attempt_id, recorded_how)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      record.number,
      record.name,
      record.contentHash,
      record.chainHash,
      record.recovery ?? null,
      record.attemptId,
      record.recordedHow,
    ],
  );
}

interface AttemptRow {
  id: string;
  command: string;
  target: string;
  from_migration: number | null;
  to_migration: number | null;
  os_user: string;
  tool_version: string;
  started_at: Date;
  ended_at: Date | null;
  outcome: AttemptOutcome;
  error: string | null;
  error_file: string | null;
}

const attemptColumns =
  "id, command, target, from_migration, to_migration, os_user, tool_version, started_at, ended_at, outcome, error, error_file";

function attemptRecord(row: AttemptRow): AttemptRecord {
  return {
    id: Number(row.id),
    command: row.command,
    target: row.target,
    fromMigration: row.from_migration ?? undefined,
    toMigration: row.to_migration ?? undefined,
    osUser: row.os_user,
    toolVersion: row.tool_version,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    outcome: row.outcome,
    error: row.error ?? undefined,
    errorFile: row.error_file ?? undefined,
  };
}

/** The newest attempts first; none if the target has no history schema yet. */
export async function readRecentAttempts(
  session: Session,
  schema: string,
  limit: number,
): Promise<AttemptRecord[]> {
  if (!(await historySchemaExists(session, schema))) {
    return [];
  }
  const { rows } = await session.query<AttemptRow>(
    `SELECT ${attemptColumns} FROM ${historyTable(schema, "attempts")} ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map(attemptRecord);
}

/** The newest running attempt recorded by server process `pid` (the lock holder). */
export async function readRunningAttemptOf(
  session: Session,
  schema: string,
  pid: number,
): Promise<AttemptRecord | undefined> {
  if (!(await historySchemaExists(session, schema))) {
    return undefined;
  }
  const { rows } = await session.query<AttemptRow>(
    `SELECT ${attemptColumns} FROM ${historyTable(schema, "attempts")}
      WHERE backend_pid = $1 AND outcome = 'running' ORDER BY id DESC LIMIT 1`,
    [pid],
  );
  const [row] = rows;
  return row === undefined ? undefined : attemptRecord(row);
}

export interface TargetSettings {
  readonly disposable: boolean;
}

/** The target's settings; a target without a history schema is not disposable. */
export async function readTargetSettings(
  session: Session,
  schema: string,
): Promise<TargetSettings> {
  if (!(await historySchemaExists(session, schema))) {
    return { disposable: false };
  }
  const { rows } = await session.query<{ disposable: boolean }>(
    `SELECT disposable FROM ${historyTable(schema, "settings")}`,
  );
  return { disposable: rows[0]?.disposable === true };
}

/** The draft `deploy-draft` left on a target, as its history schema records it. */
export interface DeployedDraft {
  readonly name: string;
  /** sha256 of the files it ran, in order (draftContentHash). */
  readonly contentHash: string;
  /** The last recorded migration it was deployed on top of; undefined when there was none. */
  readonly baseMigration: number | undefined;
  /** Whether its seed data was loaded. */
  readonly seedData: boolean;
  readonly attemptId: number;
  readonly deployedAt: Date;
}

/** The draft the target holds, if `deploy-draft` left one (and nothing has rebuilt it since). */
export async function readDeployedDraft(
  session: Session,
  schema: string,
): Promise<DeployedDraft | undefined> {
  if (!(await historySchemaExists(session, schema))) {
    return undefined;
  }
  const { rows } = await session.query<{
    name: string;
    content_hash: string;
    base_migration: number | null;
    seed_data: boolean;
    attempt_id: string;
    deployed_at: Date;
  }>(
    `SELECT name, content_hash, base_migration, seed_data, attempt_id, deployed_at
       FROM ${historyTable(schema, "deployed_draft")}`,
  );
  const [row] = rows;
  return row === undefined
    ? undefined
    : {
        name: row.name,
        contentHash: row.content_hash,
        baseMigration: row.base_migration ?? undefined,
        seedData: row.seed_data,
        attemptId: Number(row.attempt_id),
        deployedAt: row.deployed_at,
      };
}

/** Inside deploy-draft's transaction: records the draft the target now holds. */
export async function recordDeployedDraft(
  session: Session,
  schema: string,
  draft: Omit<DeployedDraft, "deployedAt">,
): Promise<void> {
  await session.query(
    `INSERT INTO ${historyTable(schema, "deployed_draft")}
       (name, content_hash, base_migration, seed_data, attempt_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      draft.name,
      draft.contentHash,
      draft.baseMigration ?? null,
      draft.seedData,
      draft.attemptId,
    ],
  );
}
