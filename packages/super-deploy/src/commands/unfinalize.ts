// `unfinalize [--acknowledge-overwrite]`: move the newest migration back into
// the draft to fix a mistake that hasn't shipped. The draft gets the
// migration's files (writable again, metadata.json and the snapshot left
// out), and the desired schema is reset to the snapshot frozen with it, so
// the draft is up to date and finalizing again reproduces the migration.
// Whether a target already recorded the migration is the developer's call.
//
// Order on disk: draft and desired schema first, then index.json, then the
// folder. A crash between the last two leaves an unindexed folder, which
// validate reports.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NoMigrationError } from "../errors.ts";
import type { Project } from "../project.ts";
import { acknowledgeOverwrite, type OverwriteOptions } from "../questions.ts";
import { restoreFromSnapshot } from "../store/desired-schema.ts";
import { writeDraftMetadata } from "../store/draft.ts";
import { desiredSchemaHash } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import {
  makeWritable,
  metadataFileName,
  readHashedFiles,
  readIndex,
  snapshotFolderName,
  writeIndex,
} from "../store/migrations.ts";
import { discarding, pendingRestore } from "./restore-schema.ts";

export type UnfinalizeOptions = OverwriteOptions;

export interface UnfinalizeResult {
  readonly number: number;
  readonly name: string;
  /** The removed migration folder's name, e.g. `00001-add-customers`. */
  readonly folder: string;
  /** Absolute path of the draft folder. */
  readonly draftPath: string;
  /** Project-relative paths of desired-schema files written from the snapshot. */
  readonly restored: readonly string[];
  /** Project-relative paths of desired-schema files deleted (not in the snapshot). */
  readonly deleted: readonly string[];
  /** Name of the draft that was replaced, if there was one. */
  readonly discardedDraft: string | undefined;
}

export async function unfinalize(
  project: Project,
  options: UnfinalizeOptions = {},
): Promise<UnfinalizeResult> {
  const { root, paths } = project;
  const migrations = await verifiedMigrations(root, paths);
  const newest = migrations.at(-1);
  if (newest === undefined) {
    throw new NoMigrationError("unfinalize");
  }
  const snapshotPrefix = `${snapshotFolderName}/`;
  const files = await readHashedFiles(root, newest.path);
  const snapshot = files
    .filter((file) => file.path.startsWith(snapshotPrefix))
    .map((file) => ({
      path: file.path.slice(snapshotPrefix.length),
      text: file.text,
    }));
  const draftFiles = files.filter(
    (file) =>
      !file.path.startsWith(snapshotPrefix) && file.path !== metadataFileName,
  );

  const pending = await pendingRestore(project, snapshot);
  await acknowledgeOverwrite(options, {
    kind: "acknowledge-overwrite",
    command: "unfinalize",
    message: `Move migration ${newest.folder} back into the draft and restore its desired-schema snapshot${discarding(pending)}?`,
    paths: pending.paths,
  });

  await rm(paths.draft, { recursive: true, force: true });
  for (const file of draftFiles) {
    const target = join(paths.draft, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
  await writeDraftMetadata(paths, {
    name: newest.name,
    desiredSchemaHash: desiredSchemaHash(snapshot),
  });
  await restoreFromSnapshot(paths.desiredSchema, snapshot, pending.differences);

  const index = await readIndex(paths);
  await writeIndex(
    paths,
    (index.ok ? index.entries : []).filter(
      (entry) => entry.folder !== newest.folder,
    ),
  );
  await makeWritable(newest.path);
  await rm(newest.path, { recursive: true, force: true });

  return {
    number: newest.number,
    name: newest.name,
    folder: newest.folder,
    draftPath: paths.draft,
    ...pending.result,
    discardedDraft: pending.draft?.name,
  };
}
