// API seam: grants, default privileges, policies and row-level security on a
// target are set up outside super-deploy (ADR-0006). Nothing compares,
// generates, revokes or resets them: they are never drift, and deployments
// leave them as they are. The desired schema can't declare them. status and
// deploy warn when the pending migrations drop and recreate an object whose
// hand-made privileges or policies default privileges won't give back. A
// forced policy that would filter a deployment's statements fails it instead.
import {
  deploy,
  draft,
  finalize,
  postgresTarget,
  SqlFileFailedError,
  SqlRuleViolationError,
  status,
} from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployRole,
  deployProject,
  embeddedDeployRole,
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
 * Runs `sql` on the target as `role` (switched to from the superuser);
 * resolves to its rows or the error message.
 */
async function asRole(
  database: string,
  role: string,
  sql: string,
): Promise<unknown> {
  const connectionString = await embeddedPostgres({
    dataDir: server.dataDir,
  }).connectionString(database);
  const session = await postgresTarget({ connectionString }).connect();
  try {
    await session.execute(`set role ${role}`);
    return (await session.query(sql)).rows;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await session.close();
  }
}

describe("privileges on a target", () => {
  test("grants, default privileges for the deploy role, a policy and row-level security made by hand are not drift, and the next deploy keeps them", async () => {
    const reader = roleName("app_reader");
    await server.query(`create role ${reader} nologin`);
    const { project, dir, database } = await deployProject(server, {
      "reports.sql":
        "create table reports (id bigint primary key, title text);\n",
    });
    await finalizeMigration(project, "add reports");
    await deploy(project, { target: "dev" });
    await asDeployRole(
      server,
      database,
      `grant usage on schema public to ${reader};
       grant select on reports to ${reader};
       alter default privileges in schema public grant select on tables to ${reader};
       alter table reports enable row level security;
       create policy reports_read on reports for select to ${reader} using (true);
       insert into reports (id, title) values (1, 'Q1');`,
    );

    expect((await status(project, { target: "dev" })).drift).toEqual([]);

    await dir.write(
      "data-model/desired-schema/notes.sql",
      "create table notes (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add notes");
    await deploy(project, { target: "dev" });

    expect(await asRole(database, reader, "select id from notes")).toEqual([]);
    expect(
      await asRole(database, reader, "select id, title from reports"),
    ).toEqual([{ id: "1", title: "Q1" }]);
    expect(
      await server.query(
        "select relrowsecurity from pg_class where relname = 'reports'",
        [],
        database,
      ),
    ).toEqual([{ relrowsecurity: true }]);
    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });
});

