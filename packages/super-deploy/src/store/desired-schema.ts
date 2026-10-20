// The desired schema on disk: every *.sql file under the desired-schema
// folder (or a migration's snapshot of it), any names and folders. Files must
// be UTF-8 without a BOM, because finalize hashes them into the snapshot.
import { join } from "node:path";
import type { SqlFile } from "../sql-analysis/parse.ts";
import type { HashedFile } from "./hashing.ts";
import { projectRelative } from "./layout.ts";
import { readHashedFiles } from "./migrations.ts";

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
