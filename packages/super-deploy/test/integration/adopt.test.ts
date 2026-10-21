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
  type Project,
  status,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployerPreamble,
  asSuperuser,
  deployProject,
  finalizeMigration,
  roleName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

/**
 * A project whose `prod` target is a database already holding `sql`;
 * `settings` are spliced into its config.
 */
async function adoptableProject(sql: string, settings = "") {
  const prod = await server.createDatabase(sql);
  const deployed = await deployProject(
    server,
    {},
    {
      otherTargets: `prod: { adapter: ${asSuperuser(prod)} },`,
      settings,
    },
  );
  return { ...deployed, prod };
}

/**
 * A project managing schema `app` whose `prod` target is database `prod`,
 * reached as `deployer` (password `deployer`).
 */
function asDeployerProject(prod: string, deployer: string) {
  return deployProject(
    server,
    {},
    {
      settings: 'managedSchema: "app",',
      preamble: asDeployerPreamble(prod, deployer),
      otherTargets: "prod: { adapter: asDeployer },",
    },
  );
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

/** The reporter's functions (QA 132): dynamic SQL, pg_notify, and both. */
const functionsNeedingReasons = `
  create table events (id bigint primary key, kind text not null);
  create function count_rows(tbl text) returns bigint language plpgsql
    as $$ declare n bigint; begin execute format('select count(*) from %I', tbl) into n; return n; end $$;
  create function notify_event() returns void language plpgsql
    as $$ begin perform pg_notify('events', 'changed'); end $$;
  create function purge_kind(k text) returns void language plpgsql
    as $$ begin execute 'delete from events where kind = $1' using k; perform pg_notify('events', k); end $$;
`;

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
      // Two tables, a view and a function: indexes and identity sequences go with their table.
      expect(result.objects).toBe(4);
      expect(result.warning).toBeUndefined();
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

  test("refuses with every object V1 doesn't support and the rule each breaks, writing nothing", async () => {
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
      expect(objects.map(({ object, rule }) => ({ object, rule }))).toEqual(
        expect.arrayContaining([
          {
            object: "statistics object public.t_stats",
            rule: "unsupported-object",
          },
          {
            object: "operator public.===(integer,integer)",
            rule: "unsupported-object",
          },
          { object: "type public.mood", rule: "unsupported-object" },
          { object: "sequence public.counter", rule: "unsupported-object" },
          { object: "table public.scratch", rule: "unsupported-object" },
        ]),
      );
      for (const { reason } of objects) {
        expect(reason).not.toBe("");
      }
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
      // Adoption writes the marker itself, so the findings it shows don't
      // tell the person to write one.
      for (const finding of asked[0]?.needed.flatMap(
        (needed) => needed.findings,
      ) ?? []) {
        expect(finding.message).not.toContain("OVERRIDE");
      }
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
        (refused as AdoptUnsupportedError).overridesNeeded.map((o) => o.object),
      ).toEqual(["function load_staging(text)", "function ping()"]);

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

  test("without a reason callback, refuses objects that need only an override reason apart, once each with all their rules, not as unsupported", async () => {
    const { project } = await adoptableProject(functionsNeedingReasons);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const refusal = error as AdoptUnsupportedError;
      expect(refusal.objects).toEqual([]);
      expect(
        refusal.overridesNeeded.map(({ object, rules }) => ({ object, rules })),
      ).toEqual([
        {
          object: "function count_rows(text)",
          rules: ["plpgsql-dynamic-sql"],
        },
        { object: "function notify_event()", rules: ["denylisted-call"] },
        {
          object: "function purge_kind(text)",
          rules: ["denylisted-call", "plpgsql-dynamic-sql"],
        },
      ]);
      expect(refusal.message).not.toContain("doesn't support");
      expect(refusal.advice).toEqual([
        "run adoption in a terminal to give an override reason for each object that breaks only risk rules",
      ]);
    } finally {
      await project.close();
    }
  });

  test("without a reason callback, counts only what V1 doesn't support as such, listing the objects that need a reason apart", async () => {
    const { project } = await adoptableProject(
      `${functionsNeedingReasons} create type mood as enum ('sad', 'happy');`,
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const refusal = error as AdoptUnsupportedError;
      expect(refusal.objects.map(({ object }) => object)).toEqual([
        "type public.mood",
      ]);
      expect(refusal.overridesNeeded).toHaveLength(3);
      expect(refusal.summary).toContain(
        "its managed schema has 1 thing V1 doesn't support and 3 objects need an override reason",
      );
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
          { object: "type public.mood", rule: "unsupported-object" },
          { object: "function public.batch()", rule: "plpgsql-dynamic-sql" },
          {
            object: "function public.batch()",
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
        /\. Once nothing else is refused, adoption will ask an override reason for 2 objects that break only risk rules: function load_staging\(text\), function ping\(\)$/,
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
        otherTargets: `prod: { adapter: ${asSuperuser(prod)} },`,
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
            object: "table public.child",
            reason: expect.stringContaining("Table inheritance"),
          }),
          expect.objectContaining({
            object: "table public.tmp_like",
            reason: expect.stringContaining("Table storage parameters"),
          }),
          expect.objectContaining({
            object: "type public.order_status",
            reason: expect.stringContaining("Enums are not supported in V1"),
          }),
        ]),
      );
      expect(objects).toHaveLength(3);
    } finally {
      await project.close();
    }
  });

  test("names every refused statement by its object, and its reason by the references or parameters refused", async () => {
    const { project } = await adoptableProject(
      `
      create extension citext;
      create extension pgcrypto;
      create schema app;
      create table app.users (
        id int primary key,
        email public.citext not null,
        token bytea not null default public.gen_random_bytes(16)
      );
      create table app.logs (
        id bigint primary key,
        created timestamp with time zone not null default now(),
        note text
      ) with (fillfactor = 70);
      create sequence app.ticket_seq;
      create table app.base (id int primary key);
      create function app.check_base() returns trigger language plpgsql as $$ begin return null; end $$;
      create constraint trigger ct after insert on app.base deferrable for each row execute function app.check_base();
      create function app.users_named(wanted public.citext) returns bigint language sql stable
        as $$ select count(*) from app.users where email = wanted $$;
    `,
      'managedSchema: "app",',
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects } = error as AdoptUnsupportedError;
      expect(objects).toEqual(
        expect.arrayContaining([
          {
            object: "table app.users",
            rule: "undeclared-schema",
            reason: expect.stringMatching(
              /public\.citext, public\.gen_random_bytes.*declaring it in externalSchemas won't help/,
            ),
          },
          {
            object: "table app.logs",
            rule: "unsupported-object",
            reason: expect.stringContaining("fillfactor=70"),
          },
          expect.objectContaining({ object: "sequence app.ticket_seq" }),
          expect.objectContaining({ object: "trigger ct on table app.base" }),
          expect.objectContaining({
            object: "function app.users_named(public.citext)",
          }),
        ]),
      );
      for (const { object } of objects) {
        expect(object).not.toMatch(/^(CREATE|ALTER) |…$/);
      }
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
          object: "column v of table public.people",
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
    const { dir, project } = await asDeployerProject(prod, deployer);
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
    const { project } = await asDeployerProject(prod, deployer);
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.migration.folder).toBe("00001-adopt");
      await expectReproducedOnDev(project);
    } finally {
      await project.close();
    }
  });

  test("refuses a target whose table, view and function belong to another role, naming each with its fix, writing nothing, until the deploy role owns them", async () => {
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
    const { dir, project } = await asDeployerProject(prod, deployer);
    try {
      const databases = await server.databases();

      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect(error).toMatchObject({
        code: "adopt-unsupported",
        target: "prod",
        objects: [],
        historySchemaNotCreatable: undefined,
        notOwned: [
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
      expect((error as Error).message).toContain(
        `table app.widgets is owned by ${admin}, whose privileges the deploy role doesn't have (fix: ALTER TABLE app.widgets OWNER TO ${deployer})`,
      );
      expect(await server.databases()).toEqual(databases);
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);

      await server.query(
        (error as AdoptUnsupportedError).notOwned
          .map(({ fix }) => fix)
          .join(";\n"),
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

  test("refuses public owned by pg_database_owner with the database's owner and ALTER DATABASE as its fix, until the deploy role owns the database", async () => {
    const deployer = roleName("adopt_public_deployer");
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      do $$ begin execute format('grant connect, create on database %I to ${deployer}', current_database()); end $$;
      create table public.t (id bigint generated always as identity primary key);
      alter table public.t owner to ${deployer};
    `);
    const { project } = await deployProject(
      server,
      {},
      {
        preamble: asDeployerPreamble(prod, deployer),
        otherTargets: "prod: { adapter: asDeployer },",
      },
    );
    try {
      const fix = `ALTER DATABASE ${prod} OWNER TO ${deployer}`;
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).notOwned).toEqual([
        {
          object: "schema public",
          owner: `pg_database_owner (the owner of database ${prod}, super_deploy)`,
          fix,
        },
      ]);
      expect(
        (await status(project, { target: "prod" })).preflight.notOwned,
      ).toEqual([expect.objectContaining({ fix })]);

      await server.query(fix, [], prod);
      await expect(adopt(project, { target: "prod" })).resolves.toMatchObject({
        migration: { folder: "00001-adopt" },
      });
    } finally {
      await project.close();
    }
  });

  test("refuses a target whose deploy role can't create the history schema, naming the grant, writing nothing, until it can", async () => {
    const deployer = roleName("adopt_deployer");
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create schema app authorization ${deployer};
      set role ${deployer};
      create table app.t (id bigint generated always as identity primary key);
    `);
    const { dir, project } = await asDeployerProject(prod, deployer);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect(error).toMatchObject({
        code: "adopt-unsupported",
        target: "prod",
        objects: [],
        notOwned: [],
        historySchemaNotCreatable: {
          role: deployer,
          database: prod,
          historySchema: "deployment_history",
          fix: `GRANT CREATE ON DATABASE ${prod} TO ${deployer}`,
        },
      });
      expect((error as Error).message).toContain(
        `the deploy role ${deployer} needs CREATE on database ${prod} to create the history schema "deployment_history"`,
      );
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);

      await server.query(
        (error as AdoptUnsupportedError).historySchemaNotCreatable?.fix ?? "",
      );
      await expect(adopt(project, { target: "prod" })).resolves.toMatchObject({
        migration: { folder: "00001-adopt" },
      });
    } finally {
      await project.close();
    }
  });

  test("adopts, and deploys to, a target whose DBA pre-created an empty history schema owned by the deploy role instead of granting CREATE on the database", async () => {
    const deployer = roleName("adopt_deployer");
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create schema app authorization ${deployer};
      create schema deployment_history authorization ${deployer};
      set role ${deployer};
      create table app.t (id bigint generated always as identity primary key);
    `);
    const { dir, project } = await asDeployerProject(prod, deployer);
    try {
      await expect(adopt(project, { target: "prod" })).resolves.toMatchObject({
        migration: { folder: "00001-adopt" },
      });
      await dir.write(
        "data-model/desired-schema/notes.sql",
        "create table notes (id bigint primary key);\n",
      );
      await finalizeMigration(project, "add notes");

      await expect(deploy(project, { target: "prod" })).resolves.toMatchObject({
        deployed: [{ folder: "00002-add-notes" }],
      });
      expect(
        (await status(project, { target: "prod" })).recorded.map(
          (migration) => migration.number,
        ),
      ).toEqual([1, 2]);
    } finally {
      await project.close();
    }
  });

  test("refuses a target whose history schema holds objects super-deploy didn't make, naming the schema, what it holds and the setting, writing nothing", async () => {
    const prod = `
      create schema audit;
      create table audit.migrations (x int);
      create table audit.log (y int);
      create table customers (id bigint primary key);
    `;
    const {
      dir,
      project,
      prod: database,
    } = await adoptableProject(prod, 'historySchema: "audit",');
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect(error).toMatchObject({
        objects: [],
        notOwned: [],
        historySchemaNotCreatable: undefined,
        foreignHistorySchema: {
          historySchema: "audit",
          objects: ["table audit.log", "table audit.migrations"],
        },
      });
      expect((error as Error).message).toContain(
        `the history schema "audit" exists but super-deploy didn't make it: it holds table audit.log, table audit.migrations`,
      );
      expect((error as Error).message).toContain("historySchema");
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);
      expect(
        await server.query(
          "select table_name from information_schema.tables where table_schema = 'audit' order by 1",
          [],
          database,
        ),
      ).toEqual([{ table_name: "log" }, { table_name: "migrations" }]);
    } finally {
      await project.close();
    }
  });

  test("refuses once for everything: objects owned by another role, CREATE on the database and what V1 doesn't support, listing an object that is both only as unsupported", async () => {
    const deployer = roleName("adopt_deployer");
    const other = roleName("adopt_other");
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create role ${other} nologin;
      create schema app authorization ${deployer};
      grant usage, create on schema app to ${other};
      set role ${deployer};
      create unlogged table app.scratch (id bigint primary key, a int, b int);
      set role ${other};
      create table app.owned_by_other (id bigint primary key);
      reset role;
      create statistics app.scratch_stats (dependencies) on a, b from app.scratch;
    `);
    const { dir, project } = await asDeployerProject(prod, deployer);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const refusal = error as AdoptUnsupportedError;
      expect(refusal.notOwned.map(({ object }) => object)).toEqual([
        "table app.owned_by_other",
      ]);
      expect(refusal.historySchemaNotCreatable?.fix).toBe(
        `GRANT CREATE ON DATABASE ${prod} TO ${deployer}`,
      );
      expect(refusal.objects.map(({ object }) => object)).toEqual(
        expect.arrayContaining([
          "table app.scratch",
          "statistics object app.scratch_stats",
        ]),
      );
      expect(refusal.objects).toHaveLength(2);
      expect(dir.exists("data-model/desired-schema")).toBe(false);
    } finally {
      await project.close();
    }
  });

  test("reads a target whose schema and everything in it belong to a superuser, refusing once with every fix, and adopts once they are run", async () => {
    const deployer = roleName("adopt_deployer");
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create schema shop;
      create domain shop.email as text constraint email_has_at check (value like '%@%');
      create table shop.customers (id bigint generated always as identity primary key, email shop.email not null);
      create view shop.customer_emails as select email from shop.customers;
      create function shop.customer_count(since bigint) returns bigint language sql stable
        as $$ select count(*) from shop.customers where id > since $$;
    `);
    const { project } = await deployProject(
      server,
      {},
      {
        settings: 'managedSchema: "shop",',
        preamble: asDeployerPreamble(prod, deployer),
        otherTargets: "prod: { adapter: asDeployer },",
      },
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const refusal = error as AdoptUnsupportedError;
      expect(refusal.objects).toEqual([]);
      expect(refusal.notOwned.map(({ object }) => object)).toEqual([
        "schema shop",
        "domain shop.email",
        "function shop.customer_count(since bigint)",
        "table shop.customers",
        "view shop.customer_emails",
      ]);
      expect(refusal.historySchemaNotCreatable).toBeDefined();

      await server.query(
        [
          ...refusal.notOwned.map(({ fix }) => fix),
          refusal.historySchemaNotCreatable?.fix,
        ].join(";\n"),
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

  test("refuses every reference to an external schema bound at CREATE at once, naming each object, and adopts once only PL/pgSQL bodies have them", async () => {
    const { dir, project, prod } = await adoptableProject(
      `
      create schema auth;
      create table auth.users (id bigint primary key, name text);
      create table profiles (
        user_id bigint primary key references auth.users (id),
        bio text
      );
      create view profile_names as
        select p.user_id, u.name from profiles p join auth.users u on u.id = p.user_id;
      create function user_name(uid bigint) returns text language sql stable
        as $$ select name from auth.users where id = uid $$;
      create function user_count() returns bigint language plpgsql stable
        as $$ begin return (select count(*) from auth.users); end $$;
    `,
      'externalSchemas: ["auth"],',
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects, message } = error as AdoptUnsupportedError;
      const reason = expect.stringContaining(
        'external schema "auth", which rehearsals don\'t contain. Only PL/pgSQL bodies may reference external schemas',
      );
      expect(objects).toEqual(
        expect.arrayContaining([
          {
            object: "constraint profiles_user_id_fkey on table public.profiles",
            rule: "outside-managed-schema",
            reason,
          },
          {
            object: "view public.profile_names",
            rule: "outside-managed-schema",
            reason,
          },
          {
            object: "function public.user_name(bigint)",
            rule: "outside-managed-schema",
            reason,
          },
        ]),
      );
      expect(objects).toHaveLength(3);
      expect(message).not.toContain("data-model/desired-schema");
      expect(dir.exists("data-model/desired-schema")).toBe(false);

      await server.query(
        "drop view profile_names; drop function user_name(bigint); alter table profiles drop constraint profiles_user_id_fkey",
        [],
        prod,
      );
      const result = await adopt(project, { target: "prod" });
      expect(result.migration.folder).toBe("00001-adopt");
    } finally {
      await project.close();
    }
  });

  test("refusing a PL/pgSQL body's reference to an undeclared schema, advises declaring it in externalSchemas, not changing the target", async () => {
    const { project } = await adoptableProject(`
      create schema auth;
      create table auth.users (id bigint primary key, name text);
      create function user_count() returns bigint language plpgsql stable
        as $$ begin return (select count(*) from auth.users); end $$;
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      expect((error as AdoptUnsupportedError).message).toMatch(
        /\. Nothing was written; declare "auth" in externalSchemas in super-deploy\.config\.ts$/,
      );
    } finally {
      await project.close();
    }
  });

  test("refusing a view's or a LANGUAGE sql body's reference to an undeclared schema, advises changing the target, not declaring it", async () => {
    // Bound at CREATE: declaring auth would only trade this refusal for the
    // external-schema one.
    const { project } = await adoptableProject(`
      create schema auth;
      create table auth.users (id bigint primary key, name text);
      create view user_names as select name from auth.users;
      create function user_name(uid bigint) returns text language sql stable
        as $$ select name from auth.users where id = uid $$;
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects, advice } = error as AdoptUnsupportedError;
      expect(objects.map(({ rule }) => rule)).toEqual([
        "undeclared-schema",
        "undeclared-schema",
      ]);
      expect(advice).toEqual(["change the target first, then adopt again"]);
    } finally {
      await project.close();
    }
  });

  test("refusing for several causes, gives each piece of advice once", async () => {
    const { project } = await adoptableProject(`${loaders}
      create type mood as enum ('sad', 'happy');
      create schema auth;
      create schema billing;
      create table auth.users (id bigint primary key, name text);
      create table billing.accounts (id bigint primary key);
      create function user_count() returns bigint language plpgsql stable
        as $$ begin return (select count(*) from auth.users); end $$;
      create function first_user() returns text language plpgsql stable
        as $$ begin return (select name from auth.users limit 1); end $$;
      create function account_count() returns bigint language plpgsql stable
        as $$ begin return (select count(*) from billing.accounts); end $$;
    `);
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const advice = [
        "change the target first, then adopt again",
        'declare "auth", "billing" in externalSchemas in super-deploy.config.ts',
        "run adoption in a terminal to give an override reason for each object that breaks only risk rules",
      ];
      expect((error as AdoptUnsupportedError).advice).toEqual(advice);
      expect((error as AdoptUnsupportedError).message).toMatch(
        new RegExp(`\\. Nothing was written; ${advice.join("; ")}$`),
      );
    } finally {
      await project.close();
    }
  });

  test("refuses a statement the throwaway database refuses by its object, not by a file it never wrote", async () => {
    // The declaration names auth.users unqualified, through the creator's
    // search_path: no static check can see the external schema.
    const { dir, project } = await adoptableProject(
      `
      create schema auth;
      create table auth.users (id bigint primary key, name text);
      set search_path = public, auth;
      create function no_name() returns text language plpgsql stable
        as $$ declare n users.name%type; begin return n; end $$;
    `,
      'externalSchemas: ["auth"],',
    );
    try {
      const error = await adopt(project, { target: "prod" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(AdoptUnsupportedError);
      const { objects, message } = error as AdoptUnsupportedError;
      expect(objects).toEqual([
        {
          object: "function public.no_name()",
          rule: "not-reproduced",
          reason: expect.stringContaining('relation "users" does not exist'),
        },
      ]);
      expect(message).not.toContain("data-model/desired-schema");
      expect(dir.exists("data-model/desired-schema")).toBe(false);
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
        object: "constraint people_name_required on table public.people",
        rule: "not-reproduced",
        reason:
          "The desired schema generated from the target can't create it: constraint: people people_name_required n NOT NULL name deferrable=false deferred=false validated=true",
      });
      expect(dir.exists("data-model/desired-schema")).toBe(false);
    } finally {
      await project.close();
    }
  });

  test("refuses a project that already has migrations, a draft or a desired schema", async () => {
    const prod = await server.createDatabase();
    const targets = {
      otherTargets: `prod: { adapter: ${asSuperuser(prod)} },`,
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
    const otherTargets = `prod: { adapter: ${asSuperuser(prod)} },`;
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
        'its managed schema "ap" does not exist (check managedSchema in super-deploy.config.ts); the target has schemas app, public',
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

  test("refusing a missing managed schema, lists the target's schemas, and says to rename one that differs only in case", async () => {
    const prod = await server.createDatabase(`
      create schema shop; create table shop.t (id bigint primary key);
      create schema "MyApp";
    `);
    const otherTargets = `prod: { adapter: ${asSuperuser(prod)} },`;
    const refusal = async (managedSchema: string) => {
      const { dir, project } = await deployProject(
        server,
        {},
        { otherTargets, settings: `managedSchema: "${managedSchema}",` },
      );
      try {
        const error = await adopt(project, { target: "prod" }).catch(
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(AdoptConflictError);
        expect(dir.exists("data-model/migrations")).toBe(false);
        expect(dir.exists("data-model/desired-schema")).toBe(false);
        return (error as AdoptConflictError).reasons.join("; ");
      } finally {
        await project.close();
      }
    };

    expect(await refusal("shpo")).toBe(
      'its managed schema "shpo" does not exist (check managedSchema in super-deploy.config.ts); the target has schemas "MyApp", public, shop',
    );
    expect(await refusal("myapp")).toBe(
      'its managed schema "myapp" does not exist (check managedSchema in super-deploy.config.ts); the target has schemas "MyApp", public, shop; managedSchema must be lowercase: rename schema "MyApp" first (ALTER SCHEMA "MyApp" RENAME TO myapp), and the application\'s references to it',
    );
    expect(
      await server.query(
        "select 1 from pg_namespace where nspname = 'deployment_history'",
        [],
        prod,
      ),
    ).toEqual([]);
  });

  test("adopting an empty managed schema warns it adopted nothing, naming the other schemas that hold objects", async () => {
    const prod = await server.createDatabase(`
      create schema app;
      create table app.customers (id bigint primary key);
      create table app.orders (id bigint primary key);
      create view app.order_ids as select id from app.orders;
      create schema reports;
      create function reports.answer() returns int language sql as $$ select 42 $$;
      create schema empty;
    `);
    const { project } = await deployProject(
      server,
      {},
      { otherTargets: `prod: { adapter: ${asSuperuser(prod)} },` },
    );
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.migration.folder).toBe("00001-adopt");
      expect(result.objects).toBe(0);
      expect(result.warning).toBe(
        "Adopted 0 objects from schema public; schema app holds 2 tables, 1 view; schema reports holds 1 function: is managedSchema right?",
      );
    } finally {
      await project.close();
    }
  });

  test("adopting an empty managed schema in an otherwise empty database warns only that it adopted nothing", async () => {
    const prod = await server.createDatabase();
    const { project } = await deployProject(
      server,
      {},
      { otherTargets: `prod: { adapter: ${asSuperuser(prod)} },` },
    );
    try {
      const result = await adopt(project, { target: "prod" });

      expect(result.objects).toBe(0);
      expect(result.warning).toBe("Adopted 0 objects from schema public");
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
const prodAdapter = ${asSuperuser(prod)};
const changing = {
  async connect() {
    const session = await prodAdapter.connect();
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
        ["index public.added_meanwhile_pkey", "table public.added_meanwhile"],
      );
      // The project had neither directory: adoption created both.
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/draft")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);
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
