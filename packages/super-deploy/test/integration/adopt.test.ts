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
  NotOwnedError,
  type Override,
  type OverrideReasonQuestion,
  type Project,
  status,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployerPreamble,
  deployProject,
  finalizeMigration,
} from "../support/deploy.ts";
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

/**
 * The adopted target has no drift, and a fresh `dev` gets the same schema
 * from migration 1.
 */
async function expectReproducedOnDev(project: Project): Promise<void> {
  expect((await status(project, { target: "prod" })).drift).toEqual([]);
  await deploy(project, { target: "dev" });
  expect((await status(project, { target: "dev" })).drift).toEqual([]);
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
      ]);
      expect(result.leftOnTarget).toEqual({ grants: 1, policies: 0 });
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
            object: expect.stringContaining("CREATE UNLOGGED TABLE"),
            reason: "Unlogged tables are not supported in V1",
          }),
        ]),
      );
      expect(objects).toHaveLength(5);
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

  test("refuses an extension once, not each of its functions, types and operators", async () => {
    const { project } = await adoptableProject(`
      create extension citext;
      create table t (id bigint primary key);
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).objects).toEqual([
        {
          object: "extension citext",
          rule: "unsupported-object",
          reason: "Extensions other than plpgsql are not supported in V1",
        },
      ]);
      expect((error as AdoptUnsupportedError).message).toContain(
        "has 1 thing V1 doesn't support: extension citext.",
      );
    } finally {
      await project.close();
    }
  });

  test("refuses a serial column once, naming the column, not its sequence", async () => {
    const { project } = await adoptableProject(`
      create table items (id serial primary key, name text not null);
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).objects).toEqual([
        {
          object: "serial column public.items.id",
          rule: "unsupported-object",
          reason:
            "serial columns are not supported: use an identity column, e.g. `bigint generated always as identity`",
        },
      ]);
      expect((error as AdoptUnsupportedError).message).toContain(
        "has 1 thing V1 doesn't support: serial column public.items.id.",
      );
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
        asked.map(({ target, object, rules, index }) => ({
          target,
          object,
          rules,
          index,
        })),
      ).toEqual([
        {
          target: "prod",
          object: "function load_staging(text)",
          rules: ["plpgsql-dynamic-sql"],
          index: 0,
        },
        {
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

  test("asks no reason while anything else is refused, never uses one for it, and says which it will ask for", async () => {
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
      expect(
        (error as AdoptUnsupportedError).overridesNeeded.map(
          ({ object, rules, file }) => ({ object, rules, file }),
        ),
      ).toEqual([
        {
          object: "function load_staging(text)",
          rules: ["plpgsql-dynamic-sql"],
          file: "data-model/desired-schema/routines.sql",
        },
        {
          object: "function ping()",
          rules: ["denylisted-call"],
          file: "data-model/desired-schema/routines.sql",
        },
      ]);
      expect((error as AdoptUnsupportedError).message).toMatch(
        /\. Once nothing else is refused, an override reason will be asked for function load_staging\(text\), function ping\(\)$/,
      );
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

  test("declares domain-typed, function-default and generated columns in CREATE TABLE, in the target's column order", async () => {
    const { dir, project } = await adoptableProject(`
      create domain email as text constraint email_check check (value like '%@%');
      create function make_code() returns text language sql volatile
        as $$ select 'ABC' || floor(random() * 1000)::int $$;
      create table people (
        id bigint generated always as identity primary key,
        contact email,
        first text not null,
        code text not null default make_code(),
        last text not null,
        full_name text generated always as (first || ' ' || last) stored,
        note text
      );
    `);
    try {
      await adopt(project, { target: "prod" });

      const tables = await dir.read("data-model/desired-schema/tables.sql");
      expect(tables).not.toContain("ALTER TABLE");
      const columns = [...tables.matchAll(/(?:\(|, )"(\w+)" /g)].map(
        (match) => match[1],
      );
      expect(columns).toEqual([
        "id",
        "contact",
        "first",
        "code",
        "last",
        "full_name",
        "note",
      ]);
      expect(tables).toContain("public.email");
      expect(tables).toContain("DEFAULT public.make_code()");
      expect(tables).toContain("GENERATED ALWAYS AS");
      await expectReproducedOnDev(project);
    } finally {
      await project.close();
    }
  });

  test("refuses enums, inheritance and storage parameters for what they are, not for ALTER TABLEs it generated", async () => {
    const { project } = await adoptableProject(`
      create type order_status as enum ('new', 'paid');
      create table orders (id bigint primary key, status order_status not null default 'new');
      create table base (id int);
      create table child (extra text) inherits (base);
      create table tmp_like (x int) with (fillfactor = 70);
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects } = error as AdoptUnsupportedError;
      expect(objects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            object: expect.stringContaining('CREATE TABLE "public"."child"'),
            reason: expect.stringContaining("Table inheritance"),
          }),
          expect.objectContaining({
            object: expect.stringContaining('CREATE TABLE "public"."tmp_like"'),
            reason: expect.stringContaining("Table storage parameters"),
          }),
          expect.objectContaining({
            object: expect.stringContaining(
              'CREATE TYPE "public"."order_status"',
            ),
            reason: expect.stringContaining("Enums are not supported in V1"),
          }),
        ]),
      );
      expect(objects).toHaveLength(3);
    } finally {
      await project.close();
    }
  });

  test("refuses a virtual generated column as virtual, though the differ renders it STORED", async () => {
    const { dir, project } = await adoptableProject(`
      create table people (
        id bigint generated always as identity primary key,
        first text not null,
        v text generated always as (upper(first)) virtual
      );
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).objects).toEqual([
        {
          object: "column v of table people",
          rule: "unsupported-object",
          reason:
            "Virtual generated columns are not supported in V1 (a generated column without STORED is virtual in PostgreSQL 18): add STORED",
        },
      ]);
      expect(dir.exists("data-model/desired-schema")).toBe(false);
    } finally {
      await project.close();
    }
  });

  test("refuses a SECURITY DEFINER routine, naming it, writing nothing", async () => {
    const { dir, project } = await adoptableProject(`
      create table notes (id bigint primary key);
      create function note_total() returns bigint language sql stable security definer
        as $$ select count(*) from notes $$;
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).objects).toEqual([
        {
          object: expect.stringContaining("note_total()"),
          rule: "unsupported-object",
          reason: expect.stringMatching(/^SECURITY DEFINER is not supported/),
        },
      ]);
      expect((error as AdoptUnsupportedError).message).toContain("note_total");
      expect(dir.exists("data-model/desired-schema")).toBe(false);
    } finally {
      await project.close();
    }
  });

  test("leaves the target's grants, revoked PUBLIC defaults, policies and row-level security out of the desired schema, counting what it left", async () => {
    const deployer = "adopt_deployer";
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create role adopt_app nologin;
      create schema app authorization ${deployer};
      do $$ begin execute format('grant create on database %I to ${deployer}', current_database()); end $$;
      set role ${deployer};
      create table app.notes (id bigint primary key, body text);
      grant usage on schema app to adopt_app;
      grant select, insert on app.notes to adopt_app;
      create function app.note_count() returns bigint language sql stable
        as $$ select count(*) from app.notes $$;
      revoke execute on function app.note_count() from public;
      grant execute on function app.note_count() to adopt_app;
      create domain app.body_text as text;
      revoke usage on domain app.body_text from public;
      alter table app.notes enable row level security;
      create policy notes_read on app.notes for select to adopt_app using (true);
    `);
    const { dir, project } = await deployProject(
      server,
      {},
      {
        settings: 'managedSchema: "app",',
        preamble: asDeployerPreamble(prod, deployer),
        otherTargets: "prod: { adapter: asDeployer },",
      },
    );
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.files).toEqual([
        "data-model/desired-schema/tables.sql",
        "data-model/desired-schema/types.sql",
        "data-model/desired-schema/routines.sql",
      ]);
      for (const file of result.files) {
        expect(await dir.read(file)).not.toMatch(
          /GRANT|REVOKE|POLICY|ROW LEVEL SECURITY/,
        );
      }
      expect(result.leftOnTarget).toEqual({ grants: 3, policies: 1 });
      await expectReproducedOnDev(project);
    } finally {
      await project.close();
    }
  });

  test("adopts a target where the deploy role has default privileges", async () => {
    const deployer = "adopt_defaults_deployer";
    const prod = await server.createDatabase(`
      create role adopt_defaults_reader nologin;
      create role ${deployer} login password 'deployer';
      do $$ begin execute format('grant connect, create on database %I to ${deployer}', current_database()); end $$;
      set role ${deployer};
      create schema app;
      alter default privileges in schema app grant select on tables to adopt_defaults_reader;
      alter default privileges revoke execute on functions from public;
      grant usage on schema app to adopt_defaults_reader;
      create table app.notes (id bigint generated always as identity primary key, body text not null);
      create function app.note_count() returns bigint language sql stable as $$ select count(*) from app.notes $$;
    `);
    const { project } = await deployProject(
      server,
      {},
      {
        settings: 'managedSchema: "app",',
        preamble: asDeployerPreamble(prod, deployer),
        otherTargets: "prod: { adapter: asDeployer },",
      },
    );
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.migration.folder).toBe("00001-adopt");
      await expectReproducedOnDev(project);
    } finally {
      await project.close();
    }
  });

  test("refuses a target whose table, view and function belong to another role, naming each, before rehearsing or writing anything, until the deploy role owns them", async () => {
    const deployer = "adopt_owned_deployer";
    const admin = "adopt_owned_admin";
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create role ${admin} nologin;
      do $$ begin execute format('grant connect, create on database %I to ${deployer}, ${admin}', current_database()); end $$;
      create schema app authorization ${deployer};
      grant usage, create on schema app to ${admin};
      set role ${admin};
      create table app.widgets (id bigint generated always as identity primary key, name text not null);
      create view app.widget_names as select name from app.widgets;
      create function app.widget_count() returns bigint language sql stable as $$ select count(*) from app.widgets $$;
    `);
    const { dir, project } = await deployProject(
      server,
      {},
      {
        settings: 'managedSchema: "app",',
        preamble: asDeployerPreamble(prod, deployer),
        otherTargets: "prod: { adapter: asDeployer },",
      },
    );
    try {
      const databases = await server.databases();

      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(NotOwnedError);
      expect(error).toMatchObject({
        code: "not-owned",
        target: "prod",
        objects: [
          {
            object: "function app.widget_count()",
            owner: admin,
            fix: `ALTER FUNCTION app.widget_count() OWNER TO ${deployer}`,
          },
          {
            object: "table app.widgets",
            owner: admin,
            fix: `ALTER TABLE app.widgets OWNER TO ${deployer}`,
          },
          {
            object: "view app.widget_names",
            owner: admin,
            fix: `ALTER VIEW app.widget_names OWNER TO ${deployer}`,
          },
        ],
      });
      expect(await server.databases()).toEqual(databases);
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);

      await server.query(
        (error as NotOwnedError).objects.map(({ fix }) => fix).join(";\n"),
        [],
        prod,
      );
      await expect(adopt(project, { target: "prod" })).resolves.toMatchObject({
        migration: { folder: "00001-adopt" },
      });
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

  test("refuses a target without the managed schema, writing nothing anywhere, but adopts an empty one", async () => {
    const prod = await server.createDatabase(
      "create schema app; create table public.t (id bigint primary key);",
    );
    const otherTargets = `prod: { adapter: postgres.target(${JSON.stringify(prod)}) },`;
    const mistyped = await deployProject(
      server,
      {},
      { otherTargets, settings: 'managedSchema: "ap",' },
    );
    try {
      const error = await adopt(mistyped.project, { target: "prod" }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(AdoptConflictError);
      expect((error as AdoptConflictError).reasons).toEqual([
        'its managed schema "ap" does not exist (check managedSchema in super-deploy.config.ts)',
      ]);
      expect(mistyped.dir.exists("data-model/migrations")).toBe(false);
      expect(mistyped.dir.exists("data-model/desired-schema")).toBe(false);
      expect(
        await server.query(
          "select 1 from pg_namespace where nspname = 'deployment_history'",
          [],
          prod,
        ),
      ).toEqual([]);
    } finally {
      await mistyped.project.close();
    }

    const { project } = await deployProject(
      server,
      {},
      { otherTargets, settings: 'managedSchema: "app",' },
    );
    try {
      const result = await adopt(project, { target: "prod" });
      expect(result.migration.folder).toBe("00001-adopt");
      expect(result.files).toEqual([]);
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
