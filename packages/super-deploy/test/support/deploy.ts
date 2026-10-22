// Helpers for deployment tests: a project whose `dev` target is a database of
// its own on the file's test server, so tests never share target state.
import { randomBytes } from "node:crypto";
import {
  deploy,
  draft,
  finalize,
  loadProject,
  type Project,
  type Session,
} from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";
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

/**
 * The role an embedded target (`postgres.target(...)`, so `dev` here) deploys
 * as: not a superuser, and the owner of the target's database.
 */
export const embeddedDeployRole = "deployer";

/**
 * Runs `sql` on `database` as the embedded targets' deploy role, like a
 * change an administrator makes by hand as the deploy role: what it creates
 * is the deploy role's, as a deployment's would be. (`server.query` runs as
 * the superuser, whose objects fail the ownership pre-flight.)
 */
export async function asDeployRole(
  server: Pick<TestServer, "dataDir">,
  database: string,
  sql: string,
): Promise<void> {
  const session = await testSession(server, database);
  try {
    await session.execute(sql);
  } finally {
    await session.close();
  }
}

/** A role name no other test uses (roles are server-wide). */
export function roleName(prefix = "reader"): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/**
 * A `preamble` defining `asDeployer`, an adapter that connects to `database`
 * on the test server as `role` (password `deployer`): use it as `adapter` or
 * in `otherTargets`.
 */
export function asDeployerPreamble(database: string, role: string): string {
  return `import { postgresTarget } from "superdeploy";
const asDeployer = {
  async connect() {
    const url = new URL(await postgres.connectionString(${JSON.stringify(database)}));
    url.username = ${JSON.stringify(role)};
    url.password = "deployer";
    return postgresTarget({ connectionString: url.href }).connect();
  },
};`;
}

/**
 * An adapter expression (for `adapter` or `otherTargets`) that connects to
 * `database` on the test server as its superuser `super_deploy`, unlike
 * `postgres.target(...)`, which deploys as the non-superuser `deployer`: a
 * real target logging in as a superuser, which may act on objects any role
 * owns. The database must exist.
 */
export function asSuperuser(database: string): string {
  return `{
  async connect(options) {
    const { postgresTarget } = await import("superdeploy");
    return postgresTarget({
      connectionString: await postgres.connectionString(${JSON.stringify(database)}),
    }).connect(options);
  },
}`;
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
  const config = `import { defineConfig } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

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

/**
 * Runs `during` while a session of its own holds `mode` on `table` in
 * `database` (in a transaction it rolls back afterwards, whatever happens).
 * ACCESS SHARE lets the drift check read the table's definition but makes a
 * migration altering it wait; ACCESS EXCLUSIVE holds up the catalog reads
 * too (testing.md, "Holding a lock against a deployment").
 */
export async function whileLocked<T>(
  server: Pick<TestServer, "dataDir">,
  database: string,
  table: string,
  mode: "ACCESS SHARE" | "ACCESS EXCLUSIVE",
  during: () => Promise<T>,
): Promise<T> {
  const holder = await testSession(server, database);
  try {
    await holder.execute(`BEGIN; LOCK TABLE ${table} IN ${mode} MODE`);
    return await during();
  } finally {
    await holder.execute("ROLLBACK").catch(() => {});
    await holder.close();
  }
}

const customers = `create table customers (
  id bigint primary key,
  name text not null
);
`;

/**
 * A `dev` target (configured with `options`) at migration 1, which creates
 * customers (id, name), with migration 2, adding the column `note`,
 * finalized and pending.
 */
export async function columnPending(
  server: Pick<TestServer, "dataDir">,
  options: DeployConfigOptions = {},
): Promise<DeployProject> {
  const deployed = await deployProject(
    server,
    { "customers.sql": customers },
    options,
  );
  await finalizeMigration(deployed.project, "add customers");
  await deploy(deployed.project, { target: "dev" });
  await deployed.dir.write(
    "data-model/desired-schema/customers.sql",
    customers.replace("name text not null", "name text not null,\n  note text"),
  );
  await finalizeMigration(deployed.project, "add note");
  return deployed;
}

/** One attempt in a target's attempt log, as tests read it. */
export interface LoggedAttempt {
  readonly id: number;
  readonly command: string;
  readonly outcome: string;
  readonly error: string | null;
}

/** The attempt log of the target in `database` (history schema `deployment_history`), oldest first. */
export function attemptLog(
  server: TestServer,
  database: string,
): Promise<LoggedAttempt[]> {
  return server.query<LoggedAttempt>(
    "select id::int as id, command, outcome, error from deployment_history.attempts order by id",
    [],
    database,
  );
}
