// API seam: drift detection. A target's managed schema must match what its
// recorded migrations produce on a locale-matched replica; `status` reports
// any difference and `deploy` refuses.
import {
  DriftError,
  deploy,
  RehearsalMismatchError,
  status,
  unfinalize,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployRole,
  deployProject,
  finalizeMigration,
  testSession,
} from "../support/deploy.ts";
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

/** A project with migration 1 (customers) deployed to `dev`. */
async function deployedProject() {
  const deployed = await deployProject(server, { "customers.sql": customers });
  await finalizeMigration(deployed.project, "add customers");
  await deploy(deployed.project, { target: "dev" });
  return deployed;
}

describe("status", () => {
  test("reports no drift on a target its migrations built", async () => {
    const { project } = await deployedProject();

    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });

  test("names every object changed by hand: extra, missing and changed", async () => {
    const { project, database } = await deployedProject();
    await asDeployRole(
      server,
      database,
      `alter table customers add column note text;
       alter table customers alter column name type varchar(100);
       create table audit (id bigint primary key, at timestamptz);`,
    );

    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      { object: "column name of table public.customers", change: "changed" },
      { object: "column note of table public.customers", change: "extra" },
      { object: "index public.audit_pkey", change: "extra" },
      { object: "table public.audit", change: "extra" },
    ]);
    expect(drift?.[0]?.differences).toEqual([
      {
        side: "target",
        line: expect.stringMatching(
          /^column: customers\.name character varying\(100\) /,
        ),
      },
      {
        side: "expected",
        line: expect.stringMatching(/^column: customers\.name text /),
      },
    ]);
    expect(drift?.[1]?.differences).toEqual([
      {
        side: "target",
        line: expect.stringMatching(/^column: customers\.note text /),
      },
    ]);
  });

  test("names objects with their schema, quoting a name once where it needs quotes", async () => {
    const { project, database } = await deployedProject();
    await asDeployRole(
      server,
      database,
      `create table "Audit Log" (id bigint, "Noted At" timestamptz)`,
    );

    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      { object: 'table public."Audit Log"', change: "extra" },
    ]);
  });

  test("reports objects the recorded migrations create that the target lacks", async () => {
    const { dir, project, database } = await deployedProject();
    await dir.write(
      "data-model/desired-schema/orders.sql",
      `create table orders (id bigint primary key, customer_id bigint not null);
create index orders_customer_idx on orders (customer_id);
`,
    );
    await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await asDeployRole(server, database, "drop index orders_customer_idx");

    const { drift } = await status(project, { target: "dev" });

    expect(drift).toEqual([
      {
        object: "index public.orders_customer_idx",
        change: "missing",
        differences: [
          {
            side: "expected",
            line: "index: CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id) valid=true clustered=false replident=false",
          },
        ],
      },
    ]);
  });

  test("counts every other kind of object a schema can hold, but not grants", async () => {
    const { project, database } = await deployedProject();
    const reader = `drift_reader_${database}`;
    await server.query(`create role ${reader} nologin`);
    await asDeployRole(
      server,
      database,
      `grant select on customers to ${reader};
       create rule customers_no_delete as on delete to customers do instead nothing;
       create statistics customers_stats on id, name from customers;
       create aggregate total (bigint) (sfunc = int8pl, stype = bigint);`,
    );

    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      { object: "function public.total(bigint)", change: "extra" },
      {
        object: "rule customers_no_delete on table public.customers",
        change: "extra",
      },
      { object: "statistics object public.customers_stats", change: "extra" },
    ]);
  });

  test("is not checked when the recorded history doesn't match the project", async () => {
    const { project } = await deployedProject();
    await unfinalize(project, { acknowledgeOverwrite: true });

    const report = await status(project, { target: "dev" });

    expect(report.preflight.historyMismatches).not.toEqual([]);
    expect(report.drift).toBeUndefined();
  });

  test("ignores column order and ownership", async () => {
    const { project, database } = await deployedProject();
    const owner = `drift_owner_${database}`;
    // As the superuser: handing a table to another role is the point here.
    await server.query(
      `create role ${owner} nologin;
       alter table customers drop column name;
       alter table customers add column name text not null;
       alter table customers owner to ${owner};`,
      [],
      database,
    );

    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });

  test("names a column comment by its column, so the column's position doesn't count", async () => {
    const { project, database } = await deployProject(server, {
      "customers.sql": `${customers}comment on column customers.name is 'Full name';\n`,
    });
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });

    // Re-create the column: it is now the third attribute, after a dropped one.
    await asDeployRole(
      server,
      database,
      `alter table customers drop column name;
       alter table customers add column name text not null;
       comment on column customers.name is 'Full name';`,
    );
    expect((await status(project, { target: "dev" })).drift).toEqual([]);

    await asDeployRole(
      server,
      database,
      "comment on column customers.name is 'Display name'",
    );
    expect((await status(project, { target: "dev" })).drift).toEqual([
      {
        object: "column name of table public.customers",
        change: "changed",
        differences: [
          {
            side: "target",
            line: "comment: pg_class customers.name Display name",
          },
          {
            side: "expected",
            line: "comment: pg_class customers.name Full name",
          },
        ],
      },
    ]);
  });

  test("counts the order of a composite type's attributes, ignoring dropped ones", async () => {
    const { project, database } = await deployProject(server, {
      "size.sql": "create type size as (width integer, height integer);\n",
    });
    await finalizeMigration(project, "add size");
    await deploy(project, { target: "dev" });

    // Drop and re-add the last attribute: the order stays (width, height).
    await asDeployRole(
      server,
      database,
      `alter type size drop attribute height;
       alter type size add attribute height integer;`,
    );
    expect((await status(project, { target: "dev" })).drift).toEqual([]);

    // Drop and re-add the first: the order becomes (height, width).
    await asDeployRole(
      server,
      database,
      `alter type size drop attribute width;
       alter type size add attribute width integer;`,
    );
    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      {
        object: "column height of composite type public.size",
        change: "changed",
      },
      {
        object: "column width of composite type public.size",
        change: "changed",
      },
    ]);
  });
});

