// API seam for init: scaffolding a project from the bundled template. The
// scaffolded config is used as is: two embedded-postgres servers in the
// project's own .super-deploy folder, one for the dev target on the port
// init wrote into the config and one for the rehearsal databases on a free
// port, both stopped by project.close().
import { spawnSync } from "node:child_process";
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
import { dirname, join, sep } from "node:path";
import pg from "pg";
import {
  deploy,
  draft,
  finalize,
  InitConflictError,
  init,
  loadProject,
  rehearse,
  status,
  toolVersion,
} from "superdeploy";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { gitInstalled } from "../support/git-apply.ts";
import { holdPort } from "../support/postgres.ts";

/** This library's package folder, posix-style. */
const libraryFolder = join(import.meta.dirname, "..", "..")
  .split(sep)
  .join("/");

/** The port of `dev`'s server in the config of the project in `root`. */
async function devPort(root: string): Promise<number> {
  const config = await readFile(join(root, "super-deploy.config.ts"), "utf8");
  const ports = [...config.matchAll(/^\s*port: (\d+),$/gm)];
  expect(ports).toHaveLength(1);
  return Number(ports[0]?.[1]);
}

/** Runs `sql` on the server at `url` and returns its rows. */
async function queryAt(url: string, sql: string): Promise<unknown[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

/** An empty directory named `name`, deleted when the test finishes. */
async function emptyDirectory(name = "my-shop"): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "super-deploy-test-init-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, name);
  await mkdir(directory);
  return directory;
}

