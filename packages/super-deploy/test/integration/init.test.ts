// API seam for init: scaffolding a project from the bundled template. The
// scaffolded config is used as is: its embedded-postgres server (in the
// project's own .super-deploy/postgres) provides the rehearsal databases and
// the dev target, started on a free port and stopped by project.close().
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  deploy,
  draft,
  finalize,
  InitConflictError,
  init,
  loadProject,
  status,
} from "super-deploy";
import { describe, expect, onTestFinished, test, vi } from "vitest";

/** This library's package folder, posix-style. */
const libraryFolder = join(import.meta.dirname, "..", "..")
  .split(sep)
  .join("/");

/** An empty directory named `name`, deleted when the test finishes. */
async function emptyDirectory(name = "my-shop"): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "super-deploy-test-init-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, name);
  await mkdir(directory);
  return directory;
}

describe("init", () => {
  test("a freshly initialised project drafts, finalizes and deploys to dev with no other setup", async () => {
    const root = await emptyDirectory();
    await init({ directory: root });
    await mkdir(join(root, "data-model", "desired-schema"), {
      recursive: true,
    });
    await writeFile(
      join(root, "data-model", "desired-schema", "customers.sql"),
      "create table customers (id bigint primary key, name text not null);\n",
    );

    const project = await loadProject({ cwd: root });
    try {
      await draft(project, { name: "add customers" });
      await finalize(project);
      const deployed = await deploy(project, { target: "dev" });
      expect(deployed.deployed.map((m) => m.folder)).toEqual([
        "00001-add-customers",
      ]);

      const report = await status(project, { target: "dev" });
      expect(report.recorded.map((m) => m.number)).toEqual([1]);
      expect(report.pending).toEqual([]);
      const session = await project.config.targets.dev?.adapter.connect();
      try {
        const tables = await session?.query(
          "select table_name from information_schema.tables where table_schema = 'public'",
        );
        expect(tables?.rows).toEqual([{ table_name: "customers" }]);
      } finally {
        await session?.close();
      }
    } finally {
      await project.close();
    }
    expect(existsSync(join(root, ".super-deploy", "postgres"))).toBe(true);
  });

  test("the project is named after its folder and depends on this library, not the workspace", async () => {
    const root = await emptyDirectory("My Shop");
    const result = await init({ directory: root });
    expect(result.root).toBe(root);

    const text = await readFile(join(root, "package.json"), "utf8");
    expect(text).not.toContain("workspace:");
    const manifest = JSON.parse(text);
    expect(manifest.name).toBe("my-shop");
    expect(manifest.private).toBe(true);
    expect(manifest.description).toBeUndefined();
    expect(manifest.devDependencies["super-deploy"]).toBe(
      `link:${libraryFolder}`,
    );
    expect(manifest.scripts.precommit).toBe(
      "biome check && tsc --noEmit && super-deploy validate --strict",
    );
    // embedded-postgres's platform package must run its postinstall.
    const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
    expect(workspace).toContain("'@embedded-postgres/linux-x64': true");
    expect(result.files).toEqual(
      expect.arrayContaining(["pnpm-workspace.yaml"]),
    );
    expect(result.files).not.toContain("project.pnpm-workspace.yaml");
  });

  test("the project forces LF for SQL and JSON, marks generated files read-only and warns about seed data", async () => {
    const root = await emptyDirectory();
    const { files } = await init({ directory: root });
    expect(files).toEqual(
      expect.arrayContaining([
        ".gitattributes",
        ".gitignore",
        ".vscode/extensions.json",
        ".vscode/settings.json",
        "README.md",
        "biome.json",
        "package.json",
        "super-deploy.config.ts",
        "tsconfig.json",
      ]),
    );
    for (const file of files) {
      expect(existsSync(join(root, file))).toBe(true);
    }

    const attributes = await readFile(join(root, ".gitattributes"), "utf8");
    expect(attributes).toMatch(/^\*\.sql\s+text\s+eol=lf$/m);
    expect(attributes).toMatch(/^\*\.json\s+text\s+eol=lf$/m);

    const settings = await readFile(
      join(root, ".vscode", "settings.json"),
      "utf8",
    );
    expect(settings).toContain('"data-model/migrations/**": true');
    expect(settings).toContain('"data-model/draft/schema-change.sql": true');

    const readme = await readFile(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/seed data must be synthetic or anonymised/i);

    const ignored = await readFile(join(root, ".gitignore"), "utf8");
    expect(ignored).toMatch(/^\.super-deploy\/$/m);
    expect(ignored).toMatch(/^node_modules\/$/m);
  });

  test("the config's commented-out real target, once uncommented, reads its variable only when that target is used", async () => {
    const root = await emptyDirectory();
    await init({ directory: root });
    const configPath = join(root, "super-deploy.config.ts");
    const scaffolded = await readFile(configPath, "utf8");
    const importLine = /^import \{ defineConfig \} from "super-deploy";$/m;
    const exampleImport =
      /^\/\/ +(import \{ defineConfig, postgresTarget \} from "super-deploy";)$/m;
    const exampleTarget =
      /^( +)\/\/ (qa: \{ adapter: postgresTarget\(\{ env: "QA_DATABASE_URL" \}\) \},)$/m;
    expect(scaffolded).toMatch(importLine);
    expect(scaffolded).toMatch(exampleImport);
    expect(scaffolded).toMatch(exampleTarget);
    const uncommented = scaffolded
      .replace(importLine, exampleImport.exec(scaffolded)?.[1] ?? "")
      .replace(exampleTarget, "$1$2");
    await writeFile(configPath, uncommented);
    vi.stubEnv("QA_DATABASE_URL", undefined);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    const project = await loadProject({ cwd: root });
    try {
      expect(Object.keys(project.config.targets)).toEqual(["dev", "qa"]);
      await expect(status(project, { target: "qa" })).rejects.toThrow(
        "Target qa: environment variable QA_DATABASE_URL is not set",
      );
    } finally {
      await project.close();
    }
  });

  test("refuses to overwrite existing files, writing nothing", async () => {
    const root = await emptyDirectory();
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "README.md"), "# Mine\n");
    await writeFile(join(root, "notes.txt"), "kept\n");

    const error = await init({ directory: root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InitConflictError);
    expect(error).toMatchObject({
      code: "init-conflict",
      paths: ["README.md", "package.json"],
    });
    expect((await readdir(root)).sort()).toEqual([
      "README.md",
      "notes.txt",
      "package.json",
    ]);
    expect(await readFile(join(root, "package.json"), "utf8")).toBe("{}\n");
  });

  test("creates the folder when it doesn't exist, and works beside unrelated files", async () => {
    const root = join(await emptyDirectory(), "nested", "app");
    await init({ directory: root });
    expect(existsSync(join(root, "super-deploy.config.ts"))).toBe(true);

    const other = await emptyDirectory();
    await mkdir(join(other, ".git"));
    await writeFile(join(other, "notes.txt"), "kept\n");
    await init({ directory: other });
    expect(existsSync(join(other, "super-deploy.config.ts"))).toBe(true);
  });
});
