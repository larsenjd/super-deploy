// The integrity check of the finalized migrations and their Recoveries:
// index, folder names, numbering, each folder's files, content hashes and the
// hash chains. `validate` reports its findings; every command that builds on
// the migrations (draft, rehearse, finalize) refuses to run while it finds
// errors.
//
// Each migration and Recovery folder holds only the files finalize writes
// there (migrationFiles, recoveryFiles, built from the store's file-name
// constants). An entry it can't have (UnknownMigrationFileError) or a file it
// must have and lacks (MissingMigrationFileError) is found before its content
// hash is compared, and that hash is then skipped: it covers the whole folder,
// so it could only say that something changed, not which file. Commands
// throw the first such error itself (verifiedMigrations), ahead of
// MigrationIntegrityError; validate lists each one.

import { join } from "node:path";
import { joined, SuperDeployError } from "../errors.ts";
import { handEditReportFileName } from "./hand-edit.ts";
import {
  chainHash,
  InvalidEncodingError,
  migrationContentHash,
  recoveryContentHash,
} from "./hashing.ts";
import { type ProjectPaths, projectRelative } from "./layout.ts";
import {
  deployTimeFileKinds,
  type FinalizedMigration,
  type FinalizedRecovery,
  type IndexEntry,
  indexFileName,
  isRecoveryPath,
  metadataFileName,
  parseMigrationFolderName,
  parseRecoveryFolderName,
  readFolder,
  readHashedFiles,
  readIndex,
  recoveriesFolderName,
  recoveryFileNames,
  schemaChangeFileName,
  snapshotDiffFileName,
} from "./migrations.ts";

export interface IntegrityReport {
  /** The migrations as recorded in the index, in order (trust them only when `problems` is empty). */
  readonly migrations: readonly FinalizedMigration[];
  /** Errors only. */
  readonly problems: readonly ValidationProblem[];
  /** The unknown and missing files among `problems`, as errors. */
  readonly fileErrors: readonly MigrationFileError[];
}

