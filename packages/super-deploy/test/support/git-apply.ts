// `git apply` of a diff to a set of files, in a temp folder of its own: that
// git reads a desired-schema diff (ADR-0008) as super-deploy does. Also the
// file helpers it is built on, for tests that put a set of files on disk and
// read one back.
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { onTestFinished } from "vitest";

/** Files' texts by path, relative to their folder with forward slashes. */
export type Files = Readonly<Record<string, string>>;

/** Whether git is installed; tests of gitApply skip without it. */
export const gitInstalled = spawnSync("git", ["--version"]).status === 0;

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

/**
 * The files `git apply` makes of `files` with `diff` (which may be empty),
 * in a temp folder deleted when the test finishes. Throws with git's message
 * unless git applies it cleanly, with nothing on stderr. Whitespace in the
 * files' lines, such as a carriage return git counts as trailing, is theirs
 * to hold, not an error in the diff, so git doesn't warn about it.
 */
export async function gitApply(files: Files, diff: string): Promise<Files> {
  const dir = await mkdtemp(join(tmpdir(), "super-deploy-git-apply-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, files);
  // Outside a repository, git apply patches the files in its working directory.
  const applied = spawnSync(
    "git",
    ["apply", "--allow-empty", "--whitespace=nowarn", "-"],
    { cwd: dir, input: diff, encoding: "utf8" },
  );
  if (applied.status !== 0 || applied.stderr !== "") {
    throw new Error(
      `git apply failed with status ${applied.status}: ${applied.stderr}`,
    );
  }
  return readFiles(dir);
}
