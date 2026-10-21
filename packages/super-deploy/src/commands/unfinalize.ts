// `unfinalize [--acknowledge-overwrite]`: move the newest migration back into
// the draft to fix a mistake that hasn't shipped. The draft gets the
// migration's files (writable again, metadata.json and the snapshot left
// out), and the desired schema is reset to the snapshot frozen with it, so
// the draft is up to date and finalizing again reproduces the migration.
// Whether a target already recorded the migration is the developer's call:
// unfinalize doesn't check targets (QA 107 decided against it), so it asks
// nothing about them. It warns before anything moves instead: inside the
// overwrite question when that is asked, else through `onWarning`.
// Finalizing again unchanged reproduces the migration byte for byte, which
// is the way back; restore-schema is not (it resets to the migration before
// and deletes the draft). A target's refusal says the same (deploy/preflight.ts).
//
// Order on disk: draft and desired schema first, then index.json, then the
// folder. A crash between the last two leaves an unindexed folder, which
// validate reports.
//
// Recoveries: when the newest migration has Recoveries, its newest Recovery
// is newer than it, so that is what goes back (into a Recovery draft; the
// desired schema is left alone). `recoveryOf: N` picks migration N's newest
// Recovery instead, for a Recovery of an older migration.
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../project.ts";
import { acknowledgeOverwrite, type OverwriteOptions } from "../questions.ts";
import { restoreFromSnapshot } from "../store/desired-schema.ts";
import {
  writeDraft,
  writeDraftMetadata,
  writeRecoverySchemaChange,
} from "../store/draft.ts";
import {
  generatedFromReport,
  handEditReportFileName,
} from "../store/hand-edit.ts";
import { desiredSchemaHash } from "../store/hashing.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  exists,
  type FinalizedMigration,
  type FinalizedRecovery,
  isRecoveryPath,
  makeWritable,
  metadataFileName,
  NoMigrationError,
  readHashedFiles,
  readIndex,
  recoveriesFolderName,
  schemaChangeFileName,
  snapshotFolderName,
  UnknownMigrationError,
  writeFiles,
  writeIndex,
} from "../store/migrations.ts";
import { draftName } from "./discard-draft.ts";
import { NoRecoveryError } from "./recovery.ts";
import {
  discarding,
  pendingRestore,
  type RestoredDesiredSchema,
} from "./restore-schema.ts";

export interface UnfinalizeOptions extends OverwriteOptions {
  /**
   * Move migration N's newest Recovery back into a Recovery draft (for a
   * Recovery of a migration other than the newest). Without it: the newest
   * migration's newest Recovery if it has any, else the newest migration.
   */
  readonly recoveryOf?: number;
  /**
   * Called before anything moves with the warning not to change a migration
   * a target has recorded, unless `confirm` was asked the overwrite
   * question, which then carries it. Never called for a Recovery.
   */
  readonly onWarning?: (warning: string) => void;
}

export interface UnfinalizeResult extends RestoredDesiredSchema {
  readonly number: number;
  readonly name: string;
  /** The migration's folder name, e.g. `00001-add-customers` (removed unless a Recovery was unfinalized). */
  readonly folder: string;
  /** K when Recovery K of the migration was moved back (the migration stays); undefined when the migration itself was. */
  readonly recovery: number | undefined;
  /** Absolute path of the draft folder. */
  readonly draftPath: string;
}

