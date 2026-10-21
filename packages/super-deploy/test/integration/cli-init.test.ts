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
import { cliPath, runCli } from "../support/cli.ts";

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

/** This process's environment without Git's and Husky's own variables (as when run from a hook). */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("GIT_") && name !== "HUSKY",
    ),
  );
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
    const [first, next] = initialised.stdout.split("\n");
    expect(first).toBe(
      `Initialised a super-deploy project in ${realpathSync(root)}`,
    );
    // Not a Git repo yet: Git first, so that pnpm install installs the hook.
    expect(next).toMatch(/^Next: git init, then pnpm install\b/);
    await linkDependencies(root);

    // The template's precommit: biome check && tsc --noEmit && super-deploy validate --strict --allow-draft
    expect(runTool(root, "@biomejs/biome/bin/biome", ["check"])).toMatchObject({
      exitCode: 0,
    });
    expect(runTool(root, "typescript/bin/tsc", ["--noEmit"])).toMatchObject({
      exitCode: 0,
      output: "",
    });
    expect(
      await runCli(["validate", "--strict", "--allow-draft"], { cwd: root }),
    ).toMatchObject({
      exitCode: 0,
      stdout: "Validated 0 migrations\n",
    });

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
      stderr: "",
    });
    expect(
      await runCli(["status", "--target", "dev"], { cwd: root }),
    ).toMatchObject({ exitCode: 0, stderr: "" });
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
        ...gitEnv(),
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

  test("at the root of a Git repo already, the next steps start with pnpm install", async () => {
    const root = await emptyDirectory();
    expect(
      spawnSync("git", ["init", "--quiet"], { cwd: root, env: gitEnv() })
        .status,
    ).toBe(0);
    const initialised = await runCli(["init"], { cwd: root });
    expect(initialised).toMatchObject({ exitCode: 0, stderr: "" });
    expect(initialised.stdout.split("\n").slice(1)).toEqual([
      expect.stringMatching(/^Next: pnpm install\b/),
      "",
    ]);
  });

  test("in a subfolder of a Git repo, the next steps say pnpm install won't install the hook, naming the repo's root", async () => {
    const root = await emptyDirectory();
    const repo = dirname(root);
    expect(
      spawnSync("git", ["init", "--quiet"], { cwd: repo, env: gitEnv() })
        .status,
    ).toBe(0);
    const initialised = await runCli(["init"], { cwd: root });
    expect(initialised).toMatchObject({ exitCode: 0, stderr: "" });
    const [, next, hook] = initialised.stdout.split("\n");
    expect(next).toMatch(/^Next: pnpm install\b/);
    expect(hook).toContain(
      `inside the Git repository at ${realpathSync(repo)}, so pnpm install won't install the pre-commit hook`,
    );
    expect(hook).toContain("A project inside another Git repository");
  });

  test.skipIf(process.platform === "win32")(
    "in a subfolder of a Git repo, the README's recipe makes a commit with a refused statement fail",
    async () => {
      const root = await emptyDirectory();
      const repo = dirname(root);
      expect(await runCli(["init"], { cwd: root })).toMatchObject({
        exitCode: 0,
      });
      await linkDependencies(root);
      // A stand-in pnpm whose precommit is the template's validate step, so
      // the commit fails only if the hook ran it in the project's folder.
      const bin = join(repo, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "pnpm"),
        `#!/bin/sh\n[ "$1" = precommit ] || exit 1\nexec "${process.execPath}" "${cliPath}" validate --strict --allow-draft\n`,
        { mode: 0o755 },
      );
      const env: NodeJS.ProcessEnv = {
        ...gitEnv(),
        PATH: `${bin}:${process.env.PATH}`,
      };
      const git = (args: readonly string[]) =>
        spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
      expect(git(["init", "--quiet"]).status).toBe(0);

      // The README's recipe, with the project in the folder `shop`.
      const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      manifest.scripts.prepare = "cd .. && husky shop/.husky";
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await writeFile(
        join(root, ".husky", "pre-commit"),
        "cd shop\npnpm precommit\n",
      );
      // What `pnpm install` runs: the prepare script, from the repo's root.
      const husky = spawnSync(
        process.execPath,
        [join(root, "node_modules", "husky", "bin.js"), "shop/.husky"],
        { cwd: repo, encoding: "utf8", env },
      );
      expect(husky.status).toBe(0);

      await writeFile(
        join(root, "data-model", "desired-schema", "t.sql"),
        "create table t (id int primary key, x serial);\n",
      );
      expect(git(["add", "-A"]).status).toBe(0);
      const commit = git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "-m",
        "test",
      ]);
      expect(commit.status).not.toBe(0);
      expect(commit.stderr).toContain("t.sql");
    },
  );

  test("refuses to overwrite existing files (exit 1)", async () => {
    const root = await emptyDirectory();
    await writeFile(join(root, "package.json"), "{}\n");
    const result = await runCli(["init"], { cwd: root });
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toMatch(
      /^Error: Cannot initialise a project in \S*shop: it already has package\.json\b.*\bempty folder\b.*\n$/,
    );
  });

  test("is listed under Start", async () => {
    const help = await runCli(["--help"], { cwd: await emptyDirectory() });
    expect(help.stdout).toMatch(/\nStart:\n {2}init {2,}\S/);
  });

  test("--help describes --adopt for the command line", async () => {
    const help = await runCli(["init", "--help"], {
      cwd: await emptyDirectory(),
    });
    expect(help.stdout).toContain(
      "Instead, in an initialised project with no migrations yet: turn this target's managed schema into the desired schema and migration 1, recorded on it as marked",
    );
  });
});
