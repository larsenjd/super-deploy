// API seam: pre- and post-migration scripts in draft, rehearsals and deploy.

import {
  DestructiveNotAcknowledgedError,
  deploy,
  draft,
  finalize,
  rehearse,
  SqlFileFailedError,
  SqlRuleViolationError,
  type UnknownDraftFile,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deployProject } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

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

/** Migration 1 (customers, with Ada inserted by its post-migration script). */
async function withFirstMigration() {
  const setup = await deployProject(server, { "customers.sql": customers });
  await draft(setup.project, { name: "add customers" });
  await setup.dir.write(
    "data-model/draft/post-migration.sql",
    "insert into customers (id, name) values (1, 'Ada');\n",
  );
  await finalize(setup.project);
  return setup;
}

/** Collects what each command reports through its `onUnknownFile` option. */
function unknownFilesReported() {
  const by: Record<string, UnknownDraftFile[]> = {};
  return {
    by,
    option(command: string) {
      by[command] = [];
      return {
        onUnknownFile: (file: UnknownDraftFile) => by[command]?.push(file),
      };
    },
  };
}

/** Desired schema for migration 2: `name` renamed to `full_name`, plus `greeting`. */
const renamedCustomers = `create table customers (
  id bigint primary key,
  full_name text not null,
  greeting text
);
`;

/**
 * A PG18 NOT NULL constraint keeps its generated name across a column
 * rename, so the script renames it too (pg-delta doesn't diff these names;
 * the rehearsal's catalog comparison would refuse the draft).
 */
const renameName = `alter table customers rename column name to full_name;
alter table customers rename constraint customers_name_not_null to customers_full_name_not_null;
`;