export async function unfinalize(
  project: Project,
  options: UnfinalizeOptions = {},
): Promise<UnfinalizeResult> {
  const { root, paths } = project;
  const migrations = await verifiedMigrations(root, paths);
  if (options.recoveryOf !== undefined) {
    const migration = migrations[options.recoveryOf - 1];
    if (migration === undefined) {
      throw new UnknownMigrationError(
        options.recoveryOf,
        migrations.at(-1)?.number,
      );
    }
    const recovery = migration.recoveries.at(-1);
    if (recovery === undefined) {
      throw new NoRecoveryError(migration.folder);
    }
    return unfinalizeRecovery(project, options, migration, recovery);
  }
  const newest = migrations.at(-1);
  if (newest === undefined) {
    throw new NoMigrationError("unfinalize");
  }
  const newestRecovery = newest.recoveries.at(-1);
  if (newestRecovery !== undefined) {
    return unfinalizeRecovery(project, options, newest, newestRecovery);
  }
  const snapshotPrefix = `${snapshotFolderName}/`;
  const files = await readHashedFiles(
    root,
    newest.path,
    (path) => !isRecoveryPath(path),
  );
  const snapshot = files
    .filter((file) => file.path.startsWith(snapshotPrefix))
    .map((file) => ({
      path: file.path.slice(snapshotPrefix.length),
      text: file.text,
    }));
  const draftFiles = files.filter(
    (file) =>
      !file.path.startsWith(snapshotPrefix) &&
      file.path !== metadataFileName &&
      file.path !== handEditReportFileName,
  );
  const report = files.find((file) => file.path === handEditReportFileName);

  const pending = await pendingRestore(project, snapshot);
  // A target that recorded the migration refuses to deploy once it changes.
  const warning = `If migration ${newest.folder} was deployed anywhere, don't change it: finalize it again unchanged to put it back, then make the change in a new migration (or in a Recovery, if it failed on a target)`;
  let asked = false;
  const { confirm } = options;
  await acknowledgeOverwrite(
    {
      ...options,
      ...(confirm === undefined
        ? {}
        : {
            confirm: (question) => {
              asked = true;
              return confirm(question);
            },
          }),
    },
    {
      kind: "acknowledge-overwrite",
      command: "unfinalize",
      message: `${warning}. Move migration ${newest.folder} back into the draft and restore its desired-schema snapshot${discarding(pending)}?`,
      paths: pending.paths,
    },
  );
  if (!asked) {
    options.onWarning?.(warning);
  }

  await rm(paths.draft, { recursive: true, force: true });
  await writeFiles(paths.draft, draftFiles);
  // The draft gets the schema change `draft` generated back beside the
  // finalized one (restored from HAND-EDITED.md's diff when it was edited
  // by hand), so finalizing again records the same hand edit, and a later
  // one is told apart from one by the scripts (store/hand-edit.ts).
  const schemaChange = draftFiles.find(
    (file) => file.path === schemaChangeFileName,
  );
  const metadata = {
    name: newest.name,
    desiredSchemaHash: desiredSchemaHash(snapshot),
  };
  if (schemaChange === undefined) {
    await writeDraftMetadata(paths, metadata);
  } else {
    await writeDraft(
      paths,
      metadata,
      report === undefined
        ? schemaChange.text
        : generatedFromReport(report.text, schemaChange.text),
      schemaChange.text,
    );
  }
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
    recovery: undefined,
    draftPath: paths.draft,
    ...pending.result,
    discardedDraft: pending.draft?.name,
  };
}

/**
 * Recovery K of `migration` back into a Recovery draft: its files (minus
 * metadata.json) plus a copy of the migration's schema change. Only an
 * existing draft is at stake; the desired schema is left alone.
 */
async function unfinalizeRecovery(
  project: Project,
  options: UnfinalizeOptions,
  migration: FinalizedMigration,
  recovery: FinalizedRecovery,
): Promise<UnfinalizeResult> {
  const { root, paths } = project;
  const files = (await readHashedFiles(root, recovery.path)).filter(
    (file) => file.path !== metadataFileName,
  );
  const draft = (await exists(paths.draft))
    ? { name: await draftName(project) }
    : undefined;
  await acknowledgeOverwrite(options, {
    kind: "acknowledge-overwrite",
    command: "unfinalize",
    message: `Move Recovery ${recovery.number} of migration ${migration.folder} back into a Recovery draft${draft === undefined ? "" : `, discarding draft ${draft.name ?? "(unnamed)"}`}?`,
    paths: draft === undefined ? [] : [projectRelative(root, paths.draft)],
  });

  await rm(paths.draft, { recursive: true, force: true });
  await mkdir(paths.draft, { recursive: true });
  await writeFiles(paths.draft, files);
  await writeRecoverySchemaChange(paths, migration);
  await writeDraftMetadata(paths, {
    name: migration.name,
    recoveryOf: migration.number,
  });

  const index = await readIndex(paths);
  await writeIndex(
    paths,
    (index.ok ? index.entries : []).map((entry) =>
      entry.folder === migration.folder
        ? {
            ...entry,
            recoveries: (entry.recoveries ?? []).filter(
              (r) => r.folder !== recovery.folder,
            ),
          }
        : entry,
    ),
  );
  await makeWritable(recovery.path);
  await rm(recovery.path, { recursive: true, force: true });
  const recoveries = join(migration.path, recoveriesFolderName);
  if ((await readdir(recoveries)).length === 0) {
    await rm(recoveries, { recursive: true, force: true });
  }

  return {
    number: migration.number,
    name: migration.name,
    folder: migration.folder,
    recovery: recovery.number,
    draftPath: paths.draft,
    restored: [],
    deleted: [],
    discardedDraft: draft?.name,
  };
}
