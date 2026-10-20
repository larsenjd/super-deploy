// `restore-schema [--acknowledge-overwrite]`: abandon unfinished edits by
// resetting the desired schema to the newest migration's snapshot, and delete
// any draft. Only *.sql files in the desired-schema folder are touched.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NoMigrationError } from "../errors.ts";
import type { Project } from "../project.ts";
import { acknowledgeOverwrite, type OverwriteOptions } from "../questions.ts";
import {
  differencesFromSnapshot,
  readDesiredSchemaFiles,
  restoreFromSnapshot,
  type SnapshotDifferences,
} from "../store/desired-schema.ts";
import type { HashedFile } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import { exists, snapshotFolderName } from "../store/migrations.ts";
import { draftName } from "./discard-draft.ts";

export type RestoreSchemaOptions = OverwriteOptions;

export interface RestoreSchemaResult {
  /** The migration whose snapshot was restored, e.g. `00001-add-customers`. */
  readonly migration: string;
  /** Project-relative paths of desired-schema files written from the snapshot. */
  readonly restored: readonly string[];
  /** Project-relative paths of desired-schema files deleted (not in the snapshot). */
  readonly deleted: readonly string[];
  /** Name of the draft that was deleted, if there was one. */
  readonly discardedDraft: string | undefined;
}

export async function restoreSchema(
  project: Project,
  options: RestoreSchemaOptions = {},
): Promise<RestoreSchemaResult> {
  const { root, paths } = project;
  const newest = (await verifiedMigrations(root, paths)).at(-1);
  if (newest === undefined) {
    throw new NoMigrationError("restore the desired schema from");
  }
  const snapshot = await readDesiredSchemaFiles(
    root,
    join(newest.path, snapshotFolderName),
  );
  const pending = await pendingRestore(project, snapshot);
  await acknowledgeOverwrite(options, {
    kind: "acknowledge-overwrite",
    command: "restore-schema",
    message: `Reset the desired schema to migration ${newest.folder}'s snapshot${discarding(pending)}?`,
    paths: pending.paths,
  });
  await rm(paths.draft, { recursive: true, force: true });
  await restoreFromSnapshot(paths.desiredSchema, snapshot, pending.differences);
  return {
    migration: newest.folder,
    ...pending.result,
    discardedDraft: pending.draft?.name,
  };
}

/** What restoring `snapshot` over the desired schema (and deleting any draft) would discard. */
export interface PendingRestore {
  readonly draft: { readonly name: string | undefined } | undefined;
  readonly differences: SnapshotDifferences;
  /** Project-relative: the draft folder (if any), then every changed desired-schema file. */
  readonly paths: readonly string[];
  readonly result: {
    readonly restored: readonly string[];
    readonly deleted: readonly string[];
  };
}

export async function pendingRestore(
  project: Project,
  snapshot: readonly HashedFile[],
): Promise<PendingRestore> {
  const { root, paths } = project;
  const draft = (await exists(paths.draft))
    ? { name: await draftName(project) }
    : undefined;
  const differences = await differencesFromSnapshot(
    paths.desiredSchema,
    snapshot,
  );
  const display = (path: string) =>
    projectRelative(root, join(paths.desiredSchema, path));
  const restored = differences.restore.map(display);
  const deleted = differences.delete.map(display);
  return {
    draft,
    differences,
    paths: [
      ...(draft === undefined ? [] : [projectRelative(root, paths.draft)]),
      ...[...restored, ...deleted].sort(),
    ],
    result: { restored, deleted },
  };
}

/** `, discarding draft add-orders and 2 changed files`, or "" when nothing is discarded. */
export function discarding(pending: PendingRestore): string {
  const changed =
    pending.result.restored.length + pending.result.deleted.length;
  const parts = [
    ...(pending.draft === undefined
      ? []
      : [`draft ${pending.draft.name ?? "(unnamed)"}`]),
    ...(changed === 0
      ? []
      : [`${changed} changed file${changed === 1 ? "" : "s"}`]),
  ];
  return parts.length === 0 ? "" : `, discarding ${parts.join(" and ")}`;
}
