// Desired-schema ordering and the order-independence check at the API seam,
// against real PostgreSQL 18.
import {
  draft,
  finalize,
  loadProject,
  OrderDependenceError,
  rehearse,
  SqlRuleViolationError,
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

/**
 * A config whose rehearsal databases behave as if PostgreSQL let creation
 * order leak into the catalog: whenever `create table beta` runs before
 * `create table alpha` in a database, `onBetaFirst` runs too (or, if it is
 * "fail", the statement fails). Setting `globalThis.orderLeakOff` turns the
 * leak off, so a test can create a draft first.
 */
function orderSensitiveConfig(onBetaFirst: string): string {
  return `import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(server.dataDir)} });

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
          let alphaCreated = false;
          return {
            ...session,
            async execute(sql) {
              if (sql.startsWith("create table alpha")) alphaCreated = true;
              if (sql.startsWith("create table beta") && !alphaCreated && !globalThis.orderLeakOff) {
                ${
                  onBetaFirst === "fail"
                    ? `throw new Error("simulated: beta needs alpha");`
                    : `const results = await session.execute(sql);
                await session.execute(${JSON.stringify(onBetaFirst)});
                return results;`
                }
              }
              return session.execute(sql);
            },
          };
        },
      };
    },
  },
});
`;
}

const independentTables = {
  "data-model/desired-schema/tables.sql":
    "create table alpha (id int primary key);\n\ncreate table beta (id int primary key);\n",
};

describe("desired-schema ordering", () => {
  test("loads statements in dependency order whatever the file names", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/a/orders.sql":
          "create table orders (\n  id bigint primary key,\n  customer_id bigint not null constraint orders_customer_fk references customers (id)\n);\n",
        "data-model/desired-schema/b/customers.sql":
          "create table customers (id bigint primary key);\n",
      },
    });
    const project = await loadProject({ cwd: dir.root });

    await draft(project, { name: "add orders" });

    const database = await server.createDatabase(
      await dir.read("data-model/draft/schema-change.sql"),
    );
    expect(
      await server.query(
        "select conname, confrelid::regclass::text as target from pg_constraint where contype = 'f'",
        [],
        database,
      ),
    ).toEqual([{ conname: "orders_customer_fk", target: "customers" }]);
  });

  test("reports unknown references with file and line before anything loads", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/orders.sql":
          "create table orders (\n  id bigint primary key,\n  total moneyamount\n);\n\ncreate table lines (order_id bigint constraint lines_order_fk references ordrs (id));\n",
      },
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add orders" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    expect((error as SqlRuleViolationError).violations).toMatchObject([
      {
        file: "data-model/desired-schema/orders.sql",
        line: 1,
        rule: "unknown-reference",
        message: expect.stringContaining("type moneyamount"),
      },
      {
        file: "data-model/desired-schema/orders.sql",
        line: 6,
        rule: "unknown-reference",
        message: expect.stringContaining("relation ordrs"),
      },
    ]);
    expect(await server.databases()).toEqual(before);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("reports a foreign-key cycle with file and line before anything loads", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/a.sql":
          "create table a (id int primary key, b_id int constraint a_b_fk references b (id));\n",
        "data-model/desired-schema/b.sql":
          "create table b (id int primary key, a_id int constraint b_a_fk references a (id));\n",
      },
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add tables" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    expect((error as SqlRuleViolationError).violations).toMatchObject([
      {
        file: "data-model/desired-schema/a.sql",
        line: 1,
        rule: "dependency-cycle",
      },
    ]);
    expect((error as Error).message).toContain(
      "ALTER TABLE ... ADD CONSTRAINT",
    );
    expect(await server.databases()).toEqual(before);
  });
});

describe("order-independence check in draft", () => {
  test("refuses a desired schema whose catalog depends on load order, naming the objects", async () => {
    const dir = await createTestProject({
      config: orderSensitiveConfig("comment on table beta is 'created first'"),
      files: independentTables,
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add tables" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(OrderDependenceError);
    expect(error).toMatchObject({
      code: "order-dependent-desired-schema",
      objects: ["table public.beta"],
      differences: ["+ comment: pg_class beta created first"],
      failure: undefined,
    });
    expect((error as Error).message).toContain("table public.beta");
    expect(dir.exists("data-model/draft")).toBe(false);
    expect(await server.databases()).toEqual(before);
  });

  test("refuses a desired schema that fails to load in another valid order", async () => {
    const dir = await createTestProject({
      config: orderSensitiveConfig("fail"),
      files: independentTables,
    });
    const project = await loadProject({ cwd: dir.root });
    const before = await server.databases();

    const error = await draft(project, { name: "add tables" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(OrderDependenceError);
    expect(error).toMatchObject({
      failure: {
        file: "data-model/desired-schema/tables.sql",
        line: 3,
        detail: "simulated: beta needs alpha",
      },
    });
    expect((error as Error).message).toContain(
      "data-model/desired-schema/tables.sql:3",
    );
    expect(await server.databases()).toEqual(before);
  });

  test("accepts a desired schema whose catalog is the same in either order", async () => {
    const dir = await createTestProject({
      config: orderSensitiveConfig("select 1"),
      files: independentTables,
    });
    const project = await loadProject({ cwd: dir.root });

    await expect(draft(project, { name: "add tables" })).resolves.toMatchObject(
      { name: "add-tables" },
    );
  });
});

describe("order-independence check in rehearse and finalize", () => {
  async function draftedOrderSensitiveProject() {
    const dir = await createTestProject({
      config: orderSensitiveConfig("comment on table beta is 'created first'"),
      files: independentTables,
    });
    const project = await loadProject({ cwd: dir.root });
    const leak = globalThis as { orderLeakOff?: boolean };
    leak.orderLeakOff = true;
    try {
      await draft(project, { name: "add tables" });
    } finally {
      leak.orderLeakOff = false;
    }
    return { dir, project };
  }

  test("rehearse refuses a desired schema whose catalog depends on load order", async () => {
    const { project } = await draftedOrderSensitiveProject();
    const before = await server.databases();

    await expect(rehearse(project)).rejects.toMatchObject({
      code: "order-dependent-desired-schema",
      objects: ["table public.beta"],
    });
    expect(await server.databases()).toEqual(before);
  });

  test("finalize refuses a desired schema whose catalog depends on load order, and finalizes nothing", async () => {
    const { dir, project } = await draftedOrderSensitiveProject();

    await expect(finalize(project)).rejects.toBeInstanceOf(
      OrderDependenceError,
    );
    expect(dir.exists("data-model/draft")).toBe(true);
    expect(dir.exists("data-model/migrations/00001-add-tables")).toBe(false);
  });
});