describe("objects a deployment drops and creates again", () => {
  test("status and deploy warn that a view recreated because a column it reads changed type loses its hand-made grant", async () => {
    const report = roleName("report");
    await server.query(`create role ${report} nologin`);
    const orders = (precision: number) =>
      `create table orders (id bigint primary key, total numeric(${precision},2));
create view order_totals as select id, total from orders;
`;
    const { project, dir, database } = await deployProject(server, {
      "orders.sql": orders(10),
    });
    await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await asDeployRole(
      server,
      database,
      `grant select on order_totals to ${report}`,
    );
    await dir.write("data-model/desired-schema/orders.sql", orders(12));
    await finalizeMigration(project, "wider total");

    const warning = `view public.order_totals is recreated by 00002-wider-total: its grants of SELECT to ${report} will be lost (default privileges don't restore them)`;
    expect(
      (await status(project, { target: "dev" })).preflight.warnings,
    ).toEqual([warning]);
    const warnings: string[] = [];
    await deploy(project, {
      target: "dev",
      onWarning: (found) => warnings.push(found),
    });
    expect(warnings).toEqual([warning]);
  });

  test("a function recreated because its return type changed warns that PUBLIC regains the EXECUTE revoked by hand, and that its grant is lost", async () => {
    const writer = roleName("writer");
    await server.query(`create role ${writer} nologin`);
    const counter = (type: string) =>
      `create table orders (id bigint primary key, customer_id bigint);
create function order_count(cid bigint) returns ${type}
  language sql stable as $$ select count(*)::${type} from public.orders where customer_id = cid $$;
`;
    const { project, dir, database } = await deployProject(server, {
      "orders.sql": counter("integer"),
    });
    await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await asDeployRole(
      server,
      database,
      `revoke execute on function order_count(bigint) from public;
       grant execute on function order_count(bigint) to ${writer};`,
    );
    await dir.write("data-model/desired-schema/orders.sql", counter("bigint"));
    await finalizeMigration(project, "count back");

    expect(
      (await status(project, { target: "dev" })).preflight.warnings,
    ).toEqual([
      `function public.order_count(cid bigint) is recreated by 00002-count-back: its grants of EXECUTE to ${writer} will be lost (default privileges don't restore them); PUBLIC regains EXECUTE, revoked on the target by hand (default privileges grant it again)`,
    ]);
  });

  test("a table a migration drops and creates again warns that its policy and row-level security will be lost", async () => {
    const { project, dir, database } = await deployProject(server, {
      "reports.sql": "create table reports (id bigint primary key);\n",
    });
    await finalizeMigration(project, "add reports");
    await deploy(project, { target: "dev" });
    await asDeployRole(
      server,
      database,
      `alter table reports enable row level security;
       create policy reports_read on reports for select using (true);`,
    );
    const reports =
      "create table reports (id bigint primary key, title text);\n";
    await dir.write("data-model/desired-schema/reports.sql", reports);
    await draft(project, { name: "rebuild reports" });
    await dir.write(
      "data-model/draft/schema-change.sql",
      `drop table public.reports;\n${reports.replace("reports", "public.reports")}`,
    );
    await finalize(project, { acknowledgeDestructive: true });

    expect(
      (await status(project, { target: "dev" })).preflight.warnings,
    ).toEqual([
      "table public.reports is recreated by 00002-rebuild-reports: its row-level security and its policy reports_read will be lost",
    ]);
  });

  test("with only the README's default privileges, recreating a view and a function warns about nothing", async () => {
    const reader = roleName("app_reader");
    const writer = roleName("app_writer");
    await server.query(
      `create role ${reader} nologin; create role ${writer} nologin`,
    );
    const { project, dir, database } = await deployProject(server, {});
    await asDeployRole(
      server,
      database,
      `grant usage on schema public to ${reader}, ${writer};
       alter default privileges for role ${embeddedDeployRole} in schema public
         grant select on tables to ${reader};
       alter default privileges for role ${embeddedDeployRole} in schema public
         grant select, insert, update, delete on tables to ${writer};
       alter default privileges for role ${embeddedDeployRole}
         revoke execute on functions from public;
       alter default privileges for role ${embeddedDeployRole} in schema public
         grant execute on functions to ${writer};`,
    );
    const schema = (precision: number, count: string) =>
      `create table orders (id bigint primary key, total numeric(${precision},2));
create view order_totals as select id, total from orders;
create function order_count() returns ${count}
  language sql stable as $$ select count(*)::${count} from public.orders $$;
`;
    await dir.write(
      "data-model/desired-schema/orders.sql",
      schema(10, "integer"),
    );
    await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await dir.write(
      "data-model/desired-schema/orders.sql",
      schema(12, "bigint"),
    );
    await finalizeMigration(project, "wider total");
    const change = await dir.read(
      "data-model/migrations/00002-wider-total/schema-change.sql",
    );
    expect(change).toContain("DROP VIEW");
    expect(change).toContain("DROP FUNCTION");

    expect(
      (await status(project, { target: "dev" })).preflight.warnings,
    ).toEqual([]);
    await deploy(project, { target: "dev" });
    expect(
      await asRole(database, writer, "select public.order_count()"),
    ).toEqual([{ order_count: "0" }]);
    expect(
      await asRole(database, reader, "select public.order_count()"),
    ).toMatch(/permission denied for function order_count/);
  });

  test("objects a migration only alters, or creates anew, never warn", async () => {
    const report = roleName("report");
    await server.query(`create role ${report} nologin`);
    const { project, dir, database } = await deployProject(server, {
      "orders.sql": "create table orders (id bigint primary key);\n",
    });
    await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await asDeployRole(server, database, `grant select on orders to ${report}`);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      `create table orders (id bigint primary key, note text);
create view order_notes as select id, note from orders;
`,
    );
    await finalizeMigration(project, "add notes");

    expect(
      (await status(project, { target: "dev" })).preflight.warnings,
    ).toEqual([]);
  });
});

const orders = `create table orders (
  id bigint primary key,
  owner_name text not null,
  total numeric(10,2) not null
);
`;

/**
 * Deploys `orders` with two rows owned by other roles, then, by hand as the
 * deploy role, a policy hiding both from it and row-level security turned
 * on (and forced, when `force`).
 */
