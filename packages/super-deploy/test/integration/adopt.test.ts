// API seam: `init --adopt <target>` (the `adopt` function) brings an existing
// database under management in an initialised project with no migrations:
// its managed schema becomes the desired schema and migration 00001-adopt,
// recorded on the target as marked after mark's replica check.
import { readdir, rm } from "node:fs/promises";
import {
  AdoptCancelledError,
  AdoptConflictError,
  AdoptUnsupportedError,
  adopt,
  deploy,
  draft,
  MarkMismatchError,
  type Override,
  type OverrideReasonQuestion,
  status,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deployProject, finalizeMigration } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

/** A project whose `prod` target is a database already holding `sql`. */
async function adoptableProject(sql: string) {
  const prod = await server.createDatabase(sql);
  const deployed = await deployProject(
    server,
    {},
    {
      otherTargets: `prod: { adapter: postgres.target(${JSON.stringify(prod)}) },`,
    },
  );
  return { ...deployed, prod };
}

const shop = `
create role adopt_reader nologin;
create table customers (
  id bigint generated always as identity primary key,
  name text not null,
  email text constraint customers_email_key unique
);
create table orders (
  id bigint primary key,
  customer_id bigint not null constraint orders_customer_fk references customers (id),
  total numeric(10, 2) constraint orders_total_check check (total >= 0)
);
create index orders_customer_idx on orders (customer_id);
create view big_orders as select id, total from orders where total > 100;
create function order_count(c bigint) returns bigint language sql stable
  as $$ select count(*) from orders where customer_id = c $$;
comment on table customers is 'People who order';
grant select on customers to adopt_reader;
insert into customers (name) values ('Ada');
`;

/** Functions a desired schema needs an override marker for. */
const loaders = `
create table staging (id bigint primary key);
create function load_staging(source text) returns void language plpgsql
  as $$ begin execute format('insert into staging select * from %I', source); end $$;
create function ping() returns void language sql
  as $$ select pg_notify('orders', '') $$;
`;
const reasons: Record<string, string> = {
  "function load_staging(text)": "loads tables named by the caller",
  "function ping()": "wakes the order worker",
};

