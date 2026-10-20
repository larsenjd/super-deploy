import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SqlFile } from "../sql-analysis/parse.ts";
import { projectRelative } from "./layout.ts";

/** Every *.sql file under the desired-schema folder, sorted by project-relative path. */
export async function readDesiredSchema(
  root: string,
  folder: string,
): Promise<SqlFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(folder, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files: SqlFile[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".sql")) {
      const absolute = join(entry.parentPath, entry.name);
      files.push({
        path: projectRelative(root, absolute),
        text: await readFile(absolute, "utf8"),
      });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
