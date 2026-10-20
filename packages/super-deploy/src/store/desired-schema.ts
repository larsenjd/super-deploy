// The desired schema on disk: every *.sql file under the desired-schema
// folder (or a migration's snapshot of it), any names and folders. Files must
// be UTF-8 without a BOM, because finalize hashes them into the snapshot.
import { mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { SqlFile } from "../sql-analysis/parse.ts";
import { type HashedFile, normaliseLineEndings } from "./hashing.ts";
import { projectRelative } from "./layout.ts";
import { listFiles, readHashedFiles } from "./migrations.ts";

export function isSqlFile(path: string): boolean {
  return path.toLowerCase().endsWith(".sql");
}

/** Every *.sql file under `folder`, with paths relative to it, sorted. */
export function readDesiredSchemaFiles(
  root: string,
  folder: string,
): Promise<HashedFile[]> {
  return readHashedFiles(root, folder, isSqlFile);
}

/** The same files as SQL analysis input, with project-relative paths. */
export function asSqlFiles(
  root: string,
  folder: string,
  files: readonly HashedFile[],
): SqlFile[] {
  return files.map((file) => ({
    path: projectRelative(root, join(folder, file.path)),
    text: file.text,
  }));
}

/** Every *.sql file under the desired-schema folder, with project-relative paths, sorted. */
export async function readDesiredSchema(
  root: string,
  folder: string,
): Promise<SqlFile[]> {
  return asSqlFiles(root, folder, await readDesiredSchemaFiles(root, folder));
}

/** How the desired-schema folder differs from a snapshot (paths relative to the folder, sorted). */
export interface SnapshotDifferences {
  /** Snapshot files that are missing or different (line endings aside) in the folder. */
  readonly restore: readonly string[];
  /** *.sql files in the folder that the snapshot doesn't have. */
  readonly delete: readonly string[];
}

/**
 * Compares the desired-schema folder with a snapshot. Lenient about the
 * folder's encoding (a file with a BOM simply differs), since this is used to
 * overwrite it.
 */
export async function differencesFromSnapshot(
  folder: string,
  snapshot: readonly HashedFile[],
): Promise<SnapshotDifferences> {
  const current = new Map<string, string>();
  for (const path of (await listFiles(folder)).filter(isSqlFile)) {
    current.set(path, await readFile(join(folder, path), "utf8"));
  }
  const restore = snapshot
    .filter((file) => {
      const text = current.get(file.path);
      return (
        text === undefined ||
        normaliseLineEndings(text) !== normaliseLineEndings(file.text)
      );
    })
    .map((file) => file.path);
  const inSnapshot = new Set(snapshot.map((file) => file.path));
  const remove = [...current.keys()].filter((path) => !inSnapshot.has(path));
  return { restore: restore.sort(), delete: remove.sort() };
}

/**
 * Makes the desired-schema folder match the snapshot: writes the files in
 * `differences.restore`, deletes those in `differences.delete` (and folders
 * left empty by that). Other files (non-SQL) are left alone.
 */
export async function restoreFromSnapshot(
  folder: string,
  snapshot: readonly HashedFile[],
  differences: SnapshotDifferences,
): Promise<void> {
  const restore = new Set(differences.restore);
  for (const file of snapshot.filter((f) => restore.has(f.path))) {
    const target = join(folder, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
  for (const path of differences.delete) {
    await rm(join(folder, path), { force: true });
    for (
      let dir = dirname(join(folder, path));
      dir.startsWith(`${folder}${sep}`);
    ) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
}