async function ordersUnderPolicy(force: boolean) {
  const deployed = await deployProject(server, { "orders.sql": orders });
  await finalizeMigration(deployed.project, "add orders");
  await deploy(deployed.project, { target: "dev" });
  await asDeployRole(
    server,
    deployed.database,
    `insert into orders (id, owner_name, total) values (1, 'someone', 10), (3, 'nobody', 99);
     create policy orders_owner on orders using (owner_name = current_user);
     alter table orders enable row level security;
     ${force ? "alter table orders force row level security;" : ""}`,
  );
  return deployed;
}

/** What the target records and holds of `orders` after a deployment. */
async function ordersOnTarget(database: string) {
  return {
    recorded: (
      await server.query<{ name: string }>(
        "select name from deployment_history.migrations order by number",
        [],
        database,
      )
    ).map(({ name }) => name),
    columns: (
      await server.query<{ attname: string }>(
        "select attname from pg_attribute where attrelid = 'orders'::regclass and attnum > 0 order by attnum",
        [],
        database,
      )
    ).map(({ attname }) => attname),
  };
}

describe("row-level security forced on a target", () => {
  test("a backfill a forced policy would filter fails the deployment, which rolls back and suggests NO FORCE ROW LEVEL SECURITY", async () => {
    const { project, dir, database } = await ordersUnderPolicy(true);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      orders.replace("total numeric", "priority integer,\n  total numeric"),
    );
    await draft(project, { name: "priority" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update orders set priority = 1 where priority is null;\n",
    );
    await finalize(project);

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect(error).toMatchObject({
      file: "data-model/migrations/00002-priority/post-migration.sql",
      rollback: {
        target: "dev",
        recorded: { lastRecorded: "00001-add-orders" },
      },
    });
    const { message } = error as SqlFileFailedError;
    expect(message).toContain('"orders"');
    expect(message).toContain("NO FORCE ROW LEVEL SECURITY");
    expect(await ordersOnTarget(database)).toEqual({
      recorded: ["add-orders"],
      columns: ["id", "owner_name", "total"],
    });
  });

  test("a materialized view over a table under a forced policy fails the deployment instead of being built from the rows the policy shows", async () => {
    const { project, dir, database } = await ordersUnderPolicy(true);
    await dir.write(
      "data-model/desired-schema/order-totals.sql",
      "create materialized view order_totals as select owner_name, sum(total) as total from orders group by owner_name;\n",
    );
    await finalizeMigration(project, "order totals");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect((error as SqlFileFailedError).message).toContain(
      "NO FORCE ROW LEVEL SECURITY",
    );
    expect(
      await server.query(
        "select to_regclass('order_totals') as view",
        [],
        database,
      ),
    ).toEqual([{ view: null }]);
    expect((await ordersOnTarget(database)).recorded).toEqual(["add-orders"]);
  });

  test("with row-level security enabled but not forced, the deploy role bypasses the policy and a backfill updates every row", async () => {
    const { project, dir, database } = await ordersUnderPolicy(false);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      orders.replace("total numeric", "priority integer,\n  total numeric"),
    );
    await draft(project, { name: "priority" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update orders set priority = 1 where priority is null;\n",
    );
    await finalize(project);

    await deploy(project, { target: "dev" });

    expect(
      await server.query(
        "select id, priority from orders order by id",
        [],
        database,
      ),
    ).toEqual([
      { id: "1", priority: 1 },
      { id: "3", priority: 1 },
    ]);
  });
});

describe("the desired schema", () => {
  test("can't declare grants, revokes, policies, row-level security or SECURITY DEFINER: draft refuses each, writing no draft", async () => {
    const { project, dir } = await deployProject(server, {
      "reports.sql": `create table reports (id bigint primary key, title text);
grant select on reports to app_reader;
revoke usage on schema public from public;
alter table reports enable row level security;
create policy reports_read on reports for select using (true);
create function report_count() returns bigint language sql security definer
  as $$ select count(*) from reports $$;
`,
    });

    const refusal = await draft(project, { name: "add reports" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(SqlRuleViolationError);
    const { violations } = refusal as SqlRuleViolationError;
    expect(violations.map(({ line, rule }) => ({ line, rule }))).toEqual(
      [2, 3, 4, 5, 6].map((line) => ({ line, rule: "unsupported-object" })),
    );
    for (const { message } of violations) {
      expect(message).toContain("set up on targets outside super-deploy");
    }
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});
