// API seam for postgresTarget's and postgresRehearsal's connection strings:
// each problem is refused before any connection, with a message naming the
// target and never the password.
import { AdapterError, deploy, draft, status } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  deployProject,
  finalizeMigration,
  targetDatabaseName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers = "create table customers (id bigint primary key);\n";
const unset = "SUPER_DEPLOY_TEST_UNSET_URL";
const empty = "SUPER_DEPLOY_TEST_EMPTY_URL";

/** A project whose `qa` target is `postgresTarget(<source>)`. */
function qaProject(source: string) {
  return deployProject(
    server,
    { "customers.sql": customers },
    {
      preamble: 'import { postgresTarget } from "super-deploy";',
      otherTargets: `qa: { adapter: postgresTarget(${source}) },`,
    },
  );
}

describe("a qa target's connection string", () => {
  test.each([
    [
      "connectionString undefined",
      `{ connectionString: process.env.${unset} as string }`,
      /^Target qa has no connection string \(connectionString is undefined\): .*postgresTarget\(\{ env: /,
    ],
    [
      'connectionString ""',
      '{ connectionString: "" }',
      /^Target qa has no connection string \(connectionString is empty\): .*postgresTarget\(\{ env: /,
    ],
    [
      "env unset",
      `{ env: "${unset}" }`,
      new RegExp(`^Target qa: environment variable ${unset} is not set`),
    ],
    [
      "env empty",
      `{ env: "${empty}" }`,
      new RegExp(`^Target qa: environment variable ${empty} is empty`),
    ],
    [
      '"not a url"',
      '{ connectionString: "not a url" }',
      /^Target qa's connection string is not a PostgreSQL URL \(postgres:\/\/user:password@host:port\/database\)/,
    ],
    [
      "a mysql:// URL",
      '{ connectionString: "mysql://u:secretpw@localhost/db" }',
      /^Target qa's connection string is not a PostgreSQL URL/,
    ],
    [
      "a URL without its scheme",
      '{ connectionString: "u:secretpw@localhost:5432/db" }',
      /^Target qa's connection string is not a PostgreSQL URL/,
    ],
  ])(
    "%s is refused by status and deploy, naming the target",
    async (_, source, message) => {
      vi.stubEnv(unset, undefined);
      vi.stubEnv(empty, "");
      const { project } = await qaProject(source);
      await finalizeMigration(project, "add customers");

      for (const command of [status, deploy]) {
        const error = await command(project, { target: "qa" }).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AdapterError);
        expect((error as AdapterError).message).toMatch(message);
        expect((error as AdapterError).message).not.toContain("secretpw");
      }
    },
  );

  test("an unset variable doesn't stop commands on other targets", async () => {
    vi.stubEnv(unset, undefined);
    const { project } = await qaProject(
      `{ connectionString: process.env.${unset} as string }`,
    );
    await finalizeMigration(project, "add customers");

    await expect(deploy(project, { target: "dev" })).resolves.toMatchObject({
      deployed: [{ number: 1 }],
    });
    await expect(status(project, { target: "dev" })).resolves.toMatchObject({
      pending: [],
    });
  });

  test("postgres:// and postgresql:// URLs with query parameters still connect", async () => {
    const database = targetDatabaseName();
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        database,
        preamble: `import { postgresTarget } from "super-deploy";
const viaUrl = (scheme) => ({
  async connect() {
    await (await real.connect()).close();
    const url = new URL(await postgres.connectionString(${JSON.stringify(database)}));
    url.searchParams.set("application_name", "qa");
    return postgresTarget({ connectionString: url.href.replace(/^postgres:/, scheme) }).connect();
  },
});`,
        otherTargets:
          'qa: { adapter: viaUrl("postgres:") }, qa2: { adapter: viaUrl("postgresql:") },',
      },
    );
    await finalizeMigration(project, "add customers");

    await expect(deploy(project, { target: "qa" })).resolves.toMatchObject({
      deployed: [{ number: 1 }],
    });
    await expect(status(project, { target: "qa2" })).resolves.toMatchObject({
      pending: [],
    });
  });
});

test("the rehearsal adapter's unset variable is refused before connecting", async () => {
  vi.stubEnv(unset, undefined);
  const { project } = await deployProject(
    server,
    { "customers.sql": customers },
    {
      preamble: 'import { postgresRehearsal } from "super-deploy";',
      rehearsal: `postgresRehearsal({ env: "${unset}" })`,
    },
  );

  await expect(draft(project, { name: "add customers" })).rejects.toThrow(
    new RegExp(
      `^The rehearsal adapter: environment variable ${unset} is not set`,
    ),
  );
});