describe("init", () => {
  test("a freshly initialised project drafts, finalizes and deploys to dev with no other setup, and no warnings", async () => {
    const root = await emptyDirectory();
    await init({ directory: root });
    await mkdir(join(root, "data-model", "desired-schema"), {
      recursive: true,
    });
    await writeFile(
      join(root, "data-model", "desired-schema", "customers.sql"),
      `create table customers (id bigint primary key, name text not null);
create view customer_names as select name from customers;
create function customer_count() returns bigint
  language sql stable
  return (select count(*) from customers);
`,
    );

    const project = await loadProject({ cwd: root });
    try {
      await draft(project, { name: "add customers" });
      await finalize(project);
      const warnings: string[] = [];
      const deployed = await deploy(project, {
        target: "dev",
        onWarning: (warning) => warnings.push(warning),
      });
      expect(deployed.deployed.map((m) => m.folder)).toEqual([
        "00001-add-customers",
      ]);
      expect(warnings).toEqual([]);

      const report = await status(project, { target: "dev" });
      expect(report.recorded.map((m) => m.number)).toEqual([1]);
      expect(report.pending).toEqual([]);
      expect(report.preflight.warnings).toEqual([]);
      const session = await project.config.targets.dev?.adapter.connect();
      try {
        const tables = await session?.query(
          "select table_name from information_schema.tables where table_schema = 'public' order by 1",
        );
        expect(tables?.rows).toEqual([
          { table_name: "customer_names" },
          { table_name: "customers" },
        ]);
        expect((await session?.query("select customer_count()"))?.rows).toEqual(
          [{ customer_count: "0" }],
        );
        // dev deploys as a role that isn't a superuser, holds no other role
        // and owns the dev database.
        const role = await session?.query(
          `select r.rolsuper,
                  array(select m.roleid::regrole::text from pg_auth_members m where m.member = r.oid) as member_of,
                  d.datname, pg_get_userbyid(d.datdba) = r.rolname as owns_database
             from pg_roles r, pg_database d
            where r.rolname = current_user and d.datname = current_database()`,
        );
        expect(role?.rows).toEqual([
          {
            rolsuper: false,
            member_of: [],
            datname: "dev",
            owns_database: true,
          },
        ]);
      } finally {
        await session?.close();
      }

      // The URL README.md gives for dev, on the port in the config.
      const port = await devPort(root);
      expect(
        await queryAt(
          `postgres://deployer:deployer@127.0.0.1:${port}/dev`,
          "select count(*)::int as customers from customers",
        ),
      ).toEqual([{ customers: 0 }]);
    } finally {
      await project.close();
    }
    expect(existsSync(join(root, ".super-deploy", "dev"))).toBe(true);
    expect(existsSync(join(root, ".super-deploy", "rehearsal"))).toBe(true);
  });

  test("a rehearsal creates its databases on a server of its own, never on dev's", async () => {
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
      // Starts dev's server.
      await (await project.config.targets.dev?.adapter.connect())?.close();
      const devDatabases = () =>
        queryAt(
          `postgres://super_deploy:super_deploy@127.0.0.1:${port}/postgres`,
          databases,
        );
      const databases =
        "select datname from pg_database where not datistemplate order by 1";
      const port = await devPort(root);
      // The databases on both servers, listed each time the rehearsal has
      // just created one.
      const seen: { created: string; rehearsal: unknown[]; dev: unknown[] }[] =
        [];
      const { rehearsal } = project.config;
      const createDatabase = rehearsal.createDatabase.bind(rehearsal);
      vi.spyOn(rehearsal, "createDatabase").mockImplementation(
        async (request) => {
          const throwaway = await createDatabase(request);
          const session = await throwaway.connect();
          try {
            seen.push({
              created: throwaway.name,
              rehearsal: (await session.query(databases)).rows,
              dev: await devDatabases(),
            });
          } finally {
            await session.close();
          }
          return throwaway;
        },
      );

      await rehearse(project);

      expect(seen).not.toEqual([]);
      for (const { created, rehearsal: onRehearsal, dev } of seen) {
        expect(onRehearsal).toContainEqual({ datname: created });
        expect(dev).toEqual([{ datname: "dev" }, { datname: "postgres" }]);
      }
    } finally {
      await project.close();
    }
  });

  test("the dev port is written into the config, never the template's own", async () => {
    const template = await readFile(
      join(libraryFolder, "..", "template", "super-deploy.config.ts"),
      "utf8",
    );
    const templatePort = Number(/^\s*port: (\d+),$/m.exec(template)?.[1]);
    expect(templatePort).toBeGreaterThan(0);
    // Held, so a free port can't happen to be the template's.
    await holdPort(templatePort);
    const root = await emptyDirectory();

    await init({ directory: root });

    expect(await devPort(root)).not.toBe(templatePort);
  });

  test("the project is named after its folder and depends on this library's published version, not the workspace", async () => {
    const root = await emptyDirectory("My Shop");
    const result = await init({ directory: root });
    expect(result.root).toBe(root);

    const text = await readFile(join(root, "package.json"), "utf8");
    expect(text).not.toContain("workspace:");
    const manifest = JSON.parse(text);
    expect(manifest.name).toBe("my-shop");
    expect(manifest.private).toBe(true);
    expect(manifest.description).toBeUndefined();
    expect(manifest.devDependencies.superdeploy).toBe(toolVersion);
    expect(manifest.scripts.precommit).toBe(
      "biome check && tsc --noEmit && super-deploy validate --strict --allow-draft",
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

  test.skipIf(!gitInstalled)(
    "git keeps a desired-schema diff's carriage returns, even with core.autocrlf",
    async () => {
      const root = await emptyDirectory();
      await init({ directory: root });
      const diffPath =
        "data-model/migrations/00001-add-customers/desired-schema.diff";
      // A file ending in a bare carriage return gives a line ending in CRLF.
      const diff = [
        "diff --git a/a.sql b/a.sql",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/a.sql",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two\r",
        "\\ No newline at end of file",
        "",
      ].join("\n");
      await mkdir(join(root, dirname(diffPath)), { recursive: true });
      await writeFile(join(root, diffPath), diff);
      const git = (...args: string[]) => {
        const run = spawnSync(
          "git",
          ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false", ...args],
          { cwd: root, encoding: "utf8" },
        );
        expect(run.status, run.stderr).toBe(0);
        return run.stdout;
      };

      git("init", "--quiet");
      git("add", "--all");
      expect(git("show", `:${diffPath}`)).toBe(diff);
      await rm(join(root, diffPath));
      git("checkout", "--", diffPath);
      expect(await readFile(join(root, diffPath), "utf8")).toBe(diff);
    },
  );

  test("the config's commented-out real target, once uncommented, reads its variable only when that target is used", async () => {
    const root = await emptyDirectory();
    await init({ directory: root });
    const configPath = join(root, "super-deploy.config.ts");
    const scaffolded = await readFile(configPath, "utf8");
    const importLine = /^import \{ defineConfig \} from "superdeploy";$/m;
    const exampleImport =
      /^\/\/ +(import \{ defineConfig, postgresTarget \} from "superdeploy";)$/m;
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