export async function checkMigrations(
  root: string,
  paths: ProjectPaths,
): Promise<IntegrityReport> {
  const problems: ValidationProblem[] = [];
  const fileErrors: MigrationFileError[] = [];
  const problem: Problem = (code, message, path) => {
    problems.push({
      severity: "error",
      code,
      message,
      ...(path === undefined ? {} : { path }),
    });
  };
  /** Reports each of a folder's file errors; true if it has none. */
  const holdsItsFiles = (errors: readonly MigrationFileError[]) => {
    for (const error of errors) {
      fileErrors.push(error);
      problem(error.code, error.message, error.file);
    }
    return errors.length === 0;
  };
  const display = (absolute: string) => projectRelative(root, absolute);
  const indexPath = display(join(paths.migrations, indexFileName));

  const index = await readIndex(paths);
  if (!index.ok) {
    problem("index-invalid", `${indexPath} ${index.reason}`, indexPath);
    return { migrations: [], problems, fileErrors };
  }

  // What is on disk.
  const entries = await readFolder(paths.migrations);
  const onDisk = new Map<number, string>();
  for (const entry of entries) {
    const path = display(join(paths.migrations, entry.name));
    if (entry.name === indexFileName && entry.isFile()) {
      continue;
    }
    const parsed = entry.isDirectory()
      ? parseMigrationFolderName(entry.name)
      : undefined;
    if (parsed === undefined) {
      problem(
        entry.isDirectory() ? "invalid-folder-name" : "unexpected-entry",
        entry.isDirectory()
          ? `${path} is not a migration folder name (five-digit number, hyphen, kebab-case name)`
          : `${path} does not belong in the migrations folder`,
        path,
      );
    } else if (onDisk.has(parsed.number)) {
      problem(
        "invalid-folder-name",
        `${path} reuses migration number ${parsed.number}`,
        path,
      );
    } else {
      onDisk.set(parsed.number, entry.name);
    }
  }

  const migrations: FinalizedMigration[] = [];
  let previousChain = "";
  for (const [position, entry] of index.entries.entries()) {
    const expectedNumber = position + 1;
    const parsed = parseMigrationFolderName(entry.folder);
    if (parsed === undefined || parsed.number !== expectedNumber) {
      problem(
        "index-invalid",
        `${indexPath} entry ${expectedNumber} names ${JSON.stringify(entry.folder)}, expected migration ${expectedNumber}`,
        indexPath,
      );
      return { migrations, problems, fileErrors };
    }
    const path = join(paths.migrations, entry.folder);
    const recoveries: FinalizedRecovery[] = [];
    migrations.push({
      ...parsed,
      folder: entry.folder,
      path,
      ...hashes(entry),
      recoveries,
    });

    const expectedChain = chainHash(previousChain, entry.contentHash);
    if (entry.chainHash !== expectedChain) {
      problem(
        "chain-hash-mismatch",
        `${indexPath}: the chain hash of ${entry.folder} does not follow from the migrations before it`,
        indexPath,
      );
    }
    previousChain = entry.chainHash;

    const actualFolder = onDisk.get(parsed.number);
    onDisk.delete(parsed.number);
    if (actualFolder === undefined) {
      problem(
        "migration-missing",
        `${display(path)} is missing`,
        display(path),
      );
      continue;
    }
    if (actualFolder !== entry.folder) {
      const renamed = display(join(paths.migrations, actualFolder));
      problem(
        "migration-renamed",
        `Migration ${parsed.number} was renamed from ${entry.folder} to ${actualFolder}; finalized migrations never change`,
        renamed,
      );
      continue;
    }
    if (holdsItsFiles(await migrationFileErrors(root, path, migrationFiles))) {
      await checkContentHash(
        display(path),
        indexPath,
        problem,
        async () =>
          migrationContentHash(
            entry.folder,
            await readHashedFiles(root, path, (file) => !isRecoveryPath(file)),
          ) === entry.contentHash,
      );
    }
    recoveries.push(
      ...(await checkRecoveries(
        root,
        entry,
        path,
        indexPath,
        problem,
        holdsItsFiles,
      )),
    );
  }

  for (const [, folder] of [...onDisk].sort(([a], [b]) => a - b)) {
    const path = display(join(paths.migrations, folder));
    problem(
      "migration-unindexed",
      `${path} is not in ${indexPath}; migrations are only created by finalize`,
      path,
    );
  }
  return { migrations, problems, fileErrors };
}

type Problem = (code: string, message: string, path?: string) => void;

/** The files a finalized folder of one kind holds: every file it can have, and those it must. */
interface FolderFiles {
  /** `migration` or `Recovery`, for messages. */
  readonly kind: string;
  readonly allowed: readonly string[];
  readonly required: readonly string[];
  /** A subfolder it can have, checked on its own (a migration's Recoveries). */
  readonly subfolder?: string;
}

/**
 * A migration's files: those finalize writes. Every deploy-time file and
 * seed data come from the store's own list, so a new deploy-time file kind
 * is allowed here with no second list.
 */
const migrationFiles: FolderFiles = {
  kind: "migration",
  allowed: [
    ...Object.keys(deployTimeFileKinds),
    metadataFileName,
    snapshotDiffFileName,
    handEditReportFileName,
  ],
  required: [schemaChangeFileName, metadataFileName, snapshotDiffFileName],
  subfolder: recoveriesFolderName,
};

/** A Recovery's files: the ones it replaces, and its metadata. */
const recoveryFiles: FolderFiles = {
  kind: "Recovery",
  allowed: [...recoveryFileNames, metadataFileName],
  required: [metadataFileName],
};

/**
 * Each entry of a finalized `folder` it can't have (dotfiles, stray notes and
 * folders such as a 0.3.0 snapshot folder included), then each file it must
 * have and doesn't, in name order. Checked before the content hash, which
 * covers the whole folder and so can't say which file is wrong.
 */
