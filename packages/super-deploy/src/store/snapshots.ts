// Snapshots: the desired schema as it stood when each migration was
// finalized. This is the one place a migration's snapshot is read; every
// command that uses one (draft, rehearse, validate, the deploy-time rule
// checks, deploy's rehearsal, unfinalize, restore-schema) gets it from here.
// Before migration 1 the snapshot is the empty schema.
//
// For now each snapshot is read from its migration's `desired-schema/`
// folder (`snapshotFolderName`, store/migrations.ts). Once snapshots are
// stored as diffs from the previous migration's (ADR-0008), snapshot N is
// rebuilt by applying diffs 1 to N, so reading one reads every migration
// before it; commands that need several use `readSnapshots`, one forward
// pass. Only this module changes when the stored form does.
//
// The migrations given must have passed the integrity check
// (store/integrity.ts), in order from migration 1.
import { join } from "node:path";
import type { SqlFile } from "../sql-analysis/index.ts";
import { asSqlFiles, readDesiredSchemaFiles } from "./desired-schema.ts";
import type { HashedFile } from "./hashing.ts";
import { type FinalizedMigration, snapshotFolderName } from "./migrations.ts";

export interface Snapshot {
  /** The desired-schema files, relative to the desired-schema folder, sorted. */
  readonly files: readonly HashedFile[];
  /** The same files as SQL analysis input, with project-relative paths. */
  readonly sqlFiles: readonly SqlFile[];
}

/** The snapshot before migration 1. */
export const emptySnapshot: Snapshot = { files: [], sqlFiles: [] };

/**
 * The snapshot of the newest of `migrations`, the empty schema when there
 * are none. For migration N's, pass the history up to N.
 */
export async function readSnapshot(
  root: string,
  migrations: readonly FinalizedMigration[],
): Promise<Snapshot> {
  const newest = migrations.at(-1);
  return newest === undefined ? emptySnapshot : readOwnSnapshot(root, newest);
}

/** A migration with the snapshots on either side of it. */
export interface MigrationSnapshots {
  readonly migration: FinalizedMigration;
  /** The previous migration's snapshot (the empty schema for migration 1). */
  readonly before: Snapshot;
  /** The migration's own snapshot. */
  readonly after: Snapshot;
}

/** Each of `migrations` with the snapshots on either side of it, in order, read in one forward pass. */
export async function readSnapshots(
  root: string,
  migrations: readonly FinalizedMigration[],
): Promise<readonly MigrationSnapshots[]> {
  const steps: MigrationSnapshots[] = [];
  let before = emptySnapshot;
  for (const migration of migrations) {
    const after = await readOwnSnapshot(root, migration);
    steps.push({ migration, before, after });
    before = after;
  }
  return steps;
}

/** True for a path (relative to a migration folder) that stores the migration's snapshot. */
export function isSnapshotPath(path: string): boolean {
  return path.startsWith(`${snapshotFolderName}/`);
}

async function readOwnSnapshot(
  root: string,
  migration: FinalizedMigration,
): Promise<Snapshot> {
  const folder = join(migration.path, snapshotFolderName);
  const files = await readDesiredSchemaFiles(root, folder);
  return { files, sqlFiles: asSqlFiles(root, folder, files) };
}
