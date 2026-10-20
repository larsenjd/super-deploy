// Helpers for deployment tests: a project whose `dev` target is a database of
// its own on the file's test server, so tests never share target state.
import { randomBytes } from "node:crypto";
import {
  draft,
  finalize,
  loadProject,
  type Project,
  type Session,
} from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import type { TestServer } from "./postgres.ts";
import { createTestProject, type TestProject } from "./project.ts";

export interface DeployConfigOptions {
  /** The `dev` target's database; default a fresh unique name. */
  database?: string;
  /** Spliced into the `dev` target's object literal, e.g. `lockTimeout: "200ms",`. */
  target?: string;
  /**
   * An expression wrapping the real `dev` adapter (`real`), e.g. to inject
   * faults into its sessions. Default `real`.
   */
  adapter?: string;
  /** More targets, spliced into the `targets` object literal after `dev`. */
  otherTargets?: string;
  /** An expression for the rehearsal adapter, wrapping the real one (`postgres.rehearsal`). */
  rehearsal?: string;
  /** Spliced into the defineConfig() object literal. */
  settings?: string;
  /** Extra top-level code before defineConfig(), e.g. helpers used by `adapter`. */
  preamble?: string;
}

/**
 * A session to `database` on the test server that the test controls, e.g. to
 * hold a lock while a deployment runs.
 */
export function testSession(
  server: Pick<TestServer, "dataDir">,
  database: string,
): Promise<Session> {
  return embeddedPostgres({ dataDir: server.dataDir })
    .target(database)
    .connect();
}

/** A unique database name for one test's target. */
export function targetDatabaseName(): string {
  return `target_${randomBytes(6).toString("hex")}`;
}

/** A config on the test server whose `dev` target is its own database. */
export function deployConfig(
  server: Pick<TestServer, "dataDir">,
  options: DeployConfigOptions = {},
): { config: string; database: string } {
  const database = options.database ?? targetDatabaseName();
  const config = `import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(server.dataDir)} });
const real = postgres.target(${JSON.stringify(database)});
${options.preamble ?? ""}
export default defineConfig({
  postgresVersion: 18,
  rehearsal: ${options.rehearsal ?? "postgres.rehearsal"},
  targets: { dev: { adapter: ${options.adapter ?? "real"}, ${options.target ?? ""} }, ${options.otherTargets ?? ""} },
  ${options.settings ?? ""}
});
`;
  return { config, database };
}

export interface DeployProject {
  readonly dir: TestProject;
  readonly project: Project;
  /** The `dev` target's database on the test server. */
  readonly database: string;
}

/** A project with `files` as its desired schema, ready to draft. */
export async function deployProject(
  server: Pick<TestServer, "dataDir">,
  desiredSchema: Record<string, string>,
  options: DeployConfigOptions = {},
): Promise<DeployProject> {
  const { config, database } = deployConfig(server, options);
  const files = Object.fromEntries(
    Object.entries(desiredSchema).map(([path, text]) => [
      `data-model/desired-schema/${path}`,
      text,
    ]),
  );
  const dir = await createTestProject({ config, files });
  const project = await loadProject({ cwd: dir.root });
  return { dir, project, database };
}

/** Drafts and finalizes the current desired schema as migration `name`. */
export async function finalizeMigration(
  project: Project,
  name: string,
): Promise<Awaited<ReturnType<typeof finalize>>> {
  await draft(project, { name });
  return finalize(project);
}