async function migrationFileErrors(
  root: string,
  folder: string,
  files: FolderFiles,
): Promise<MigrationFileError[]> {
  const entries = (await readFolder(folder)).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const shown = (name: string) => projectRelative(root, join(folder, name));
  const holds = [
    ...files.allowed,
    ...(files.subfolder === undefined ? [] : [`its ${files.subfolder} folder`]),
  ];
  const errors: MigrationFileError[] = entries
    .filter((entry) =>
      entry.isDirectory()
        ? entry.name !== files.subfolder
        : !(entry.isFile() && files.allowed.includes(entry.name)),
    )
    .map(
      (entry) =>
        new UnknownMigrationFileError(shown(entry.name), files.kind, holds),
    );
  for (const name of files.required) {
    if (!entries.some((entry) => entry.isFile() && entry.name === name)) {
      errors.push(new MissingMigrationFileError(shown(name), files.kind));
    }
  }
  return errors;
}

/**
 * Reports a finalized folder (`shownPath`) whose files no longer hash to what
 * the index records (`matches` resolves false), or that holds a file that
 * isn't valid UTF-8. The mismatch gives the way back: Git, then `validate`,
 * which makes the restored files read-only again. The hash covers the whole
 * folder, so it can't say which file changed or was added.
 */
async function checkContentHash(
  shownPath: string,
  indexPath: string,
  problem: Problem,
  matches: () => Promise<boolean>,
): Promise<void> {
  try {
    if (!(await matches())) {
      problem(
        "content-hash-mismatch",
        `${shownPath} was changed after it was finalized (its content hash does not match ${indexPath}): restore it from Git (\`git checkout HEAD -- ${shownPath}\`, and delete any file added to it), then run validate, which makes it read-only again. To change what a finalized migration does, finalize a new migration, or a Recovery for the targets where it failed`,
        shownPath,
      );
    }
  } catch (error) {
    if (!(error instanceof InvalidEncodingError)) {
      throw error;
    }
    problem("invalid-encoding", error.message, error.file);
  }
}

/**
 * A migration's Recoveries: the index's entries against the folders under
 * `<migration>/recoveries/`, their content hashes and their chain (which
 * starts from the migration's chain hash). Problems go to `problem`.
 */
async function checkRecoveries(
  root: string,
  entry: IndexEntry,
  migrationPath: string,
  indexPath: string,
  problem: Problem,
  holdsItsFiles: (errors: readonly MigrationFileError[]) => boolean,
): Promise<FinalizedRecovery[]> {
  const display = (absolute: string) => projectRelative(root, absolute);
  const folder = join(migrationPath, recoveriesFolderName);
  const entries = await readFolder(folder);
  const onDisk = new Set<string>();
  for (const dirent of entries) {
    const path = display(join(folder, dirent.name));
    if (!dirent.isDirectory()) {
      problem(
        "unexpected-entry",
        `${path} does not belong in a recoveries folder`,
        path,
      );
    } else if (parseRecoveryFolderName(dirent.name) === undefined) {
      problem(
        "invalid-folder-name",
        `${path} is not a Recovery folder name (recovery-<number>)`,
        path,
      );
    } else {
      onDisk.add(dirent.name);
    }
  }

  const recoveries: FinalizedRecovery[] = [];
  let previousChain = entry.chainHash;
  for (const [position, recovery] of (entry.recoveries ?? []).entries()) {
    const number = position + 1;
    if (parseRecoveryFolderName(recovery.folder) !== number) {
      problem(
        "index-invalid",
        `${indexPath}: Recovery ${number} of ${entry.folder} names ${JSON.stringify(recovery.folder)}, expected recovery-${number}`,
        indexPath,
      );
      return recoveries;
    }
    const path = join(folder, recovery.folder);
    recoveries.push({
      number,
      folder: recovery.folder,
      path,
      ...hashes(recovery),
    });
    if (recovery.chainHash !== chainHash(previousChain, recovery.contentHash)) {
      problem(
        "chain-hash-mismatch",
        `${indexPath}: the chain hash of ${entry.folder} Recovery ${number} does not follow from the migration and the Recoveries before it`,
        indexPath,
      );
    }
    previousChain = recovery.chainHash;
    if (!onDisk.delete(recovery.folder)) {
      problem(
        "migration-missing",
        `${display(path)} is missing`,
        display(path),
      );
      continue;
    }
    if (holdsItsFiles(await migrationFileErrors(root, path, recoveryFiles))) {
      await checkContentHash(
        display(path),
        indexPath,
        problem,
        async () =>
          recoveryContentHash(
            entry.folder,
            recovery.folder,
            await readHashedFiles(root, path),
          ) === recovery.contentHash,
      );
    }
  }
  for (const name of [...onDisk].sort()) {
    const path = display(join(folder, name));
    problem(
      "migration-unindexed",
      `${path} is not in ${indexPath}; Recoveries are only created by finalize`,
      path,
    );
  }
  return recoveries;
}

