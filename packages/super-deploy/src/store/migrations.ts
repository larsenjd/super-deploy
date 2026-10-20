// Finalized migrations on disk:
//
//   <directory>/migrations/
//     index.json                    the hash-chain index (writable; rewritten by finalize)
//     00001-add-customers/          five-digit number, hyphen, kebab-case name
//       pre-migration.sql           (optional) hand-written, runs before the schema change
//       schema-change.sql           every file copied from the draft except draft.json
//       post-migration.sql          (optional) hand-written, runs after the schema change
//       seed-data.sql               (optional) the draft's seed data, frozen as an audit record
//       metadata.json               tool, differ, parser and rehearsal server versions
//       desired-schema/**/*.sql     snapshot of the desired schema at finalize
//
// Every file inside a migration folder is read-only and covered by the
// folder's content hash (store/hashing.ts).
import { constants, type Dirent } from "node:fs";
import {
  access,
  chmod,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { DeployTimeKind } from "../sql-analysis/deploy-time.ts";
import { maxDraftNameLength } from "./draft-name.ts";
import { decodeHashedText, type HashedFile } from "./hashing.ts";
import { type ProjectPaths, projectRelative } from "./layout.ts";

export const indexFileName = "index.json";
export const metadataFileName = "metadata.json";
export const schemaChangeFileName = "schema-change.sql";
/** Hand-written SQL run before the schema change (and before `draft` diffs). */
export const preMigrationFileName = "pre-migration.sql";
/** Hand-written SQL run after the schema change: data only. */
export const postMigrationFileName = "post-migration.sql";
/**
 * A draft's seed data: INSERTs that reproduce a target's problem data. Loaded
 * just before the pre-migration script in rehearsals of its own draft only
 * (rehearsal/seed-data.ts); frozen with the migration at finalize, and never
 * loaded again.
 */
export const seedDataFileName = "seed-data.sql";
/** The desired-schema snapshot inside each migration folder. */
export const snapshotFolderName = "desired-schema";
/**
 * The deploy-time SQL files of a migration, in the order they run; each is
 * optional except the schema change. Seed data is not here: it never runs
 * when migrations are replayed or deployed. A Recovery (ticket 17)
 * replaces the two scripts and keeps the schema change.
 */
export const deployTimeFileNames: readonly string[] = [
  preMigrationFileName,
  schemaChangeFileName,
  postMigrationFileName,
];

/** The rule set (file kind) each deploy-time file, and seed data, is checked against. */
export const deployTimeFileKinds: Readonly<Record<string, DeployTimeKind>> = {
  [preMigrationFileName]: "pre-migration",
  [schemaChangeFileName]: "schema-change",
  [postMigrationFileName]: "post-migration",
  [seedDataFileName]: "seed-data",
};

export const maxMigrationNumber = 99_999;

/** One entry of index.json, in migration order. */
export interface IndexEntry {
  readonly folder: string;
  readonly contentHash: string;
  readonly chainHash: string;
}

export interface FinalizedMigration {
  readonly number: number;
  readonly name: string;
  /** The folder name, e.g. `00001-add-customers`. */
  readonly folder: string;
  /** Absolute path of the folder. */
  readonly path: string;
  readonly contentHash: string;
  readonly chainHash: string;
}

/** `00001-add-customers` from 1 and `add-customers`. */
export function migrationFolderName(number: number, name: string): string {
  return `${String(number).padStart(5, "0")}-${name}`;
}

/** The number and name in a migration folder name, or undefined if it isn't one. */
export function parseMigrationFolderName(
  folder: string,
): { number: number; name: string } | undefined {
  const match = /^(\d{5})-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(folder);
  if (match === null) {
    return undefined;
  }
  const [, digits = "", name = ""] = match;
  const number = Number(digits);
  if (number < 1 || name.length > maxDraftNameLength) {
    return undefined;
  }
  return { number, name };
}

export type IndexReadResult =
  | { readonly ok: true; readonly entries: readonly IndexEntry[] }
  | { readonly ok: false; readonly reason: string };

/** Reads index.json; a missing file is an empty index. */
export async function readIndex(paths: ProjectPaths): Promise<IndexReadResult> {
  let text: string;
  try {
    text = await readFile(join(paths.migrations, indexFileName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, entries: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `is not valid JSON (${(error as Error).message})`,
    };
  }
  const migrations =
    typeof parsed === "object" && parsed !== null && "migrations" in parsed
      ? parsed.migrations
      : undefined;
  if (!Array.isArray(migrations)) {
    return { ok: false, reason: 'has no "migrations" array' };
  }
  const entries: IndexEntry[] = [];
  for (const [position, entry] of migrations.entries()) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.folder !== "string" ||
      typeof entry.contentHash !== "string" ||
      typeof entry.chainHash !== "string"
    ) {
      return {
        ok: false,
        reason: `entry ${position + 1} needs string "folder", "contentHash" and "chainHash"`,
      };
    }
    entries.push({
      folder: entry.folder,
      contentHash: entry.contentHash,
      chainHash: entry.chainHash,
    });
  }
  return { ok: true, entries };
}

export async function writeIndex(
  paths: ProjectPaths,
  entries: readonly IndexEntry[],
): Promise<void> {
  const migrations = entries.map(({ folder, contentHash, chainHash }) => ({
    folder,
    contentHash,
    chainHash,
  }));
  await writeFile(
    join(paths.migrations, indexFileName),
    `${JSON.stringify({ migrations }, null, 2)}\n`,
  );
}

/** Paths (relative to `folder`, forward slashes, sorted) of every file under it. */
export async function listFiles(folder: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => projectRelative(folder, join(entry.parentPath, entry.name)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Reads every file under `folder` for hashing (UTF-8 without BOM, or
 * InvalidEncodingError naming the file relative to `root`).
 */
export async function readHashedFiles(
  root: string,
  folder: string,
  include: (path: string) => boolean = () => true,
): Promise<HashedFile[]> {
  const files: HashedFile[] = [];
  for (const path of (await listFiles(folder)).filter(include)) {
    const absolute = join(folder, path);
    files.push({
      path,
      text: decodeHashedText(
        await readFile(absolute),
        projectRelative(root, absolute),
      ),
    });
  }
  return files;
}

/** Makes every file under `folder` read-only (on Windows this sets the read-only attribute). */
export async function makeReadOnly(folder: string): Promise<void> {
  for (const path of await listFiles(folder)) {
    const absolute = join(folder, path);
    await chmod(absolute, (await stat(absolute)).mode & 0o777 & ~0o222);
  }
}

/** Makes every file under `folder` writable again (for unfinalize). */
export async function makeWritable(folder: string): Promise<void> {
  for (const path of await listFiles(folder)) {
    const absolute = join(folder, path);
    await chmod(absolute, ((await stat(absolute)).mode & 0o777) | 0o200);
  }
}

/** Paths (relative to `folder`) of files under it that are writable. */
export async function writableFiles(folder: string): Promise<string[]> {
  const writable: string[] = [];
  for (const path of await listFiles(folder)) {
    const mode = (await stat(join(folder, path))).mode;
    if ((mode & 0o222) !== 0) {
      writable.push(path);
    }
  }
  return writable;
}

/** True if `path` exists. */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
