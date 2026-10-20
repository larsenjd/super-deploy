import {
  DesiredSchemaLoadError,
  DraftNameRequiredError,
  draft,
  InvalidDraftNameError,
  loadProject,
  SqlRuleViolationError,
  UnsupportedServerError,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers = `create table customers (
  id bigint primary key,
  name text not null
);
`;

async function customersProject() {
  return createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
}

describe("draft", () => {
  test("creates a named draft whose schema change creates the table", async () => {
    const dir = await customersProject();
    const project = await loadProject({ cwd: dir.root });

    const result = await draft(project, { name: "Add customers" });

    expect(result.name).toBe("add-customers");
    const schemaChange = await dir.read("data-model/draft/schema-change.sql");
    const database = await server.createDatabase(schemaChange);
    const columns = await server.query(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'customers' order by column_name`,
      [],
      database,
    );
    expect(columns).toEqual([
      { column_name: "id", data_type: "bigint", is_nullable: "NO" },
      { column_name: "name", data_type: "text", is_nullable: "NO" },
    ]);
  });

  test("re-running keeps the draft's name, and a new name renames it", async () => {
    const dir = await customersProject();
    const project = await loadProject({ cwd: dir.root });
    await draft(project, { name: "Add customers" });

    const regenerated = await draft(project);
    expect(regenerated).toMatchObject({
      name: "add-customers",
      created: false,
    });
    expect(regenerated.renamedFrom).toBeUndefined();

    const renamed = await draft(project, { name: "Create customer table" });
    expect(renamed).toMatchObject({
      name: "create-customer-table",
      created: false,
      renamedFrom: "add-customers",
    });
    expect((await draft(project)).name).toBe("create-customer-table");
  });

  test("a new draft needs a name", async () => {
    const dir = await customersProject();
    const project = await loadProject({ cwd: dir.root });

    await expect(draft(project)).rejects.toBeInstanceOf(DraftNameRequiredError);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("an invalid name is refused before anything runs", async () => {
    const dir = await customersProject();
    const project = await loadProject({ cwd: dir.root });

    await expect(
      draft(project, { name: "Add customers!" }),
    ).rejects.toBeInstanceOf(InvalidDraftNameError);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("refuses statements the desired schema doesn't allow, naming file and line", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/customers.sql": customers,
        "data-model/desired-schema/views/active.sql":
          "-- Active customers\n\ncreate view active_customers as select id from customers;\n",
      },
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add customers" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    expect((error as SqlRuleViolationError).violations).toEqual([
      {
        file: "data-model/desired-schema/views/active.sql",
        line: 3,
        statement: "create view active_customers as select id from customers",
        rule: "desired-schema-statement",
        message: "CREATE VIEW is not allowed in the desired schema",
      },
    ]);
    expect((error as Error).message).toContain(
      "data-model/desired-schema/views/active.sql:3:",
    );
    expect(dir.exists("data-model/draft")).toBe(false);
    expect(await server.databases()).toEqual(before);
  });

  test("reports a syntax error with file and line", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/customers.sql": `${customers}\ncreate tabel orders (id bigint);\n`,
      },
    });
    const project = await loadProject({ cwd: dir.root });

    const error = await draft(project, { name: "add customers" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    expect((error as SqlRuleViolationError).violations).toMatchObject([
      {
        file: "data-model/desired-schema/customers.sql",
        line: 6,
        rule: "syntax-error",
      },
    ]);
  });

  test("reports what PostgreSQL refused while loading the desired schema, with file and line", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/customers.sql": `${customers}\ncreate table orders (\n  id bigint primary key,\n  total moneyamount\n);\n`,
      },
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add customers" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DesiredSchemaLoadError);
    expect(error).toMatchObject({
      file: "data-model/desired-schema/customers.sql",
      line: 8,
    });
    expect((error as DesiredSchemaLoadError).detail).toContain(
      'type "moneyamount" does not exist',
    );
    expect(dir.exists("data-model/draft")).toBe(false);
    expect(await server.databases()).toEqual(before);
  });

  test("always drops its throwaway databases", async () => {
    const dir = await customersProject();
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    await draft(project, { name: "add customers" });

    expect(await server.databases()).toEqual(before);
  });

  test("refuses a rehearsal server that isn't PostgreSQL 18, and still drops the database", async () => {
    const dir = await createTestProject({
      config: `import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(server.dataDir)} });

// Fault injection: wrap the real adapter's sessions to report PostgreSQL 17.
export default defineConfig({
  postgresVersion: 18,
  rehearsal: {
    async createDatabase(request) {
      const database = await postgres.rehearsal.createDatabase(request);
      return {
        name: database.name,
        drop: () => database.drop(),
        async connect() {
          const session = await database.connect();
          return { ...session, serverVersion: async () => "17.6" };
        },
      };
    },
  },
});
`,
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add customers" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnsupportedServerError);
    expect(error).toMatchObject({ serverVersion: "17.6" });
    expect(await server.databases()).toEqual(before);
  });

  test("never connects to targets it doesn't touch", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(
        server,
        `...{ targets: { prod: { adapter: (await import("super-deploy")).postgresTarget({ env: "SUPER_DEPLOY_TEST_UNSET_URL" }) } } },`,
      ),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });

    await expect(
      draft(project, { name: "add customers" }),
    ).resolves.toMatchObject({
      name: "add-customers",
    });
  });
});