describe("pre- and post-migration scripts", () => {
  test("deploy runs each pending migration's pre-migration script, schema change, then post-migration script", async () => {
    const { dir, project, database } = await withFirstMigration();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      renamedCustomers,
    );
    await draft(project, { name: "rename name" });
    await dir.write("data-model/draft/pre-migration.sql", renameName);
    await draft(project);
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update customers set greeting = 'Hello ' || full_name;\n",
    );
    await finalize(project);

    const result = await deploy(project, { target: "dev" });

    expect(result.deployed.map(({ folder }) => folder)).toEqual([
      "00001-add-customers",
      "00002-rename-name",
    ]);
    expect(
      await server.query(
        "select id, full_name, greeting from customers",
        [],
        database,
      ),
    ).toEqual([{ id: "1", full_name: "Ada", greeting: "Hello Ada" }]);
  });

  test("draft diffs from the finalized migrations plus the pre-migration script, so a rename is no drop-and-add", async () => {
    const { dir, project } = await withFirstMigration();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      renamedCustomers,
    );
    const before = await draft(project, { name: "rename name" });
    expect(before.statements.map(({ sql }) => sql).join("\n")).toContain(
      "DROP COLUMN",
    );

    await dir.write("data-model/draft/pre-migration.sql", renameName);
    const after = await draft(project);

    expect(after.statements.map(({ sql }) => sql)).toEqual([
      'ALTER TABLE "public"."customers" ADD COLUMN "greeting" text;',
    ]);
    await expect(rehearse(project)).resolves.toMatchObject({
      name: "rename-name",
    });
  });

  test("a failing script fails the deployment naming the file, and nothing is applied", async () => {
    const { dir, project, database } = await withFirstMigration();
    await deploy(project, { target: "dev" });
    await server.query(
      "insert into customers (id, name) values (2, 'Grace')",
      [],
      database,
    );
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}create table orders (id bigint primary key);\n`,
    );
    await draft(project, { name: "add orders" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "insert into orders (id) values (1);\ninsert into customers (id, name) values (2, 'Bob');\n",
    );
    await finalize(project);

    const failure = deploy(project, { target: "dev" });

    await expect(failure).rejects.toBeInstanceOf(SqlFileFailedError);
    await expect(failure).rejects.toMatchObject({
      file: "data-model/migrations/00002-add-orders/post-migration.sql",
    });
    expect(
      await server.query(
        "select to_regclass('public.orders') as orders",
        [],
        database,
      ),
    ).toEqual([{ orders: null }]);
  });

  test("a rehearsal names the failing statement's file and line, with PostgreSQL's DETAIL", async () => {
    const { dir, project } = await withFirstMigration();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  phone text",
      ),
    );
    await draft(project, { name: "add phone" });
    await dir.write(
      "data-model/draft/pre-migration.sql",
      "update customers set name = name;\n\nupdate customers set name = 'x';\ninsert into customers (id, name) values (2, null);\n",
    );

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect(error).toMatchObject({
      file: "data-model/draft/pre-migration.sql",
      line: 4,
      sqlState: "23502",
      detail: expect.stringContaining("Failing row contains"),
    });
    expect((error as SqlFileFailedError).message).toMatch(
      /^data-model\/draft\/pre-migration\.sql:4: .*Failing row contains/,
    );
  });

  test("deferred constraints are checked at the end of each migration, not only at COMMIT", async () => {
    const { dir, project, database } = await deployProject(server, {
      "customers.sql": customers,
      "orders.sql": `create table orders (
  id bigint primary key,
  customer_id bigint,
  constraint orders_customer_fk foreign key (customer_id) references customers (id)
    deferrable initially deferred
);
`,
    });
    await draft(project, { name: "add orders" });
    await finalize(project);
    await deploy(project, { target: "dev" });
    await server.query(
      "insert into customers (id, name) values (1, 'Ada'); insert into orders (id, customer_id) values (1, 1)",
      [],
      database,
    );
    // Migration 2 leaves order 1 pointing at no customer; migration 3 would
    // repair it before COMMIT. Deployed one at a time, 2 fails, so deployed
    // together it must fail too.
    await draft(project, { name: "move ada" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update customers set id = 2 where id = 1;\n",
    );
    await finalize(project);
    await draft(project, { name: "move ada back" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update customers set id = 1 where id = 2;\n",
    );
    await finalize(project);

    const failure = deploy(project, { target: "dev" });

    await expect(failure).rejects.toBeInstanceOf(SqlFileFailedError);
    await expect(failure).rejects.toMatchObject({
      file: "data-model/migrations/00002-move-ada/post-migration.sql",
      postgresMessage: expect.stringContaining("orders_customer_fk"),
    });
  });

  test("ON COMMIT DROP temp tables stage data across a migration's scripts, and each migration starts with none", async () => {
    const { dir, project, database } = await withFirstMigration();
    await deploy(project, { target: "dev" });
    const staging = `create temp table staging (id bigint, name text) on commit drop;
insert into staging (id, name) select id, name from customers;
`;
    for (const [name, column] of [
      ["add greeting", "greeting"],
      ["add farewell", "farewell"],
    ] as const) {
      await dir.write(
        "data-model/desired-schema/customers.sql",
        `${customers.replace(/\n\);\n$/, "")}${column === "farewell" ? ",\n  greeting text" : ""},\n  ${column} text\n);\n`,
      );
      await draft(project, { name });
      await dir.write("data-model/draft/pre-migration.sql", staging);
      await dir.write(
        "data-model/draft/post-migration.sql",
        `update customers set ${column} = '${column} ' || s.name from staging s where s.id = customers.id;\n`,
      );
      await finalize(project);
    }

    await deploy(project, { target: "dev" });

    expect(
      await server.query(
        "select name, greeting, farewell from customers",
        [],
        database,
      ),
    ).toEqual([
      { name: "Ada", greeting: "greeting Ada", farewell: "farewell Ada" },
    ]);
  });

  test("draft reports what the scripts still need to cover, counting the rows the rehearsal data has", async () => {
    const { dir, project } = await deployProject(server, {
      "customers.sql": `create table customers (
  id bigint primary key,
  name text not null,
  email text,
  age text,
  city text
);
`,
      "legacy.sql": "create table legacy (id bigint primary key);\n",
    });
    await draft(project, { name: "add customers" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      `insert into customers (id, name, email, age, city) values (1, 'Ada', 'ada@example.com', '36', 'London');
