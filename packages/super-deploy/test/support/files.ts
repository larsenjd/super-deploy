// A set of files as tests write and read them: texts by path, put on disk
// under a folder and read back from one.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/** Files' texts by path, relative to their folder with forward slashes. */
export type Files = Readonly<Record<string, string>>;

/** Writes each of `files` at its path under `folder`, creating folders as needed. */
export async function writeFiles(folder: string, files: Files): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
}

/** Every file under `folder`, by path relative to it with forward slashes. */
export async function readFiles(folder: string): Promise<Files> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[relative(folder, path).split(sep).join("/")] = await readFile(
        path,
        "utf8",
      );
    }
  }
  return files;
}
