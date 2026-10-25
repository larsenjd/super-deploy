// `finalize`: rehearse the draft, then freeze it as the next numbered
// migration: the draft's files, metadata and its snapshot of the desired
// schema, `desired-schema.diff`, the diff from the newest migration's
// snapshot (store/snapshots.ts, ADR-0008), read-only, hashed and chained in
// the index. Before anything is written, the diff is applied to that
// snapshot and must give back exactly the desired schema that was
// rehearsed. A Recovery draft becomes its migration's next Recovery
// (store/migrations.ts) instead, with no snapshot.
//
// A file in the draft folder that a draft doesn't hold is refused first
// (UnknownDraftFileError, store/draft.ts), before the rules or the
// rehearsal: copied into the migration, it would fail every later integrity
// check.
//
// Nothing locks the project's files between commands, so another command
// (discard-draft, draft, a second finalize) can change the draft while the
// rehearsal runs. finalize reads the draft once, before the rehearsal, and
// freezes exactly those files; just before writing it reads the draft again
// and refuses (DraftChangedError) if anything differs. The staging folder is
// created exclusively, so of two finalize writing the same migration one
// refuses (MigrationNotWrittenError) and never touches the other's files.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { differ } from "../differ/index.ts";
import { plural, SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import {
  acknowledgeDestructive,
  type DestructiveOptions,
} from "../questions.ts";
import type {
  DestructiveStatement,
  LockWarning,
  Override,
  UnqualifiedNameWarning,
} from "../sql-analysis/index.ts";
import {
  draftMetadataFileName,
  generatedSchemaChangeFileName,
  refuseUnknownDraftFiles,
} from "../store/draft.ts";
import { handEditReport, handEditReportFileName } from "../store/hand-edit.ts";
import {
  chainHash,
  type HashedFile,
  migrationContentHash,
  recoveryContentHash,
} from "../store/hashing.ts";
import { projectRelative } from "../store/layout.ts";
import {
  type IndexEntry,
  isRecoveryPath,
  makeReadOnly,
  maxMigrationNumber,
  metadataFileName,
  migrationFolderName,
  orIfMissing,
  type RecoveryIndexEntry,
  readHashedFiles,
  readIndex,
  recoveriesFolderName,
  recoveryFolderName,
  schemaChangeFileName,
  snapshotDiffFileName,
  writeIndex,
} from "../store/migrations.ts";
import { readSnapshot, snapshotDiff } from "../store/snapshots.ts";
import { parserName, parserVersion, toolVersion } from "../version.ts";
import { type RehearsedDraft, rehearseCurrentDraft } from "./rehearse.ts";

/**
 * metadata.json of a finalized migration. Deliberately no timestamps or
 * usernames: git records who and when.
 */
export interface MigrationMetadata {
  readonly tool: { readonly name: string; readonly version: string };
  readonly differ: { readonly name: string; readonly version: string };
  readonly parser: { readonly name: string; readonly version: string };
  readonly rehearsalServer: { readonly version: string };
  /**
   * Every override marker in the migration's deploy-time files, with the
   * object it applies to, the rules overridden and the reason. File paths
   * are relative to the migration folder.
   */
  readonly overrides: readonly Override[];
  /** Present only when the migration drops structure or deletes data. */
  readonly destructive?: DestructiveAcknowledgement;
  /**
   * Present only when the schema change was edited by hand after `draft`
   * generated it; HAND-EDITED.md in the migration holds the diff.
   */
  readonly schemaChangeEditedByHand?: true;
}

/** The destructive statements the developer acknowledged at finalize. */
export interface DestructiveAcknowledgement {
  readonly acknowledged: true;
  /** `file` is relative to the migration folder, e.g. `schema-change.sql`. */
  readonly statements: readonly DestructiveStatement[];
}

export type FinalizeOptions = DestructiveOptions;

export interface FinalizeResult {
  /** The migration's number (for a Recovery, the number of the migration it recovers). */
  readonly number: number;
  readonly name: string;
  /** The migration's folder name, e.g. `00001-add-customers`. */
  readonly folder: string;
  /** For a Recovery draft: K, the new Recovery's number. Undefined for a migration. */
  readonly recovery: number | undefined;
  /** Absolute path of the new migration (or Recovery) folder. */
  readonly path: string;
  /** The new migration's (or Recovery's) content and chain hashes. */
  readonly contentHash: string;
  readonly chainHash: string;
  readonly metadata: MigrationMetadata;
  /** The acknowledged destructive statements (project-relative paths in the new migration folder). */
  readonly destructive: readonly DestructiveStatement[];
  /** Statements that rewrite or scan an existing table while holding its lock (project-relative paths in the new migration folder). */
  readonly warnings: readonly LockWarning[];
  /**
   * Project-relative path the draft's schema change had when it was edited
   * by hand since `draft` generated it; undefined if not. The migration
   * records it (metadata.json and HAND-EDITED.md).
   */
  readonly handEdited: string | undefined;
  /**
   * Desired-schema routines whose bodies name its objects without a schema,
   * which fail for callers without the managed schema on their search_path.
   * Advisory; empty when none.
   */
  readonly unqualifiedNames: readonly UnqualifiedNameWarning[];
}

/**
 * A draft that drops structure or deletes data is refused unless
 * `acknowledgeDestructive` is set or `confirm` answers yes; it is asked
 * after the rules pass and before the rehearsal.
 */
export async function finalize(
  project: Project,
  options: FinalizeOptions = {},
): Promise<FinalizeResult> {
  const { root, paths } = project;
  await refuseUnknownDraftFiles(root, paths);
  const draftFiles = await readHashedFiles(root, paths.draft);
  const rehearsed = await rehearseCurrentDraft(project, "finalize", {
    async beforeRehearsal(draft, analysis) {
      const count = analysis.destructive.length;
      await acknowledgeDestructive(options, {
        kind: "acknowledge-destructive",
        command: "finalize",
        message: `Draft ${draft.name} drops structure or deletes data in ${plural(count, "statement")}. Finalize it anyway?`,
        statements: analysis.destructive,
      });
    },
  });
  const { destructive, warnings } = rehearsed.analysis;
  const { handEdit } = rehearsed;
  const target = await finalizedPlace(project, rehearsed);
  const { path } = target;
  // Draft files are named by project-relative path; once finalized they are
  // named relative to the migration (or Recovery) folder (metadata) or by
  // their new project-relative path (the result).
  const inMigration = <T extends { file: string }>(item: T): T => ({
    ...item,
    file: relative(paths.draft, join(root, item.file)).split(sep).join("/"),
  });
  const finalized = <T extends { file: string }>(item: T): T => ({
    ...item,
    file: projectRelative(root, join(path, inMigration(item).file)),
  });

  const metadata: MigrationMetadata = {
    tool: { name: "super-deploy", version: toolVersion },
    differ: { name: differ.name, version: differ.version },
    parser: { name: parserName, version: parserVersion },
    rehearsalServer: { version: rehearsed.serverVersion },
    overrides: rehearsed.overrides.map(inMigration),
    ...(destructive.length === 0
      ? {}
      : {
          destructive: {
            acknowledged: true,
            statements: destructive.map(inMigration),
          },
        }),
    ...(handEdit === undefined ? {} : { schemaChangeEditedByHand: true }),
  };
  const files: HashedFile[] = [
    ...draftFiles.filter((file) => target.fromDraft(file.path)),
    ...(rehearsed.recoveryOf === undefined
      ? [
          {
            path: snapshotDiffFileName,
            text: snapshotDiff(
              await readSnapshot(root, rehearsed.migrations),
              rehearsed.desiredSchema,
              projectRelative(root, path),
            ),
          },
        ]
      : []),
    { path: metadataFileName, text: `${JSON.stringify(metadata, null, 2)}\n` },
    ...(handEdit === undefined
      ? []
      : [{ path: handEditReportFileName, text: handEditReport(handEdit) }]),
  ];
  const contentHash = target.contentHash(files);
  const entry = {
    folder: target.folder,
    contentHash,
    chainHash: chainHash(target.previousChainHash, contentHash),
  };

  // Gone, even mid-deletion, is no files.
  const draftNow = await orIfMissing(
    () => readHashedFiles(root, paths.draft),
    [],
  );
  if (!sameFiles(draftFiles, draftNow)) {
    throw new DraftChangedError(projectRelative(root, paths.draft));
  }
  await writeFinalizedFolder(root, path, files);

  const index = await readIndex(paths);
  await writeIndex(paths, target.indexed(index.ok ? index.entries : [], entry));
  await rm(paths.draft, { recursive: true, force: true });

  const migration = rehearsed.recoveryOf;
  return {
    number: migration?.number ?? target.number,
    name: rehearsed.draft.name,
    path,
    metadata,
    ...entry,
    folder: migration?.folder ?? target.folder,
    recovery: migration === undefined ? undefined : target.number,
    destructive: destructive.map(finalized),
    warnings: warnings.map(finalized),
    handEdited: handEdit?.file,
    unqualifiedNames: rehearsed.unqualifiedNames,
  };
}

/** True if both list the same paths, in the same order, with the same text. */
function sameFiles(
  a: readonly HashedFile[],
  b: readonly HashedFile[],
): boolean {
  return (
    a.length === b.length &&
    a.every((file, i) => file.path === b[i]?.path && file.text === b[i]?.text)
  );
}

/**
 * Writes `files` as the read-only folder `path`: under a temporary name,
 * created exclusively, then renamed, so a half-written folder never looks
 * like a migration or Recovery (validate reports a leftover one). On
 * failure the temporary folder is removed (unless another finalize owns
 * it) and MigrationNotWrittenError is thrown.
 */
async function writeFinalizedFolder(
  root: string,
  path: string,
  files: readonly HashedFile[],
): Promise<void> {
  const staging = join(dirname(path), `.finalizing-${basename(path)}`);
  const shown = projectRelative(root, path);
  await mkdir(dirname(staging), { recursive: true });
  try {
    await mkdir(staging);
  } catch (error) {
    throw new MigrationNotWrittenError(shown, { cause: error });
  }
  try {
    for (const file of files) {
      const written = join(staging, file.path);
      await mkdir(dirname(written), { recursive: true });
      await writeFile(written, file.text);
    }
    await makeReadOnly(staging);
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw new MigrationNotWrittenError(shown, { cause: error });
  }
}

/** Where a rehearsed draft is frozen, and how it is hashed and indexed. */
interface FinalizedPlace {
  /** The migration's number, or K for Recovery K. */
  readonly number: number;
  /** `00003-add-orders`, or `recovery-1`. */
  readonly folder: string;
  /** Absolute path of the folder. */
  readonly path: string;
  /** Which draft files (relative to the draft folder) it holds. */
  readonly fromDraft: (path: string) => boolean;
  readonly contentHash: (files: readonly HashedFile[]) => string;
  readonly previousChainHash: string;
  /** index.json with the new entry added. */
  readonly indexed: (
    entries: readonly IndexEntry[],
    entry: RecoveryIndexEntry,
  ) => IndexEntry[];
}

/** The draft's own files, never copied into a migration or Recovery. */
const notFinalized: ReadonlySet<string> = new Set([
  draftMetadataFileName,
  generatedSchemaChangeFileName,
]);

async function finalizedPlace(
  project: Project,
  rehearsed: RehearsedDraft,
): Promise<FinalizedPlace> {
  const { paths } = project;
  const migration = rehearsed.recoveryOf;
  if (migration === undefined) {
    const number = rehearsed.migrations.length + 1;
    if (number > maxMigrationNumber) {
      throw new MigrationLimitError(maxMigrationNumber);
    }
    const folder = migrationFolderName(number, rehearsed.draft.name);
    return {
      number,
      folder,
      path: join(paths.migrations, folder),
      fromDraft: (path) => !notFinalized.has(path) && !isRecoveryPath(path),
      contentHash: (files) => migrationContentHash(folder, files),
      previousChainHash: rehearsed.migrations.at(-1)?.chainHash ?? "",
      indexed: (entries, entry) => [...entries, entry],
    };
  }
  // A Recovery holds the draft's scripts and seed data, never the schema
  // change (always its migration's) or a snapshot.
  const number = migration.recoveries.length + 1;
  const folder = recoveryFolderName(number);
  const recoveries = join(migration.path, recoveriesFolderName);
  await mkdir(recoveries, { recursive: true });
  return {
    number,
    folder,
    path: join(recoveries, folder),
    fromDraft: (path) =>
      !notFinalized.has(path) && path !== schemaChangeFileName,
    contentHash: (files) =>
      recoveryContentHash(migration.folder, folder, files),
    previousChainHash:
      migration.recoveries.at(-1)?.chainHash ?? migration.chainHash,
    indexed: (entries, entry) =>
      entries.map((existing) =>
        existing.folder === migration.folder
          ? {
              ...existing,
              recoveries: [...(existing.recoveries ?? []), entry],
            }
          : existing,
      ),
  };
}

/** Finalizing would number a migration past the last number folders allow. */
export class MigrationLimitError extends SuperDeployError {
  readonly code = "migration-limit";
  readonly limit: number;

  constructor(limit: number) {
    super(`Migration numbers stop at ${limit}`);
    this.limit = limit;
  }
}

/**
 * The draft changed (was discarded, regenerated or finalized by another
 * command) while finalize rehearsed it; nothing was finalized.
 */
export class DraftChangedError extends SuperDeployError {
  readonly code = "draft-changed";
  /** Project-relative path of the draft folder. */
  readonly draft: string;

  constructor(draft: string) {
    super(
      `The draft (${draft}) changed while finalize was running, so nothing was finalized: run finalize again`,
    );
    this.draft = draft;
  }
}

/**
 * finalize could not write the new migration (or Recovery) folder, e.g.
 * because another finalize wrote it at the same time; nothing was finalized.
 * `cause` is the file system's error.
 */
export class MigrationNotWrittenError extends SuperDeployError {
  readonly code = "migration-not-written";
  /** Project-relative path of the folder finalize was writing. */
  readonly folder: string;

  constructor(folder: string, options: { cause: unknown }) {
    const code = (options.cause as NodeJS.ErrnoException).code;
    const reason =
      code === "EEXIST" || code === "ENOTEMPTY"
        ? "it exists already, or another finalize is writing it"
        : `the file system refused (${code ?? String(options.cause)})`;
    super(
      `Could not write ${folder}: ${reason}. Nothing was finalized`,
      options,
    );
    this.folder = folder;
  }
}