insert into customers (id, name) values (2, 'Grace');
`,
    );
    await finalize(project);
    await dir.write("data-model/desired-schema/legacy.sql", "");
    // New tables hold no data yet: nothing to cover.
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key, reference text not null);\n",
    );
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `create table customers (
  id bigint primary key,
  name text not null,
  age integer,
  city text not null,
  phone text not null
);
`,
    );

    const result = await draft(project, { name: "reshape customers" });

    expect(
      result.toCover.map(({ kind, table, column, rows }) => ({
        kind,
        table,
        column,
        rows,
      })),
    ).toEqual(
      expect.arrayContaining([
        { kind: "dropped-table", table: "legacy", column: undefined, rows: 0 },
        {
          kind: "dropped-column",
          table: "customers",
          column: "email",
          rows: 1,
        },
        { kind: "changed-type", table: "customers", column: "age", rows: 1 },
        { kind: "set-not-null", table: "customers", column: "city", rows: 1 },
        {
          kind: "added-required-column",
          table: "customers",
          column: "phone",
          rows: 2,
        },
      ]),
    );
    expect(result.toCover).toHaveLength(5);
    expect(result.toCover.map(({ message }) => message)).toContain(
      "Column customers.email is dropped with its data (1 non-null value in the rehearsal data): rename it, or copy what you need, in the pre-migration script",
    );
    for (const item of result.toCover) {
      expect(result.statements.map(({ sql }) => sql)).toContain(item.statement);
    }

    // Covered by the pre-migration script: nothing left to report.
    await dir.write(
      "data-model/draft/pre-migration.sql",
      `drop table legacy;
