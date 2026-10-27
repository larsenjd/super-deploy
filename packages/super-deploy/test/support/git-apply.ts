// `git apply` of a diff to a set of files, in a temp folder of its own: that
// git reads a desired-schema diff (ADR-0008) as super-deploy does.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { type Files, readFiles, writeFiles } from "./files.ts";

/** Whether git is installed; tests of gitApply skip without it. */
export const gitInstalled = spawnSync("git", ["--version"]).status === 0;

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
  // It still converts line endings as `core.autocrlf` says (true in Git for
  // Windows' system config), so that is turned off: the files are compared
  // byte for byte.
  const applied = spawnSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "apply",
      "--allow-empty",
      "--whitespace=nowarn",
      "-",
    ],
    { cwd: dir, input: diff, encoding: "utf8" },
  );
  if (applied.status !== 0 || applied.stderr !== "") {
    throw new Error(
      `git apply failed with status ${applied.status}: ${applied.stderr}`,
    );
  }
  return readFiles(dir);
}
