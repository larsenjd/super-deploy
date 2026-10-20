// CLI seam for init, end to end: `super-deploy init` in an empty folder, then
// the template's own precommit checks and draft, finalize and deploy to dev,
// all through the real binary with the scaffolded config loaded natively.
//
// Installing: tests run offline, so instead of `pnpm install` the project's
// node_modules links each devDependency to the copy the workspace's template
// package already has installed (super-deploy itself to this package, whose
// dist/ the integration globalSetup builds). The test checks that every
// linked copy has exactly the version the project's package.json pins, so
// this matches a real install.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { runCli } from "../support/cli.ts";

const packageDir = join(import.meta.dirname, "..", "..");
const templateDir = join(packageDir, "..", "template");

async function emptyDirectory(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "super-deploy-test-cli-init-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "shop");
  await mkdir(root);
  return root;
}

/** Links every devDependency of the project at `root` into its node_modules (see the header). */
async function linkDependencies(root: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  for (const [name, spec] of Object.entries<string>(manifest.devDependencies)) {
    const installed =
      name === "super-deploy"
        ? packageDir
        : realpathSync(join(templateDir, "node_modules", ...name.split("/")));
    if (name !== "super-deploy") {
      const { version } = JSON.parse(
        await readFile(join(installed, "package.json"), "utf8"),
      );
      expect(`${name}@${spec}`).toBe(`${name}@${version}`);
    }
    const link = join(root, "node_modules", ...name.split("/"));
    await mkdir(dirname(link), { recursive: true });
    await symlink(installed, link, "junction");
  }
}

/** Runs a devDependency's bin script (by path within its package) in `root`. */
function runTool(root: string, bin: string, args: readonly string[]) {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules", ...bin.split("/")), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } },
  );
  return {
    exitCode: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe("init", () => {
  test("a freshly initialised project passes its precommit checks, then drafts, finalizes and deploys to dev", async () => {
    const root = await emptyDirectory();
    const initialised = await runCli(["init"], { cwd: root });
    expect(initialised).toMatchObject({ exitCode: 0, stderr: "" });
    expect(initialised.stdout).toMatch(
      /^Initialised a super-deploy project in \.\n/,
    );
    await linkDependencies(root);

    // The template's precommit: biome check && tsc --noEmit && super-deploy validate --strict
    expect(runTool(root, "@biomejs/biome/bin/biome", ["check"])).toMatchObject({
      exitCode: 0,
    });
    expect(runTool(root, "typescript/bin/tsc", ["--noEmit"])).toMatchObject({
      exitCode: 0,
      output: "",
    });
    expect(await runCli(["validate", "--strict"], { cwd: root })).toMatchObject(
      {
        exitCode: 0,
        stdout: "Validated 0 migrations\n",
      },
    );

    await writeFile(
      join(root, "data-model", "desired-schema", "customers.sql"),
      "create table customers (id bigint primary key, name text not null);\n",
    );
    for (const args of [["draft", "--name", "add customers"], ["finalize"]]) {
      expect(await runCli(args, { cwd: root })).toMatchObject({ exitCode: 0 });
    }
    expect(
      await runCli(["deploy", "--target", "dev"], { cwd: root }),
    ).toMatchObject({
      exitCode: 0,
      stdout: "Deployed 1 migration to dev: 00001-add-customers\n",
    });
    expect(await runCli(["validate", "--strict"], { cwd: root })).toMatchObject(
      {
        exitCode: 0,
        stdout: "Validated 1 migration\n",
      },
    );
    expect(runTool(root, "@biomejs/biome/bin/biome", ["check"])).toMatchObject({
      exitCode: 0,
    });
  });

  test.skipIf(process.platform === "win32")(
    "once it is a Git repo and its dependencies are installed, a commit runs pnpm precommit",
    async () => {
      const root = await emptyDirectory();
      expect(await runCli(["init"], { cwd: root })).toMatchObject({
        exitCode: 0,
      });
      await linkDependencies(root);
      // A stand-in pnpm that records how it was called and fails, so the
      // commit only succeeds if the hook never ran it.
      const bin = join(root, "..", "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "pnpm"),
        `#!/bin/sh\necho "$@" > "${join(root, "..", "pnpm-args")}"\nexit 1\n`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith("GIT_") && name !== "HUSKY",
          ),
        ),
        PATH: `${bin}:${process.env.PATH}`,
      };
      const run = (command: string, args: readonly string[]) =>
        spawnSync(command, args, { cwd: root, encoding: "utf8", env });

      expect(run("git", ["init", "--quiet"]).status).toBe(0);
      // What `pnpm install` runs: the project's prepare script.
      const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      expect(manifest.scripts.prepare).toBe("husky");
      expect(runTool(root, "husky/bin.js", [])).toMatchObject({ exitCode: 0 });
      expect(run("git", ["add", "-A"]).status).toBe(0);
      const commit = run("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "init",
      ]);

      expect(commit.status).not.toBe(0);
      expect(
        (await readFile(join(root, "..", "pnpm-args"), "utf8")).trim(),
      ).toBe("precommit");
    },
  );

  test("refuses to overwrite existing files (exit 1)", async () => {
    const root = await emptyDirectory();
    await writeFile(join(root, "package.json"), "{}\n");
    const result = await runCli(["init"], { cwd: root });
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toMatch(
      /^Error: Cannot initialise a project in \S*shop: it already has package\.json\n$/,
    );
  });

  test("is listed under Start", async () => {
    const help = await runCli(["--help"], { cwd: await emptyDirectory() });
    expect(help.stdout).toMatch(/\nStart:\n {2}init {2,}\S/);
  });
});