alter table customers drop column email;
alter table customers alter column age type integer using age::integer;
update customers set city = 'Unknown' where city is null;
alter table customers alter column city set not null;
alter table customers add column phone text;
update customers set phone = '' where phone is null;
alter table customers alter column phone set not null;
`,
    );
    const covered = await draft(project);
    expect(covered.toCover).toEqual([]);
  });

  test("draft asks the scripts to cover a type change only when the cast could fail or lose data", async () => {
    const { dir, project } = await deployProject(server, {
      "orders.sql": `create table orders (
  id bigint primary key,
  total_cents integer not null,
  note varchar(10),
  code text,
  quantity text
);
`,
    });
    await draft(project, { name: "add orders" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "insert into orders (id, total_cents, note, code, quantity) values (1, 250, 'gift', 'ABCDEFGH', '3');\n",
    );
    await finalize(project);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      `create table orders (
  id bigint primary key,
  total_cents bigint not null,
  note text,
  code varchar(5),
  quantity integer
);
`,
    );

    const result = await draft(project, { name: "reshape orders" });

    expect(
      result.toCover.map(({ kind, column }) => ({ kind, column })),
    ).toEqual([
      { kind: "changed-type", column: "code" },
      { kind: "changed-type", column: "quantity" },
    ]);
  });

  test("a narrowing type change says values that don't fit are cut without an error, in draft and finalize", async () => {
    const { dir, project } = await withFirstMigration();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace("name text", "name varchar(5)"),
    );
    await draft(project, { name: "shorten names" });
    // Ada (3 characters) is already there from migration 1.
    await dir.write(
      "data-model/draft/seed-data.sql",
      "insert into customers (id, name) values (2, 'Real One');\n",
    );

    const result = await draft(project);

    const narrowing =
      "customers.name narrows from text to varchar(5): values longer than 5 characters are cut to 5 on every target, without an error";
    expect(result.toCover).toEqual([
      expect.objectContaining({
        kind: "changed-type",
        column: "name",
        rows: 1,
        message: `${narrowing} (1 value in the rehearsal data doesn't fit): shorten or move them in the pre-migration script if they matter`,
      }),
    ]);
    // The generated schema change keeps pg-delta's explicit cast (QA 09).
    expect(await dir.read("data-model/draft/schema-change.sql")).toContain(
      'USING "name"::character varying(5)',
    );
    const refusal = await finalize(project).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DestructiveNotAcknowledgedError);
    expect(
      (refusal as DestructiveNotAcknowledgedError).question.statements.map(
        ({ message }) => message,
      ),
    ).toEqual([narrowing]);
  });

  test("draft counts the bit strings cut and the numerics rounded by a narrowing", async () => {
    const { dir, project } = await deployProject(server, {
      "orders.sql": `create table orders (
  id bigint primary key,
  flags bit(4),
  cost numeric(6,2)
);
`,
    });
    await draft(project, { name: "add orders" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "insert into orders (id, flags, cost) values (1, B'1010', 1.25), (2, null, 2.50), (3, B'0000', 3.10);\n",
    );
    await finalize(project);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      `create table orders (
  id bigint primary key,
  flags bit(2),
  cost numeric(4,1)
);
`,
    );

    const result = await draft(project, { name: "narrow orders" });

    const counts = result.toCover.map(({ column, rows }) => ({ column, rows }));
    expect(counts).toHaveLength(2);
    expect(counts).toEqual(
      expect.arrayContaining([
        { column: "flags", rows: 2 },
        { column: "cost", rows: 1 },
      ]),
    );
  });

  test("rehearse runs the draft's scripts in deployment order, naming a failing script", async () => {
    const { dir, project } = await withFirstMigration();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers.replace(/\n\);\n$/, "")},\n  greeting text\n);\n`,
    );
    await draft(project, { name: "add greeting" });
    const backfill = "update customers set greeting = 'Hello ' || name;\n";
    // Before the schema change, the column doesn't exist yet.
    await dir.write("data-model/draft/pre-migration.sql", `\n${backfill}`);

    await expect(rehearse(project)).rejects.toMatchObject({
      file: "data-model/draft/pre-migration.sql",
      line: 2,
      postgresMessage: expect.stringContaining('column "greeting"'),
    });

    await dir.write("data-model/draft/pre-migration.sql", "");
    await dir.write("data-model/draft/post-migration.sql", backfill);
    await expect(rehearse(project)).resolves.toMatchObject({
      name: "add-greeting",
    });
  });

  test("a misnamed script never runs: draft, rehearse and finalize warn about it, and finalize still copies it", async () => {
    const { dir, project } = await deployProject(server, {
      "customers.sql": customers,
    });
    await draft(project, { name: "add customers" });
    await dir.write("data-model/draft/post-migrate.sql", "select 1/0;\n");
    const unknownFiles = [
      {
        file: "data-model/draft/post-migrate.sql",
        message:
          "data-model/draft/post-migrate.sql is not one of a draft's files, so it will not run (a draft holds draft.json, seed-data.sql, pre-migration.sql, schema-change.sql and post-migration.sql)",
      },
    ];

    const reported = unknownFilesReported();

    await draft(project, reported.option("draft"));
    await rehearse(project, reported.option("rehearse"));
    await finalize(project, reported.option("finalize"));

    expect(reported.by).toEqual({
      draft: unknownFiles,
      rehearse: unknownFiles,
      finalize: unknownFiles,
    });
    expect(
      await dir.read(
        "data-model/migrations/00001-add-customers/post-migrate.sql",
      ),
    ).toBe("select 1/0;\n");
  });

  test("a draft holding only a draft's files warns about none", async () => {
    const { dir, project } = await withFirstMigration();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers.replace(/\n\);\n$/, "")},\n  greeting text\n);\n`,
    );
    await draft(project, { name: "add greeting" });
    await dir.write(
      "data-model/draft/seed-data.sql",
      "insert into customers (id, name) values (2, 'Grace');\n",
    );
    await dir.write(
      "data-model/draft/pre-migration.sql",
      "update customers set name = trim(name);\n",
    );
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update customers set greeting = 'Hello ' || name;\n",
    );

    const reported = unknownFilesReported();

    await draft(project, reported.option("draft"));
    await rehearse(project, reported.option("rehearse"));
    await finalize(project, reported.option("finalize"));

    expect(reported.by).toEqual({ draft: [], rehearse: [], finalize: [] });
  });

  test("draft refuses DDL in a post-migration script before running anything", async () => {
    const { dir, project } = await withFirstMigration();
    await draft(project, { name: "sneak index" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "create index customers_name on customers (name);\n",
    );

    const failure = draft(project);

    await expect(failure).rejects.toBeInstanceOf(SqlRuleViolationError);
    await expect(failure).rejects.toMatchObject({
      violations: [
        {
          file: "data-model/draft/post-migration.sql",
          line: 1,
          rule: "deploy-time-statement",
        },
      ],
    });
  });
});
