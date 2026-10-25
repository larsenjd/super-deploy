// Snapshots: the desired schema as it stood when each migration was
// finalized. This is the one place a migration's snapshot is read or
// written; every command that uses one (draft, rehearse, validate, the
// deploy-time rule checks, deploy's rehearsal, unfinalize, restore-schema)
// gets it from here. Before migration 1 the snapshot is the empty schema.
//
// Each migration stores its snapshot as `desired-schema.diff`
// (`snapshotDiffFileName`, store/migrations.ts): the diff of the
// desired-schema files from the previous migration's snapshot, as `git diff`
// writes it (`filesDiff`, store/unified-diff.ts; ADR-0008). It is empty when
// the desired schema didn't change. Snapshot N is rebuilt by applying diffs
// 1 to N strictly to the empty schema, so reading one reads every migration
// before it; commands that need several use `readSnapshots`, one forward
// pass. A diff that doesn't apply throws SnapshotDiffDoesNotApplyError,
// naming the migration and the file, before the command writes anything.
// Rebuilt files have LF line endings, which is how they were hashed and
// compared all along.
//
// A rebuilt file has no place on disk, so as SQL analysis input it is named
// after the diff it came from: `<migration>/desired-schema.diff/<path>`.
//
// The migrations given must have passed the integrity check
// (store/integrity.ts), in order from migration 1.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlFile } from "../sql-analysis/index.ts";
import { type HashedFile, normaliseLineEndings } from "./hashing.ts";
import { projectRelative } from "./layout.ts";
import { type FinalizedMigration, snapshotDiffFileName } from "./migrations.ts";
import { applyFilesDiff, filesDiff } from "./unified-diff.ts";

export interface Snapshot {
  /** The desired-schema files, relative to the desired-schema folder, sorted, with LF line endings. */
  readonly files: readonly HashedFile[];
  /** The same files as SQL analysis input, named after the diff they came from. */
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
  return (await readSnapshots(root, migrations)).at(-1)?.after ?? emptySnapshot;
}

/** A migration with the snapshots on either side of it. */
export interface MigrationSnapshots {
  readonly migration: FinalizedMigration;
  /** The previous migration's snapshot (the empty schema for migration 1). */
  readonly before: Snapshot;
  /** The migration's own snapshot. */
  readonly after: Snapshot;
}

/** Each of `migrations` with the snapshots on either side of it, in order, rebuilt in one forward pass. */
export async function readSnapshots(
  root: string,
  migrations: readonly FinalizedMigration[],
): Promise<readonly MigrationSnapshots[]> {
  const steps: MigrationSnapshots[] = [];
  let before = emptySnapshot;
  for (const migration of migrations) {
    const diffPath = join(migration.path, snapshotDiffFileName);
    const files = applyFilesDiff(
      await readFile(diffPath, "utf8"),
      before.files,
      projectRelative(root, migration.path),
    );
    const named = projectRelative(root, diffPath);
    const after = {
      files,
      sqlFiles: files.map((file) => ({
        path: `${named}/${file.path}`,
        text: file.text,
      })),
    };
    steps.push({ migration, before, after });
    before = after;
  }
  return steps;
}

/** True for a path (relative to a migration folder) that stores the migration's snapshot. */
export function isSnapshotPath(path: string): boolean {
  return path === snapshotDiffFileName;
}

/**
 * The snapshot diff a new migration stores: from `previous`, the newest
 * migration's snapshot, to `desiredSchema`. Throws (a bug, not a user error)
 * unless applying it to `previous` gives back exactly `desiredSchema`, line
 * endings aside, so a diff that doesn't rebuild the schema is never
 * finalized. `migration` names the new migration in that error.
 */
export function snapshotDiff(
  previous: Snapshot,
  desiredSchema: readonly HashedFile[],
  migration: string,
): string {
  const diff = filesDiff(previous.files, desiredSchema);
  const rebuilt = applyFilesDiff(diff, previous.files, migration);
  const expected = [...desiredSchema].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  if (
    rebuilt.length !== expected.length ||
    rebuilt.some(
      (file, i) =>
        file.path !== expected[i]?.path ||
        file.text !== normaliseLineEndings(expected[i].text),
    )
  ) {
    throw new Error(
      `Bug in super-deploy: the desired-schema diff of ${migration} doesn't rebuild the desired schema, so nothing was finalized`,
    );
  }
  return diff;
}
