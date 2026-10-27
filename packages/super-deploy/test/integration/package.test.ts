// What the published package contains: the files `pnpm pack` puts in the
// tarball, read from a dry run over the dist/ the integration globalSetup
// builds. npm and pnpm leave some files out of every package whatever
// `files` says (a .gitignore among them), so a template file under such a
// name would vanish from every project `init` makes from the published
// library, though the workspace's own copy of the template still has it.
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

const packageDir = join(import.meta.dirname, "..", "..");

function packedFiles(): string[] {
  // Through a shell: on Windows `pnpm` is a .cmd script, which only a shell
  // runs.
  const pack = spawnSync("pnpm pack --dry-run --json --ignore-scripts", {
    cwd: packageDir,
    encoding: "utf8",
    shell: true,
  });
  expect(pack.status, pack.stderr).toBe(0);
  const { files } = JSON.parse(pack.stdout) as {
    files: { path: string }[];
  };
  return files.map((file) => file.path);
}

test("every file of the bundled template is in the package", async () => {
  const template = join(packageDir, "dist", "template");
  const built = (
    await readdir(template, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(packageDir.length + 1)
        .split("\\")
        .join("/"),
    );
  expect(built).toContain("dist/template/package.json");

  const packed = new Set(packedFiles());
  expect(built.filter((file) => !packed.has(file))).toEqual([]);
});

test("the package carries its licence and README", () => {
  const packed = new Set(packedFiles());
  expect(
    ["LICENSE", "README.md", "package.json"].filter(
      (file) => !packed.has(file),
    ),
  ).toEqual([]);
});
