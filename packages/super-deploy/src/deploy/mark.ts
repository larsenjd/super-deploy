// Marking: recording a target's next pending migration as deployed without
// running it, because someone already brought the target there by hand. Only
// when the target's managed schema matches, with no exceptions, a replica of
// its migrations up to that one (column order and ownership aside, as in the
// drift check). The record is the migration's original variant, marked
// rather than deployed, and is the only thing written: one `migrations` row
// in the target's history schema, inside its own transaction.
//
// The guarded `mark` command (commands/mark.ts) and `init --adopt` (ticket
// 22, which records migration 1 this way from `init`, without the guard) both
// use `markNextPending` under `withLockedTarget`.
//
// SQL `recordMarked` sends on the command session (fault-injection wrappers
// match on these): execute("BEGIN"), execute(<SET LOCAL statements, including
// lock_timeout, joined by ";\n">), query(INSERT INTO <history>.migrations
// ...), execute("COMMIT") (or "ROLLBACK" after a failure before it). Because
// it writes a `migrations` row with the attempt's id, a lost COMMIT or a
// crashed mark settles like a deployment: succeeded if the row is there.
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import {
  HistoryMismatchError,
  MarkMismatchError,
  NothingToMarkError,
} from "../errors.ts";
import type { Project } from "../project.ts";
import { readMigrationUnits } from "../rehearsal/replay.ts";
import {
  type MigrationWithUnit,
  replicaUnits,
  withReplica,
} from "../rehearsal/replica.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { driftBetween } from "../verification/drift.ts";
import {
  commitRecorded,
  deploymentSettings,
  type LockedTarget,
} from "./engine.ts";
import {
  type RecordedMigration,
  readRecordedMigrations,
  recordMigration,
} from "./history.ts";
import { pendingMigrations } from "./pending.ts";
import { historyMismatches } from "./preflight.ts";
import { targetDatabaseRequest } from "./target.ts";

/**
 * The project's finalized migrations with their deploy-time files, after the
 * integrity check (MigrationIntegrityError), so read before connecting.
 */
export async function readMarkableMigrations(
  project: Project,
): Promise<MigrationWithUnit[]> {
  const migrations = await verifiedMigrations(project.root, project.paths);
  const units = await readMigrationUnits(project.root, migrations);
  return migrations.map((migration, index) => ({
    ...migration,
    unit: units[index] ?? { label: migration.folder, files: [] },
  }));
}

/**
 * The target's next pending migration: the only one `mark` may record.
 * Refuses with HistoryMismatchError if what the target records doesn't match
 * the project (no faithful replica could be built), and NothingToMarkError
 * if nothing is pending.
 */
export function nextToMark(
  targetName: string,
  migrations: readonly MigrationWithUnit[],
  recorded: readonly RecordedMigration[],
): MigrationWithUnit {
  const mismatches = historyMismatches(migrations, recorded);
  if (mismatches.length > 0) {
    throw new HistoryMismatchError(targetName, mismatches);
  }
  const [next] = pendingMigrations(migrations, recorded);
  if (next === undefined) {
    throw new NothingToMarkError(targetName);
  }
  return next;
}

/**
 * The replica check: builds a replica of the target's recorded migrations
 * (each with its recorded variant) plus `next` (its original scripts) on a
 * throwaway database with the target's locale, and requires the target's
 * managed schema to match it exactly, column order and ownership aside.
 * Throws MarkMismatchError listing the differences. Only reads the target
 * (its catalogs, under its lock and statement timeouts).
 */
export async function requireReplicaMatch(
  project: Project,
  target: ResolvedTarget,
  session: Session,
  input: {
    readonly migrations: readonly MigrationWithUnit[];
    readonly recorded: readonly RecordedMigration[];
    readonly next: MigrationWithUnit;
  },
): Promise<void> {
  const units = [
    ...replicaUnits(target.name, input.migrations, input.recorded),
    input.next.unit,
  ];
  const differences = await withReplica(
    project,
    await targetDatabaseRequest(session),
    units,
    (replica) =>
      driftBetween(session, replica, project.config.managedSchema, {
        target,
      }),
  );
  if (differences.length > 0) {
    throw new MarkMismatchError(target.name, input.next.folder, differences);
  }
}

/**
 * Records `migration` as marked (original variant) for the locked target's
 * attempt, in a transaction of its own that writes nothing else.
 */
export async function recordMarked(
  project: Project,
  locked: LockedTarget,
  migration: MigrationWithUnit,
): Promise<void> {
  const { session, target, attempt } = locked;
  const { managedSchema, historySchema } = project.config;
  await session.execute("BEGIN");
  try {
    await session.execute(
      deploymentSettings(managedSchema, target).join(";\n"),
    );
    await recordMigration(session, historySchema, {
      number: migration.number,
      name: migration.name,
      contentHash: migration.contentHash,
      chainHash: migration.chainHash,
      recovery: undefined,
      attemptId: attempt.id,
      recordedHow: "marked",
    });
  } catch (error) {
    await session.execute("ROLLBACK").catch(() => {});
    throw error;
  }
  await commitRecorded(session, target.name, attempt.id);
}

/**
 * Marks the locked target's next pending migration: reads what it records
 * (under the lock), picks the next pending migration (`nextToMark`), sets
 * the attempt's range to it, runs the replica check (`requireReplicaMatch`)
 * and records it as marked (`recordMarked`). Returns the migration marked.
 *
 * No guard: the caller decides who may do this. `mark` asks for YES first;
 * `init --adopt` (ticket 22) calls it directly from `init`.
 */
export async function markNextPending(
  project: Project,
  locked: LockedTarget,
  migrations: readonly MigrationWithUnit[],
): Promise<MigrationWithUnit> {
  const recorded = await readRecordedMigrations(
    locked.session,
    project.config.historySchema,
  );
  const next = nextToMark(locked.target.name, migrations, recorded);
  await locked.attempt.setRange(next.number, next.number);
  await requireReplicaMatch(project, locked.target, locked.session, {
    migrations,
    recorded,
    next,
  });
  await recordMarked(project, locked, next);
  return next;
}
