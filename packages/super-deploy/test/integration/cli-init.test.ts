// CLI seam for init, end to end: `super-deploy init` in an empty folder, then
// the template's own precommit checks and draft, finalize and deploy to dev,
// all through the real binary with the scaffolded config loaded natively.
//
// Installing: tests run offline, so instead of `pnpm install` the project's
// node_modules links each devDependency to the copy the workspace's template
// package already has installed (superdeploy itself to this package, whose
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
      name === "superdeploy"
        ? packageDir
        : realpathSync(join(templateDir, "node_modules", ...name.split("/")));
    const { version } = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    expect(`${name}@${spec}`).toBe(`${name}@${version}`);
    const link = join(root, "node_modules", ...name.split("/"));
    await mkdir(dirname(link), { recursive: true });
    await symlink(installed, link, "junction");
  }
}

/**
 * A `node_modules/.bin` for the project at `root`, as an install makes it:
 * a shim per bin of each linked devDependency.
 */
async function linkBins(root: string): Promise<void> {
  const binDir = join(root, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  for (const name of Object.keys(manifest.devDependencies)) {
    const installed = join(root, "node_modules", ...name.split("/"));
    const { bin } = JSON.parse(
      await readFile(join(installed, "package.json"), "utf8"),
    );
    const bins: Record<string, string> =
      typeof bin === "string"
        ? { [name.split("/").at(-1) ?? name]: bin }
        : (bin ?? {});
    for (const [command, path] of Object.entries(bins)) {
      await writeFile(
        join(binDir, command),
        `#!/bin/sh\nexec "${process.execPath}" "${join(installed, path)}" "$@"\n`,
        { mode: 0o755 },
      );
    }
  }
}

/**
 * A stand-in `pnpm` in a new folder under `parent` (returned, for PATH): it
 * runs a package.json script as `pnpm <script>` and `pnpm --dir <folder>
 * <script>` do, in the package's folder with its node_modules/.bin first on
 * PATH. Tests run offline, so the real pnpm can't be relied on.
 */
async function standInPnpm(parent: string): Promise<string> {
  const bin = join(parent, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh
if [ "$1" = --dir ]; then cd "$2" || exit 1; shift 2; fi
script=$("${process.execPath}" -e 'const s = JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).scripts?.[process.argv[1]]; if (s === undefined) process.exit(1); console.log(s)' "$1") || exit 1
PATH="$PWD/node_modules/.bin:$PATH" exec sh -c "$script"
`,
    { mode: 0o755 },
  );
  return bin;
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

  test.skipIf(process.platform === "win32").each([
    ["Husky's subfolder form, from the project", "husky"],
    ["a line in the repository's own hook", "own hook"],
  ] as const)(
    "in a subfolder of a Git repo, the README's recipe (%s) makes a commit with a refused statement fail",
    async (_, form) => {
      const root = await emptyDirectory();
      const repo = dirname(root);
      expect(await runCli(["init"], { cwd: root })).toMatchObject({
        exitCode: 0,
      });
      await linkDependencies(root);
      await linkBins(root);
      const env: NodeJS.ProcessEnv = {
        ...gitEnv(),
        PATH: `${await standInPnpm(repo)}:${process.env.PATH}`,
      };
      const git = (args: readonly string[]) =>
        spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
      expect(git(["init", "--quiet"]).status).toBe(0);

      // The README's recipe, with the project in the folder `shop`.
      const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      if (form === "husky") {
        manifest.scripts.prepare = "cd .. && husky shop/.husky";
        await writeFile(
          join(root, ".husky", "pre-commit"),
          "cd shop\npnpm precommit\n",
        );
      } else {
        delete manifest.scripts.prepare;
        await rm(join(root, ".husky"), { recursive: true });
        await mkdir(join(repo, ".githooks"));
        await writeFile(
          join(repo, ".githooks", "pre-commit"),
          "#!/bin/sh\npnpm --dir shop precommit\n",
          { mode: 0o755 },
        );
        expect(git(["config", "core.hooksPath", ".githooks"]).status).toBe(0);
      }
      await writeFile(
        join(root, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      // What `pnpm install` runs: the project's prepare script, if any.
      if (manifest.scripts.prepare !== undefined) {
        expect(
          spawnSync("pnpm", ["prepare"], { cwd: root, encoding: "utf8", env })
            .status,
        ).toBe(0);
      }

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
