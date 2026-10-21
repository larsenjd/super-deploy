// `finalize`: rehearse the draft, then freeze it as the next numbered
// migration: the draft's files, metadata and a desired-schema snapshot,
// read-only, hashed and chained in the index. A Recovery draft becomes its
// migration's next Recovery (store/migrations.ts) instead.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
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
} from "../sql-analysis/index.ts";
import {
  draftMetadataFileName,
  type UnknownDraftFileOptions,
} from "../store/draft.ts";
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
  type RecoveryIndexEntry,
  readHashedFiles,
  readIndex,
  recoveriesFolderName,
  recoveryFolderName,
  schemaChangeFileName,
  snapshotFolderName,
  writeIndex,
} from "../store/migrations.ts";
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
}

/** The destructive statements the developer acknowledged at finalize. */
export interface DestructiveAcknowledgement {
  readonly acknowledged: true;
  /** `file` is relative to the migration folder, e.g. `schema-change.sql`. */
  readonly statements: readonly DestructiveStatement[];
}

/**
 * `onUnknownFile` reports the draft folder's unknown files before the rules,
 * the acknowledgement question and the rehearsal; finalize still copies them.
 */
export type FinalizeOptions = DestructiveOptions & UnknownDraftFileOptions;

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
  const rehearsed = await rehearseCurrentDraft(project, "finalize", {
    onUnknownFile: options.onUnknownFile,
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
  };
  const files: HashedFile[] = [
    ...(await readHashedFiles(root, paths.draft, target.fromDraft)),
    ...rehearsed.desiredSchema.map((file) => ({
      path: `${snapshotFolderName}/${file.path}`,
      text: file.text,
    })),
    { path: metadataFileName, text: `${JSON.stringify(metadata, null, 2)}\n` },
  ];
  const contentHash = target.contentHash(files);
  const entry = {
    folder: target.folder,
    contentHash,
    chainHash: chainHash(target.previousChainHash, contentHash),
  };

  // Written under a temporary name, then renamed, so a half-written folder
  // never looks like a migration or Recovery (validate reports a leftover one).
  const staging = join(dirname(path), `.finalizing-${target.folder}`);
  await rm(staging, { recursive: true, force: true });
  for (const file of files) {
    const written = join(staging, file.path);
    await mkdir(dirname(written), { recursive: true });
    await writeFile(written, file.text);
  }
  await makeReadOnly(staging);
  await rename(staging, path);

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
  };
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
      fromDraft: (path) =>
        path !== draftMetadataFileName && !isRecoveryPath(path),
      contentHash: (files) => migrationContentHash(folder, files),
      previousChainHash: rehearsed.migrations.at(-1)?.chainHash ?? "",
      indexed: (entries, entry) => [...entries, entry],
    };
  }
  // A Recovery holds the draft's scripts and seed data, never the schema
  // change (always its migration's) or a desired-schema snapshot.
  const number = migration.recoveries.length + 1;
  const folder = recoveryFolderName(number);
  const recoveries = join(migration.path, recoveriesFolderName);
  await mkdir(recoveries, { recursive: true });
  return {
    number,
    folder,
    path: join(recoveries, folder),
    fromDraft: (path) =>
      path !== draftMetadataFileName && path !== schemaChangeFileName,
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
