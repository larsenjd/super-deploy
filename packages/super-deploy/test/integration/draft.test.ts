import {
  DesiredSchemaLoadError,
  DraftNameRequiredError,
  draft,
  InvalidDraftNameError,
  loadProject,
  SqlRuleViolationError,
  UnsupportedServerError,
} from "superdeploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { finalizeMigration } from "../support/deploy.ts";
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
    expect(result.shortfalls).toEqual([]);
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

  test("warns when its schema change can't reorder a composite type's attributes, and still writes the draft", async () => {
    // pg-delta doesn't diff composite attribute order, so the swap generates
    // nothing (research §8): draft's own check of its output finds it.
    const money = (
      attributes: string,
    ) => `create type money_amount as (${attributes});

create table orders (
  id bigint primary key,
  price money_amount
);
`;
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/orders.sql": money(
          "currency char(3), amount numeric(12,2)",
        ),
      },
    });
    const project = await loadProject({ cwd: dir.root });
    await finalizeMigration(project, "Add orders");
    await dir.write(
      "data-model/desired-schema/orders.sql",
      money("amount numeric(12,2), currency char(3)"),
    );

    const result = await draft(project, { name: "Reorder money" });

    expect(result.statements).toEqual([]);
    expect(result.shortfalls).toEqual([
      {
        kind: "differs",
        message:
          "The generated schema change doesn't reorder composite type money_amount's attributes: pg-delta can't express it; drop and recreate the type in the pre-migration script (see the README, \"Reordering a composite type's attributes\")",
        differences: [
          expect.stringMatching(
            /^catalog: from the migrations: column: money_amount\.amount .* position=2$/,
          ),
          expect.stringMatching(
            /^catalog: from the migrations: column: money_amount\.currency .* position=1$/,
          ),
          expect.stringMatching(
            /^catalog: from the desired schema: column: money_amount\.amount .* position=1$/,
          ),
          expect.stringMatching(
            /^catalog: from the desired schema: column: money_amount\.currency .* position=2$/,
          ),
        ],
      },
    ]);
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(true);
  });

  test("refuses statements the desired schema doesn't allow, naming file and line", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/customers.sql": customers,
        "data-model/desired-schema/types/status.sql":
          "-- Customer status\n\ncreate type status as enum ('active');\n",
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
        file: "data-model/desired-schema/types/status.sql",
        line: 3,
        statement: "create type status as enum ('active')",
        rule: "unsupported-object",
        message:
          "Enums are not supported in V1: use a lookup table with a foreign key, or a CHECK constraint",
      },
    ]);
    expect((error as Error).message).toContain(
      "data-model/desired-schema/types/status.sql:3:",
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

  test("names an extension's type in another schema that a column uses, such as public.citext", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server, 'managedSchema: "app",'),
      files: {
        "data-model/desired-schema/users.sql":
          "create table users (id bigint primary key, email public.citext not null);\n",
      },
    });
    const project = await loadProject({ cwd: dir.root });

    const error = await draft(project, { name: "add users" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    expect((error as SqlRuleViolationError).violations).toMatchObject([
      {
        file: "data-model/desired-schema/users.sql",
        rule: "undeclared-schema",
        message: expect.stringContaining("public.citext"),
      },
    ]);
  });

  test("reports what PostgreSQL refused while loading the desired schema, with file and line", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/customers.sql": `${customers}\ncreate table orders (\n  id bigint primary key,\n  total numeric default 'abc'\n);\n`,
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
      'invalid input syntax for type numeric: "abc"',
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
      config: `import { defineConfig } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

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
        `...{ targets: { prod: { adapter: (await import("superdeploy")).postgresTarget({ env: "SUPER_DEPLOY_TEST_UNSET_URL" }) } } },`,
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
