// The integrity check of the finalized migrations: index, folder names,
// numbering, content hashes and the hash chain. `validate` reports its
// findings; every command that builds on the migrations (draft, rehearse,
// finalize) refuses to run while it finds errors.
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  InvalidEncodingError,
  MigrationIntegrityError,
  type ValidationProblem,
} from "../errors.ts";
import { chainHash, migrationContentHash } from "./hashing.ts";
import { type ProjectPaths, projectRelative } from "./layout.ts";
import {
  type FinalizedMigration,
  indexFileName,
  parseMigrationFolderName,
  readHashedFiles,
  readIndex,
} from "./migrations.ts";

export interface IntegrityReport {
  /** The migrations as recorded in the index, in order (trust them only when `problems` is empty). */
  readonly migrations: readonly FinalizedMigration[];
  /** Errors only. */
  readonly problems: readonly ValidationProblem[];
}

export async function checkMigrations(
  root: string,
  paths: ProjectPaths,
): Promise<IntegrityReport> {
  const problems: ValidationProblem[] = [];
  const problem = (code: string, message: string, path?: string) => {
    problems.push({
      severity: "error",
      code,
      message,
      ...(path === undefined ? {} : { path }),
    });
  };
  const display = (absolute: string) => projectRelative(root, absolute);
  const indexPath = display(join(paths.migrations, indexFileName));

  const index = await readIndex(paths);
  if (!index.ok) {
    problem("index-invalid", `${indexPath} ${index.reason}`, indexPath);
    return { migrations: [], problems };
  }

  // What is on disk.
  let entries: Dirent[] = [];
  try {
    entries = await readdir(paths.migrations, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
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
      return { migrations, problems };
    }
    const path = join(paths.migrations, entry.folder);
    migrations.push({
      ...parsed,
      folder: entry.folder,
      path,
      ...hashes(entry),
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
    try {
      const files = await readHashedFiles(root, path);
      if (migrationContentHash(entry.folder, files) !== entry.contentHash) {
        problem(
          "content-hash-mismatch",
          `${display(path)} was changed after it was finalized (its content hash does not match ${indexPath})`,
          display(path),
        );
      }
    } catch (error) {
      if (!(error instanceof InvalidEncodingError)) {
        throw error;
      }
      problem("invalid-encoding", error.message, error.file);
    }
  }

  for (const [, folder] of [...onDisk].sort(([a], [b]) => a - b)) {
    const path = display(join(paths.migrations, folder));
    problem(
      "migration-unindexed",
      `${path} is not in ${indexPath}; migrations are only created by finalize`,
      path,
    );
  }
  return { migrations, problems };
}

/** The finalized migrations, or MigrationIntegrityError if the check finds anything wrong. */
export async function verifiedMigrations(
  root: string,
  paths: ProjectPaths,
): Promise<readonly FinalizedMigration[]> {
  const report = await checkMigrations(root, paths);
  if (report.problems.length > 0) {
    throw new MigrationIntegrityError(report.problems);
  }
  return report.migrations;
}

function hashes(entry: { contentHash: string; chainHash: string }) {
  return { contentHash: entry.contentHash, chainHash: entry.chainHash };
}
