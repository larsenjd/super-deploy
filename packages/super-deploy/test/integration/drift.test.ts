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
    await server.query(
      `alter table customers add column note text;
       alter table customers alter column name type varchar(100);
       create table audit (id bigint primary key, at timestamptz);`,
      [],
      database,
    );

    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      { object: "column name of table customers", change: "changed" },
      { object: "column note of table customers", change: "extra" },
      { object: "index audit_pkey", change: "extra" },
      { object: "table audit", change: "extra" },
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
    await server.query("drop index orders_customer_idx", [], database);

    const { drift } = await status(project, { target: "dev" });

    expect(drift).toEqual([
      {
        object: "index orders_customer_idx",
        change: "missing",
        differences: [
          "+ index: CREATE INDEX orders_customer_idx ON public.orders USING btree (customer_id) valid=true clustered=false replident=false",
        ],
      },
    ]);
  });

  test("counts grants and every other kind of object a schema can hold", async () => {
    const { project, database } = await deployedProject();
    const reader = `drift_reader_${database}`;
    await server.query(
      `create role ${reader} nologin;
       grant select on customers to ${reader};
       create rule customers_no_delete as on delete to customers do instead nothing;
       create statistics customers_stats on id, name from customers;
       create aggregate total (bigint) (sfunc = int8pl, stype = bigint);`,
      [],
      database,
    );

    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      { object: "function total(bigint)", change: "extra" },
      {
        object: "rule customers_no_delete on table customers",
        change: "extra",
      },
      { object: "statistics object customers_stats", change: "extra" },
      { object: "table customers", change: "changed" },
    ]);
    expect(drift?.at(-1)?.differences).toContainEqual(
      expect.stringContaining(`${reader}:SELECT/<owner>`),
    );
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
});

describe("deploy", () => {
  test("refuses a drifted target even when the extra object is identical to what a pending migration creates", async () => {
    const { dir, project, database } = await deployedProject();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}create index customers_name_idx on customers (name);\n`,
    );
    await finalizeMigration(project, "index customer names");
    await server.query(
      "create index customers_name_idx on customers (name)",
      [],
      database,
    );

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DriftError);
    expect(error).toMatchObject({
      code: "target-drifted",
      target: "dev",
      objects: [{ object: "index customers_name_idx", change: "extra" }],
    });
    expect((error as Error).message).toContain(
      "Target dev has drifted from its recorded migrations: index customers_name_idx (extra)",
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
    await server.query("drop table customers", [], database);

    await expect(deploy(project, { target: "dev" })).rejects.toMatchObject({
      objects: [
        { object: "index customers_pkey", change: "missing" },
        { object: "table customers", change: "missing" },
      ],
    });
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
      expect.stringMatching(/^catalog: \+ relation: r not_in_migrations /),
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
