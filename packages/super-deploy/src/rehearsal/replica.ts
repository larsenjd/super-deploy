// A replica of a target: a throwaway database created with the target's
// encoding, locale and collation provider, holding exactly what the target's
// recorded migrations should have produced. The drift check (status, deploy)
// compares it with the target; the deployment rehearsal then runs the
// pending migrations on the same database; `mark` (ticket 20) builds one up
// to migration N and requires an empty diff.
import type { DatabaseRequest, Session } from "../adapters/types.ts";
import type { RecordedMigration } from "../deploy/history.ts";
import { UnknownRecordedMigrationError } from "../errors.ts";
import type { Project } from "../project.ts";
import type { FinalizedMigration } from "../store/migrations.ts";
import {
  type ReplayUnit,
  readRecoveryUnit,
  readReplayUnit,
  replay,
} from "./replay.ts";
import { ensureManagedSchema, withThrowawayDatabase } from "./throwaway.ts";

/** A finalized migration with the deploy-time files of each of its variants read. */
export interface MigrationWithUnit extends FinalizedMigration {
  /** The original variant's deploy-time files. */
  readonly unit: ReplayUnit;
  /** Recovery K's deploy-time files at index K-1 (its scripts around the migration's schema change). */
  readonly recoveryUnits: readonly ReplayUnit[];
}

/** Reads every variant's deploy-time files of each migration. */
export async function readMigrationsWithUnits(
  root: string,
  migrations: readonly FinalizedMigration[],
): Promise<MigrationWithUnit[]> {
  const read: MigrationWithUnit[] = [];
  for (const migration of migrations) {
    const recoveryUnits: ReplayUnit[] = [];
    for (const recovery of migration.recoveries) {
      recoveryUnits.push(await readRecoveryUnit(root, migration, recovery));
    }
    read.push({
      ...migration,
      unit: await readReplayUnit(root, migration.path, migration.folder),
      recoveryUnits,
    });
  }
  return read;
}

/** One variant of a migration: the original or Recovery K. */
export interface MigrationVariant {
  /** Undefined for the original, K for Recovery K. */
  readonly recovery: number | undefined;
  /** Recovery K's chain hash; undefined for the original. */
  readonly recoveryChainHash: string | undefined;
  readonly unit: ReplayUnit;
}

/**
 * What a target that hasn't recorded the migration runs: its newest
 * Recovery, else the original.
 */
export function newestVariant(migration: MigrationWithUnit): MigrationVariant {
  const k = migration.recoveries.length;
  const unit = migration.recoveryUnits[k - 1];
  return k === 0 || unit === undefined
    ? {
        recovery: undefined,
        recoveryChainHash: undefined,
        unit: migration.unit,
      }
    : {
        recovery: k,
        recoveryChainHash: migration.recoveries[k - 1]?.chainHash,
        unit,
      };
}

/**
 * The units that rebuild a target's recorded migrations, in number order:
 * each recorded migration with its RECORDED variant (`recorded.recovery`:
 * undefined = the original, K = Recovery K), never simply the newest one.
 * This is the one place that picks a recorded migration's variant. A
 * recorded migration or Recovery the project doesn't have throws
 * UnknownRecordedMigrationError (the deploy pre-flight refuses it first).
 */
export function replicaUnits(
  target: string,
  migrations: readonly MigrationWithUnit[],
  recorded: readonly RecordedMigration[],
): ReplayUnit[] {
  const byNumber = new Map(migrations.map((m) => [m.number, m] as const));
  const unitOf = (r: RecordedMigration) => {
    const migration = byNumber.get(r.number);
    return r.recovery === undefined
      ? migration?.unit
      : migration?.recoveryUnits[r.recovery - 1];
  };
  const unknown = recorded.filter((r) => unitOf(r) === undefined);
  if (unknown.length > 0) {
    throw new UnknownRecordedMigrationError(
      target,
      unknown.map((r) => r.number),
    );
  }
  return recorded.map((r) => unitOf(r) as ReplayUnit);
}

/**
 * Builds a replica (the managed schema, then `units` replayed in one
 * transaction) on a throwaway database matching `request`, runs `use` on it,
 * and drops it whatever happens.
 */
export function withReplica<T>(
  project: Project,
  request: DatabaseRequest,
  units: readonly ReplayUnit[],
  use: (replica: Session) => Promise<T>,
): Promise<T> {
  const { rehearsal, managedSchema } = project.config;
  return withThrowawayDatabase(rehearsal, request, async (replica) => {
    await ensureManagedSchema(replica, managedSchema);
    if (units.length > 0) {
      await replay(replica, units, managedSchema);
    }
    return use(replica);
  });
}
