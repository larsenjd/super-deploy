// Temporary super-deploy projects for the API and CLI seams.
//
// Layout: <tmp>/node_modules/superdeploy is a junction to this package, so a
// project's super-deploy.config.ts can `import "superdeploy"` exactly like a
// real project: natively (CLI seam, resolving to dist/) or through Vitest's
// alias (API seam, resolving to src/). The project itself is <tmp>/project.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { readFiles } from "./files.ts";
import type { TestServer } from "./postgres.ts";

export interface TestProject {
  /** Absolute path of the project root (the folder holding the config). */
  readonly root: string;
  /** Absolute path of a project-relative path. */
  path(relative: string): string;
  write(relative: string, text: string): Promise<void>;
  read(relative: string): Promise<string>;
  exists(relative: string): boolean;
}

export interface TestProjectOptions {
  /** Contents of super-deploy.config.ts; omit for no config file. */
  config?: string;
  /** Extra files, by project-relative path. */
  files?: Record<string, string>;
}

const packageDir = join(import.meta.dirname, "..", "..");

/** A temporary project, deleted when the current test finishes. */
export async function createTestProject(
  options: TestProjectOptions = {},
): Promise<TestProject> {
  const base = await mkdtemp(join(tmpdir(), "super-deploy-test-project-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  await mkdir(join(base, "node_modules"));
  await symlink(
    packageDir,
    join(base, "node_modules", "superdeploy"),
    "junction",
  );
  const root = join(base, "project");
  await mkdir(root);

  const project: TestProject = {
    root,
    path: (relative) => join(root, relative),
    async write(relative, text) {
      await mkdir(dirname(join(root, relative)), { recursive: true });
      await writeFile(join(root, relative), text);
    },
    read: (relative) => readFile(join(root, relative), "utf8"),
    exists: (relative) => existsSync(join(root, relative)),
  };
  await project.write(
    "package.json",
    `${JSON.stringify({ name: "test-project", private: true, type: "module" }, null, 2)}\n`,
  );
  if (options.config !== undefined) {
    await project.write("super-deploy.config.ts", options.config);
  }
  for (const [relative, text] of Object.entries(options.files ?? {})) {
    await project.write(relative, text);
  }
  return project;
}

/**
 * A config whose rehearsal adapter wraps the embedded one to stall on demand,
 * for interruption tests. Environment variables (read when the command runs):
 * - `TEST_STALL=query`: every throwaway session's first `execute` first runs
 *   `pg_sleep(60)`, after writing the file named by `TEST_MARKER`.
 *   `TEST_STALL_SECONDS` sleeps that long instead, for a stall that ends.
 * - `TEST_STALL=drop`: as `query`, and dropping a throwaway database never finishes.
 * `dataDir` is a JS expression (a string literal or `new URL(...)`).
 */
export function stallingConfig(dataDir: string): string {
  return `import { writeFileSync } from "node:fs";
import { defineConfig } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${dataDir} });
const stall = process.env.TEST_STALL;

const rehearsal = {
  async createDatabase(request) {
    const database = await postgres.rehearsal.createDatabase(request);
    return {
      name: database.name,
      drop: stall === "drop" ? () => new Promise(() => {}) : () => database.drop(),
      async connect() {
        const session = await database.connect();
        let stalled = false;
        return {
          ...session,
          async execute(sql) {
            if (stall !== undefined && !stalled) {
              stalled = true;
              writeFileSync(process.env.TEST_MARKER, "");
              await session.query("select pg_sleep($1)", [
                Number(process.env.TEST_STALL_SECONDS ?? 60),
              ]);
            }
            return session.execute(sql);
          },
        };
      },
    };
  },
  close: () => postgres.rehearsal.close(),
};

export default defineConfig({
  postgresVersion: 18,
  rehearsal,
  targets: { dev: { adapter: postgres.target("dev") } },
});
`;
}

/**
 * A config with one target, `down`, a `postgresTarget` reading its URL from
 * the environment variable `variable` (e.g. a `silentHost`'s).
 * `targetSettings` is spliced into the target's object literal. The embedded
 * rehearsal adapter is never started unless a command rehearses.
 */
export function downTargetConfig(
  variable: string,
  targetSettings: string,
): string {
  return `import { defineConfig, postgresTarget } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: "/nonexistent/super-deploy-down-target" });

export default defineConfig({
  postgresVersion: 18,
  rehearsal: postgres.rehearsal,
  targets: { down: { adapter: postgresTarget({ env: ${JSON.stringify(variable)} }), ${targetSettings} } },
});
`;
}

/**
 * A config using the embedded-postgres adapter on the test server, with a
 * `dev` target. `settings` is spliced into the defineConfig() object literal.
 */
export function embeddedConfig(
  server: Pick<TestServer, "dataDir">,
  settings = "",
): string {
  return `import { defineConfig } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(server.dataDir)} });

export default defineConfig({
  postgresVersion: 18,
  rehearsal: postgres.rehearsal,
  targets: { dev: { adapter: postgres.target("dev") } },
  ${settings}
});
`;
}

/** Rewrites a finalized file the way someone bypassing read-only would. */
export async function tamperFinalized(
  dir: TestProject,
  path: string,
  edit: (text: string) => string,
): Promise<void> {
  await chmod(dir.path(path), 0o644);
  await dir.write(path, edit(await dir.read(path)));
}

/**
 * Rewrites index.json so `folder`, migration 1, matches its files again, by
 * the hash format documented in src/store/hashing.ts (migration 1's chain
 * hash starts from the empty start). It is written out here rather than
 * imported: tests reach only the public API, which deliberately has no way
 * to re-hash a finalized migration (that is the tampering validate exists to
 * catch). Change it with hashing.ts.
 */
export async function rehashFirstMigration(
  dir: TestProject,
  folder: string,
): Promise<void> {
  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  const files = await readFiles(dir.path(`data-model/migrations/${folder}`));
  let manifest = `super-deploy migration 1\nfolder ${JSON.stringify(folder)}\n`;
  for (const path of Object.keys(files).sort()) {
    manifest += `file ${JSON.stringify(path)} ${sha256(files[path] ?? "")}\n`;
  }
  const contentHash = sha256(manifest);
  const indexPath = "data-model/migrations/index.json";
  const index = JSON.parse(await dir.read(indexPath));
  index.migrations[0] = {
    ...index.migrations[0],
    contentHash,
    chainHash: sha256(contentHash),
  };
  await dir.write(indexPath, JSON.stringify(index));
}