/**
 * The finalized migrations. If the check finds anything wrong, throws the
 * first unknown or missing file (UnknownMigrationFileError,
 * MissingMigrationFileError), else MigrationIntegrityError.
 */
export async function verifiedMigrations(
  root: string,
  paths: ProjectPaths,
): Promise<readonly FinalizedMigration[]> {
  const report = await checkMigrations(root, paths);
  const [fileError] = report.fileErrors;
  if (fileError !== undefined) {
    throw fileError;
  }
  if (report.problems.length > 0) {
    throw new MigrationIntegrityError(report.problems);
  }
  return report.migrations;
}

function hashes(entry: { contentHash: string; chainHash: string }) {
  return { contentHash: entry.contentHash, chainHash: entry.chainHash };
}

/** A notice never fails `validate`, even under `--strict`. */
export type ValidationSeverity = "error" | "warning" | "notice";

/** One finding of `validate` (or of the integrity check other commands run first). */
export interface ValidationProblem {
  readonly severity: ValidationSeverity;
  /**
   * Stable identifier: `index-invalid`, `invalid-folder-name`,
   * `unexpected-entry`, `migration-missing`, `migration-unindexed`,
   * `migration-renamed`, `numbering-gap`, `invalid-encoding`,
   * `unknown-migration-file`, `missing-migration-file`,
   * `content-hash-mismatch`, `chain-hash-mismatch`, `sql-rule-violation`,
   * `recovery-schema-change-edited`, `unknown-migration` (errors);
   * `unfinalized-draft`, `unknown-draft-file`, `undrafted-changes`,
   * `unqualified-routine-names` (warnings); `hand-edited-schema-change`
   * (notices).
   */
  readonly code: string;
  readonly message: string;
  /** Project-relative path with forward slashes, when the problem has one. */
  readonly path?: string;
  /**
   * For `sql-rule-violation`: the 1-based line and the rule id; for
   * `unqualified-routine-names`, the line.
   */
  readonly line?: number;
  readonly rule?: string;
}

export function summarise(problems: readonly ValidationProblem[]): string {
  const [first] = problems;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return `${first?.message ?? ""}${more}`;
}

/** The finalized migrations failed their integrity check, so nothing builds on them. */
export class MigrationIntegrityError extends SuperDeployError {
  readonly code = "migration-integrity";
  readonly problems: readonly ValidationProblem[];

  constructor(problems: readonly ValidationProblem[]) {
    super(`The finalized migrations failed validation: ${summarise(problems)}`);
    this.problems = problems;
  }
}

/** A finalized migration or Recovery folder holds an entry it can't have. */
export class UnknownMigrationFileError extends SuperDeployError {
  readonly code = "unknown-migration-file";
  /** Project-relative path with forward slashes. */
  readonly file: string;

  constructor(file: string, kind: string, holds: readonly string[]) {
    super(
      `${file} does not belong in a finalized ${kind}, which holds only ${joined(holds)}: move it out of the folder, then run validate`,
    );
    this.file = file;
  }
}

/** A finalized migration or Recovery folder lacks a file it must have. */
export class MissingMigrationFileError extends SuperDeployError {
  readonly code = "missing-migration-file";
  /** Project-relative path with forward slashes. */
  readonly file: string;

  constructor(file: string, kind: string) {
    super(
      `${file} is missing; every ${kind} has one, as finalize writes it: restore it from Git (\`git checkout HEAD -- ${file}\`), then run validate`,
    );
    this.file = file;
  }
}

/** An entry of a finalized folder that is unknown or missing. */
export type MigrationFileError =
  | UnknownMigrationFileError
  | MissingMigrationFileError;
