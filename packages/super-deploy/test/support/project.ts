// Temporary super-deploy projects for the API and CLI seams.
//
// Layout: <tmp>/node_modules/super-deploy is a junction to this package, so a
// project's super-deploy.config.ts can `import "super-deploy"` exactly like a
// real project: natively (CLI seam, resolving to dist/) or through Vitest's
// alias (API seam, resolving to src/). The project itself is <tmp>/project.
import { existsSync } from "node:fs";
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
import { onTestFinished } from "vitest";
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
    join(base, "node_modules", "super-deploy"),
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
 * - `TEST_STALL=drop`: as `query`, and dropping a throwaway database never finishes.
 * `dataDir` is a JS expression (a string literal or `new URL(...)`).
 */
export function stallingConfig(dataDir: string): string {
  return `import { writeFileSync } from "node:fs";
import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

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
              await session.query("select pg_sleep(60)");
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
 * A config using the embedded-postgres adapter on the test server, with a
 * `dev` target. `settings` is spliced into the defineConfig() object literal.
 */
export function embeddedConfig(
  server: Pick<TestServer, "dataDir">,
  settings = "",
): string {
  return `import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(server.dataDir)} });

export default defineConfig({
  postgresVersion: 18,
  rehearsal: postgres.rehearsal,
  targets: { dev: { adapter: postgres.target("dev") } },
  ${settings}
});
`;
}