describe("deploy", () => {
  test("refuses a drifted target even when the extra object is identical to what a pending migration creates", async () => {
    const { dir, project, database } = await deployedProject();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}create index customers_name_idx on customers (name);\n`,
    );
    await finalizeMigration(project, "index customer names");
    await asDeployRole(
      server,
      database,
      "create index customers_name_idx on customers (name)",
    );

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DriftError);
    expect(error).toMatchObject({
      code: "target-drifted",
      target: "dev",
      objects: [{ object: "index public.customers_name_idx", change: "extra" }],
    });
    expect((error as Error).message).toContain(
      "Target dev has drifted from its recorded migrations: index public.customers_name_idx (only on the target)",
    );
    // A change made by hand that the next pending migration catches up with is
    // what `mark` records; the differences are still listed by status.
    expect((error as Error).message).toContain("mark --target dev");
    expect((error as Error).message).toContain(
      "status --target dev lists the differences",
    );
    expect(
      await server.query(
        `select (select array_agg(number order by number) from deployment_history.migrations) as recorded,
                (select array_agg(outcome order by id) from deployment_history.attempts) as outcomes,
                (select error from deployment_history.attempts order by id desc limit 1) as error`,
        [],
        database,
      ),
    ).toEqual([
      {
        recorded: [1],
        outcomes: ["succeeded", "failed"],
        error: expect.stringContaining("has drifted"),
      },
    ]);
  });

  test("refuses a drifted target with nothing pending", async () => {
    const { project, database } = await deployedProject();
    await asDeployRole(server, database, "drop table customers");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      objects: [
        { object: "index public.customers_pkey", change: "missing" },
        { object: "table public.customers", change: "missing" },
      ],
    });
    expect((error as Error).message).not.toContain("mark");
    expect((error as Error).message).toContain(
      "status --target dev lists the differences",
    );
  });

  test("refuses when the rehearsed migrations don't produce the newest desired-schema snapshot, never touching the target", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        // Simulates a server that disagrees with the snapshot: the second
        // throwaway database a deployment creates (the snapshot's) gets an
        // extra table before the snapshot loads.
        rehearsal: `{
  async createDatabase(request) {
    const database = await postgres.rehearsal.createDatabase(request);
    if (request.collationProvider === "libc" && globalThis.driftSnapshotTamper && ++globalThis.driftSnapshotTamper === 3) {
      const session = await database.connect();
      await session.execute("create table not_in_migrations (id bigint)");
      await session.close();
    }
    return database;
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add orders");
    Object.assign(globalThis, { driftSnapshotTamper: 1 });

    const error = await deploy(project, { target: "dev" })
      .catch((e: unknown) => e)
      .finally(() => Object.assign(globalThis, { driftSnapshotTamper: 0 }));

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as Error).message).toContain(
      "The deployment rehearsal does not match the desired-schema snapshot of 00002-add-orders",
    );
    expect((error as RehearsalMismatchError).differences).toContainEqual(
      expect.stringMatching(
        /^catalog: from the desired schema: relation: r not_in_migrations /,
      ),
    );
    expect(
      await server.query(
        "select to_regclass('orders') as orders",
        [],
        database,
      ),
    ).toEqual([{ orders: null }]);
  });

  test("reads the target's catalogs under its lock timeout, so a table locked by someone else fails the drift check fast", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { target: 'lockTimeout: "200ms",' },
    );
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    const holder = await testSession(server, database);
    try {
      await holder.execute(
        "BEGIN; LOCK TABLE customers IN ACCESS EXCLUSIVE MODE",
      );

      await expect(deploy(project, { target: "dev" })).rejects.toThrow(
        /lock timeout/,
      );
      await expect(status(project, { target: "dev" })).rejects.toThrow(
        /lock timeout/,
      );
    } finally {
      await holder.close();
    }
    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });
});