describe("adopt", () => {
  test("turns the target's managed schema into migration 1 and records it there as marked", async () => {
    const { dir, project, prod } = await adoptableProject(shop);
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.migration.folder).toBe("00001-adopt");
      expect(result.files).toEqual([
        "data-model/desired-schema/tables.sql",
        "data-model/desired-schema/indexes.sql",
        "data-model/desired-schema/views.sql",
        "data-model/desired-schema/routines.sql",
        "data-model/desired-schema/comments.sql",
        "data-model/desired-schema/grants.sql",
      ]);
      expect(await dir.read("data-model/desired-schema/grants.sql")).toContain(
        'GRANT SELECT ON TABLE "public"."customers" TO "adopt_reader";',
      );
      const written = await readdir(dir.path("data-model/desired-schema"));
      expect(written.filter((file) => file.endsWith(".sql")).sort()).toEqual(
        result.files.map((file) => file.split("/").at(-1)).sort(),
      );
      expect(dir.exists("data-model/migrations/00001-adopt")).toBe(true);
      expect(dir.exists("data-model/draft")).toBe(false);

      const report = await status(project, { target: "prod" });
      expect(report.recorded).toMatchObject([
        { number: 1, name: "adopt", recordedHow: "marked" },
      ]);
      expect(report.pending).toEqual([]);
      expect(report.drift).toEqual([]);
      // Marking ran nothing: the data is untouched.
      expect(
        await server.query("select name from customers", [], prod),
      ).toEqual([{ name: "Ada" }]);

      // A fresh target gets the same schema from migration 1.
      await deploy(project, { target: "dev" });
      expect((await status(project, { target: "dev" })).drift).toEqual([]);
    } finally {
      await project.close();
    }
  });

  test("refuses with every object V1 doesn't support, in the rules' words, writing nothing", async () => {
    const { dir, project, prod } = await adoptableProject(`
      create table t (id bigint primary key, a int, b int);
      create type mood as enum ('sad', 'happy');
      create sequence counter;
      create statistics t_stats (dependencies) on a, b from t;
      create function same(int, int) returns boolean language sql immutable as 'select $1 = $2';
      create operator === (leftarg = int, rightarg = int, function = same);
      revoke execute on function same(int, int) from public;
      create unlogged table scratch (id bigint primary key);
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects } = error as AdoptUnsupportedError;
      expect(objects).toEqual(
        expect.arrayContaining([
          {
            object: "statistics object t_stats",
            rule: "unsupported-object",
            reason: "CREATE STATISTICS is not supported in V1",
          },
          {
            object: "operator ===(integer,integer)",
            rule: "unsupported-object",
            reason:
              "Custom operators are not supported in V1 (nor operator classes and families)",
          },
          expect.objectContaining({
            object: expect.stringContaining('CREATE TYPE "public"."mood"'),
            reason: expect.stringContaining("Enums are not supported in V1"),
          }),
          expect.objectContaining({
            object: expect.stringContaining(
              'CREATE SEQUENCE "public"."counter"',
            ),
            reason: expect.stringContaining("Standalone sequences"),
          }),
          expect.objectContaining({
            object: expect.stringContaining("REVOKE"),
            reason: expect.stringContaining("REVOKE is not allowed"),
          }),
          expect.objectContaining({
            object: expect.stringContaining("CREATE UNLOGGED TABLE"),
            reason: "Unlogged tables are not supported in V1",
          }),
        ]),
      );
      expect(objects).toHaveLength(6);
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);
      expect(
        await server.query(
          "select 1 from pg_namespace where nspname = 'deployment_history'",
          [],
          prod,
        ),
      ).toEqual([]);
    } finally {
      await project.close();
    }
  });

  test("asks a reason for each function that needs an override marker and writes the marker with it", async () => {
    const { dir, project } = await adoptableProject(loaders);
    try {
      const asked: OverrideReasonQuestion[] = [];
      const result = await adopt(project, {
        target: "prod",
        overrideReason: (question) => {
          asked.push(question);
          return `  ${reasons[question.object]}  `;
        },
      });

      expect(
        asked.map(({ kind, target, object, rules, index }) => ({
          kind,
          target,
          object,
          rules,
          index,
        })),
      ).toEqual([
        {
          kind: "override-reason",
          target: "prod",
          object: "function load_staging(text)",
          rules: ["plpgsql-dynamic-sql"],
          index: 0,
        },
        {
          kind: "override-reason",
          target: "prod",
          object: "function ping()",
          rules: ["denylisted-call"],
          index: 1,
        },
      ]);
      expect(asked[0]?.needed.map((needed) => needed.object)).toEqual([
        "function load_staging(text)",
        "function ping()",
      ]);
      const routines = (
        await dir.read("data-model/desired-schema/routines.sql")
      ).split("\n");
      for (const [object, reason] of Object.entries(reasons)) {
        const name = /function (\w+)/.exec(object)?.[1];
        const at = routines.findIndex((line) =>
          line.startsWith(`CREATE FUNCTION public.${name}(`),
        );
        expect(at).toBeGreaterThan(0);
        expect(routines[at - 1]).toBe(
          `-- OVERRIDE SUPER-DEPLOY REFUSAL: ${reason}`,
        );
      }

      const overrides = (o: readonly Override[]) =>
        o.map(({ object, rules, reason }) => ({ object, rules, reason }));
      const expected = [
        {
          object: "function load_staging(text)",
          rules: ["plpgsql-dynamic-sql"],
          reason: reasons["function load_staging(text)"],
        },
        {
          object: "function ping()",
          rules: ["denylisted-call"],
          reason: reasons["function ping()"],
        },
      ];
      expect(overrides(result.overrides)).toEqual(expected);
      expect(
        result.overrides.every(
          (override) => override.file === "schema-change.sql",
        ),
      ).toBe(true);
      const report = await validate(project);
      expect(overrides(report.overrides)).toEqual([...expected, ...expected]);
      expect((await status(project, { target: "prod" })).drift).toEqual([]);
    } finally {
      await project.close();
    }
  });

  test("refuses functions that need an override marker without a reason callback, and cancels on an empty reason, writing nothing", async () => {
    const { dir, project, prod } = await adoptableProject(loaders);
    try {
      const refused = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(AdoptUnsupportedError);
      expect(
        (refused as AdoptUnsupportedError).objects.map((o) => o.rule),
      ).toEqual(["plpgsql-dynamic-sql", "denylisted-call"]);

      const cancelled = await adopt(project, {
        target: "prod",
        overrideReason: ({ index }) => (index === 0 ? "a reason" : " "),
      }).catch((e: unknown) => e);
      expect(cancelled).toBeInstanceOf(AdoptCancelledError);
      expect(cancelled).toMatchObject({
        code: "adopt-cancelled",
        target: "prod",
        object: "function ping()",
      });
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);
      expect(
        await server.query(
          "select 1 from pg_namespace where nspname = 'deployment_history'",
          [],
          prod,
        ),
      ).toEqual([]);
    } finally {
      await project.close();
    }
  });

  test("asks no reason while anything else is refused, and never uses one for it", async () => {
    const { project } = await adoptableProject(`${loaders}
      create type mood as enum ('sad', 'happy');
      create procedure batch() language plpgsql
        as $$ begin execute 'select 1'; commit; end $$;
    `);
    try {
      let asked = 0;
      const error = await adopt(project, {
        target: "prod",
        overrideReason: () => {
          asked += 1;
          return "a reason";
        },
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects } = error as AdoptUnsupportedError;
      expect(objects.map(({ object, rule }) => ({ object, rule }))).toEqual(
        expect.arrayContaining([
          {
            object: expect.stringContaining('CREATE TYPE "public"."mood"'),
            rule: "unsupported-object",
          },
          {
            object: expect.stringContaining("CREATE PROCEDURE public.batch()"),
            rule: "plpgsql-dynamic-sql",
          },
          {
            object: expect.stringContaining("CREATE PROCEDURE public.batch()"),
            rule: "plpgsql-transaction-control",
          },
        ]),
      );
      expect(objects).toHaveLength(3);
      expect(asked).toBe(0);
    } finally {
      await project.close();
    }
  });

  test("ignores everything outside the managed schema, and ownership", async () => {
    const prod = await server.createDatabase(`
      create role adopt_owner nologin;
      create schema app;
      create schema reporting;
      create table reporting.daily (day date primary key);
      create table public.legacy (id int);
      create table app.accounts (id bigint primary key, day date);
      alter table app.accounts owner to adopt_owner;
      create view app.recent as select id from app.accounts;
      comment on schema app is 'The application';
    `);
    const { dir, project } = await deployProject(
      server,
      {},
      {
        settings: 'managedSchema: "app",',
        otherTargets: `prod: { adapter: postgres.target(${JSON.stringify(prod)}) },`,
      },
    );
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.files).toEqual([
        "data-model/desired-schema/tables.sql",
        "data-model/desired-schema/views.sql",
      ]);
      const tables = await dir.read("data-model/desired-schema/tables.sql");
      expect(tables).toContain('CREATE TABLE "app"."accounts"');
      expect(tables).not.toMatch(/legacy|daily|OWNER/);
      expect((await status(project, { target: "prod" })).drift).toEqual([]);
    } finally {
      await project.close();
    }
  });

  test("refuses objects a desired schema can't reproduce exactly", async () => {
    // pg-delta drops a NOT NULL constraint's own name (a known gap).
    const { dir, project } = await adoptableProject(
      "create table people (id bigint primary key, name text constraint people_name_required not null);",
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).objects).toContainEqual({
        object: "constraint people_name_required on table people",
        rule: "not-reproduced",
        reason:
          "The desired schema generated from the target can't create it: - constraint: people people_name_required n NOT NULL name deferrable=false deferred=false validated=true",
      });
      expect(dir.exists("data-model/desired-schema")).toBe(false);
    } finally {
      await project.close();
    }
  });

  test("refuses a project that already has migrations, a draft or a desired schema", async () => {
    const prod = await server.createDatabase();
    const targets = {
      otherTargets: `prod: { adapter: postgres.target(${JSON.stringify(prod)}) },`,
    };
    const finalized = await deployProject(
      server,
      { "t.sql": "create table t (id bigint primary key);\n" },
      targets,
    );
    try {
      await finalizeMigration(finalized.project, "first");
      await rm(finalized.dir.path("data-model/desired-schema/t.sql"));
      const error = await adopt(finalized.project, { target: "prod" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AdoptConflictError);
      expect(error).toMatchObject({
        code: "adopt-conflict",
        reasons: [
          "the project already has migrations in data-model/migrations",
        ],
      });
    } finally {
      await finalized.project.close();
    }

    const drafted = await deployProject(
      server,
      { "t.sql": "create table t (id bigint primary key);\n" },
      targets,
    );
    try {
      await draft(drafted.project, { name: "first" });
      const error = await adopt(drafted.project, { target: "prod" }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        code: "adopt-conflict",
        reasons: [
          "the project already has a draft in data-model/draft",
          "the desired schema already has data-model/desired-schema/t.sql",
        ],
      });
    } finally {
      await drafted.project.close();
    }
    expect(
      await server.query(
        "select 1 from pg_namespace where nspname = 'deployment_history'",
        [],
        prod,
      ),
    ).toEqual([]);
  });

  test("refuses a target that already records migrations", async () => {
    const managed = await deployProject(server, {
      "t.sql": "create table t (id bigint primary key);\n",
    });
    try {
      await finalizeMigration(managed.project, "first");
      await deploy(managed.project, { target: "dev" });
    } finally {
      await managed.project.close();
    }
    const { project } = await deployProject(
      server,
      {},
      {
        otherTargets: `prod: { adapter: postgres.target(${JSON.stringify(managed.database)}) },`,
      },
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AdoptConflictError);
      expect((error as AdoptConflictError).reasons).toEqual([
        'it already records 1 migration in its history schema "deployment_history"',
      ]);
    } finally {
      await project.close();
    }
  });

  test("removes everything it wrote when the target no longer matches at marking time", async () => {
    const prod = await server.createDatabase(
      "create table t (id bigint primary key);",
    );
    // The second connection is the marking one: someone adds a table first.
    const { dir, project } = await deployProject(
      server,
      {},
      {
        preamble: `let connects = 0;
const changing = {
  async connect() {
    const session = await postgres.target(${JSON.stringify(prod)}).connect();
    connects += 1;
    if (connects === 2) {
      await session.execute("create table added_meanwhile (id bigint primary key)");
    }
    return session;
  },
};`,
        otherTargets: "prod: { adapter: changing },",
      },
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(MarkMismatchError);
      expect((error as MarkMismatchError).objects.map((o) => o.object)).toEqual(
        ["index added_meanwhile_pkey", "table added_meanwhile"],
      );
      expect(await readdir(dir.path("data-model/desired-schema"))).toEqual([]);
      expect(dir.exists("data-model/draft")).toBe(false);
      expect(await readdir(dir.path("data-model/migrations"))).toEqual([]);
      const report = await status(project, { target: "prod" });
      expect(report.recorded).toEqual([]);
      expect(report.attempts).toMatchObject([
        { command: "init --adopt", outcome: "failed" },
      ]);
    } finally {
      await project.close();
    }
  });
});
