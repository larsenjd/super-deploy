// API seam: rehearsals create no roles, and the deploy pre-flight (declared
// external schemas exist on the target, the deploy role owns the managed
// schema and everything in it, the deploy role's privileges, recorded hashes
// match the repo), which status reports too.

import {
  deploy,
  finalize,
  HistorySchemaNotCreatableError,
  PreflightFailedError,
  status,
  unfinalize,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployerPreamble,
  asSuperuser,
  deployProject,
  finalizeMigration,
  roleName,
  targetDatabaseName,
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

/** Every role on the server, sorted. */
async function roles(): Promise<string[]> {
  const rows = await server.query<{ rolname: string }>(
    "select rolname from pg_roles order by 1",
  );
  return rows.map((row) => row.rolname);
}

/** Why a refusal for a changed recorded migration says to restore it. */
const keepRecorded =
  "a migration a target has recorded must never change, so put new changes in a new migration";

const customers =
  "create table customers (id bigint primary key, name text not null);\n";
const orders =
  "create table orders (id bigint primary key, customer_id bigint not null constraint orders_customer_fk references customers (id));\n";

describe("roles in rehearsals", () => {
  test("a rehearsal creates no roles, so its login needs CREATEDB and not CREATEROLE", async () => {
    const rehearser = roleName("rehearser");
    await server.query(
      `create role ${rehearser} login createdb password 'rehearser'`,
    );
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers, "orders.sql": orders },
      {
        preamble: `import { postgresRehearsal } from "super-deploy";
const rehearsalUrl = new URL(await postgres.connectionString("postgres"));
rehearsalUrl.username = ${JSON.stringify(rehearser)};
rehearsalUrl.password = "rehearser";
const asRehearser = postgresRehearsal({ connectionString: rehearsalUrl.href });`,
        rehearsal: "asRehearser",
      },
    );
    // The embedded dev target creates its deploy role on first connect.
    await (await testSession(server, database)).close();
    const before = await roles();

    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });

    expect(await roles()).toEqual(before);
  });
});

async function tables(database: string): Promise<string[]> {
  const rows = await server.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    [],
    database,
  );
  return rows.map((row) => row.table_name);
}

describe("deploy pre-flight", () => {
  test("refuses when a declared external schema is missing on the target, until it exists", async () => {
    const loader = roleName("loader");
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { settings: `externalSchemas: [${JSON.stringify(loader)}],` },
    );
    await finalizeMigration(project, "add customers");

    const refusal = await deploy(project, { target: "dev" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PreflightFailedError);
    expect(refusal).toMatchObject({
      findings: { missingExternalSchemas: [loader] },
    });
    expect((refusal as Error).message).toContain(
      `external schema "${loader}" does not exist`,
    );
    expect(await tables(database)).toEqual([]);
    expect((await status(project, { target: "dev" })).preflight).toMatchObject({
      missingExternalSchemas: [loader],
    });

    await server.query(`create schema ${loader}`, [], database);
    await deploy(project, { target: "dev" });
    expect(await tables(database)).toEqual(["customers"]);
  });

  test("a refusal for a recorded migration whose content changed says to restore its folder and put the change in a new migration", async () => {
    const { project, dir } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    await unfinalize(project, { acknowledgeOverwrite: true });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update customers set name = trim(name);\n",
    );
    await finalize(project);

    const refusal = await deploy(project, { target: "dev" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PreflightFailedError);
    const advice = `restore 00001-add-customers (and index.json) from version control (${keepRecorded})`;
    expect((refusal as Error).message).toContain(advice);
    const [mismatch] = (refusal as PreflightFailedError).findings
      .historyMismatches;
    expect(mismatch).toMatchObject({ reason: "content-hash" });
    expect(mismatch?.message).toContain(advice);
    expect(
      (await status(project, { target: "dev" })).preflight.historyMismatches,
    ).toEqual([mismatch]);
  });

  test("a chain-hash refusal says an earlier migration changed and names the first that differs", async () => {
    const { project, dir, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");
    await dir.write("data-model/desired-schema/orders.sql", orders);
    const second = await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await server.query(
      "update deployment_history.migrations set content_hash = 'edited', chain_hash = 'edited' where number = 1; update deployment_history.migrations set chain_hash = 'edited' where number = 2",
      [],
      database,
    );

    expect(
      (await status(project, { target: "dev" })).preflight.historyMismatches,
    ).toMatchObject([
      { number: 1, reason: "content-hash" },
      {
        number: 2,
        reason: "chain-hash",
        message: `the target records migration 00002-add-orders with chain hash edited, but the repo's is ${second.chainHash}, so an earlier migration changed, first 00001-add-customers: restore it (and index.json) from version control (${keepRecorded})`,
      },
    ]);
  });

  test("refuses when what the target records doesn't match the repo's migrations", async () => {
    const { project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    const first = await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    const history = (sql: string) => server.query(sql, [], database);
    const refusal = () =>
      deploy(project, { target: "dev" }).catch((error: unknown) => error);

    await history(
      "update deployment_history.migrations set content_hash = 'edited' where number = 1",
    );
    expect(await refusal()).toMatchObject({
      code: "preflight-failed",
      findings: {
        historyMismatches: [
          {
            number: 1,
            reason: "content-hash",
            message: `the target records migration 00001-add-customers with content hash edited, but the repo's is ${first.contentHash}: restore 00001-add-customers (and index.json) from version control (${keepRecorded})`,
          },
        ],
      },
    });

    await history(
      `update deployment_history.migrations set content_hash = '${first.contentHash}', chain_hash = 'edited', name = 'add-clients' where number = 1`,
    );
    expect(
      (await status(project, { target: "dev" })).preflight.historyMismatches,
    ).toEqual([
      {
        number: 1,
        reason: "name",
        message: `the target records migration 1 as 00001-add-clients, but the repo's is 00001-add-customers: restore 00001-add-clients (and index.json) from version control in place of 00001-add-customers (${keepRecorded})`,
      },
    ]);

    await history(
      "update deployment_history.migrations set name = 'add-customers' where number = 1",
    );
    expect(await refusal()).toMatchObject({
      findings: {
        historyMismatches: [
          {
            number: 1,
            reason: "chain-hash",
            message: `the target records migration 00001-add-customers with chain hash edited, but the repo's is ${first.chainHash}, so a migration up to it changed: restore those (and index.json) from version control (${keepRecorded})`,
          },
        ],
      },
    });
    await history(
      `update deployment_history.migrations set chain_hash = '${first.chainHash}' where number = 1`,
    );
    await expect(deploy(project, { target: "dev" })).resolves.toMatchObject({
      deployed: [],
    });
  });

  test("refuses a target that records a migration the repo doesn't have, or skips one", async () => {
    const { project, dir, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await finalizeMigration(project, "add orders");
    await deploy(project, { target: "dev" });
    await unfinalize(project, { acknowledgeOverwrite: true });

    expect(
      await deploy(project, { target: "dev" }).catch((error: unknown) => error),
    ).toMatchObject({
      findings: {
        historyMismatches: [
          {
            number: 2,
            reason: "not-in-repo",
            message: `the target records migration 00002-add-orders, which the repo doesn't have: restore 00002-add-orders (and index.json) from version control (${keepRecorded})`,
          },
        ],
      },
    });

    await finalize(project);
    await server.query(
      "delete from deployment_history.migrations where number = 1",
      [],
      database,
    );
    expect(
      (await status(project, { target: "dev" })).preflight.historyMismatches,
    ).toEqual([
      {
        number: 1,
        reason: "not-recorded",
        message:
          "the target doesn't record migration 00001-add-customers, but records the later migration 2",
      },
    ]);
  });
});

describe("the deploy role owns the managed schema", () => {
  test("refuses a target where the managed schema or an object in it belongs to a role the deploy role isn't a member of, listing each fix, until it owns them or joins their owner", async () => {
    const deployer = roleName("deployer");
    const admin = roleName("admin");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create role ${admin} nologin`);
    await server.query(`create database ${database} owner ${deployer}`);
    const { project, dir } = await deployProject(
      server,
      {
        "customers.sql":
          "create table customers (id bigint generated always as identity primary key, name text not null);\n",
        "answer.sql":
          "create function answer() returns integer language sql immutable return 42;\n",
      },
      {
        database,
        preamble: asDeployerPreamble(database, deployer),
        adapter: "asDeployer",
        settings: 'managedSchema: "app",',
      },
    );
    await finalizeMigration(project, "add customers");
    // No managed schema yet: nothing to own.
    expect(
      (await status(project, { target: "dev" })).preflight.notOwned,
    ).toEqual([]);
    await deploy(project, { target: "dev" });
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await finalizeMigration(project, "add orders");
    // An administrator takes them over (the table's identity sequence goes with it).
    await server.query(
      `alter schema app owner to ${admin};
       alter table app.customers owner to ${admin};
       alter function app.answer() owner to ${admin};`,
      [],
      database,
    );

    const refusal = await deploy(project, { target: "dev" }).catch(
      (error: unknown) => error,
    );

    const notOwned = [
      {
        object: "schema app",
        owner: admin,
        fix: `ALTER SCHEMA app OWNER TO ${deployer}`,
      },
      {
        object: "function app.answer()",
        owner: admin,
        fix: `ALTER FUNCTION app.answer() OWNER TO ${deployer}`,
      },
      {
        object: "table app.customers",
        owner: admin,
        fix: `ALTER TABLE app.customers OWNER TO ${deployer}`,
      },
    ];
    expect(refusal).toBeInstanceOf(PreflightFailedError);
    expect(refusal).toMatchObject({ findings: { notOwned } });
    for (const { object, fix } of notOwned) {
      expect((refusal as Error).message).toContain(
        `${object} is owned by ${admin}`,
      );
      expect((refusal as Error).message).toContain(fix);
    }
    expect(
      (await status(project, { target: "dev" })).preflight.notOwned,
    ).toEqual(notOwned);

    await server.query(
      `alter table app.customers owner to ${deployer}`,
      [],
      database,
    );
    await server.query(`grant ${admin} to ${deployer}`);
    expect(
      (await status(project, { target: "dev" })).preflight.notOwned,
    ).toEqual([]);
    await expect(deploy(project, { target: "dev" })).resolves.toMatchObject({
      deployed: [{ folder: "00002-add-orders" }],
    });
  });

  test("names every kind of object with an ALTER ... OWNER TO that PostgreSQL accepts, leaving out what goes with its table or type", async () => {
    const deployer = roleName("deployer");
    const admin = roleName("admin");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create role ${admin} nologin`);
    await server.query(`create database ${database} owner ${deployer}`);
    const { project } = await deployProject(
      server,
      {},
      {
        database,
        preamble: asDeployerPreamble(database, deployer),
        adapter: "asDeployer",
        settings: 'managedSchema: "app",',
      },
    );
    await server.query(
      `create schema app authorization ${admin};
       set role ${admin};
       create table app.items (id bigint generated always as identity primary key, code serial);
       create view app.item_ids as select id from app.items;
       create materialized view app.item_count as select count(*) from app.items;
       create sequence app.counter;
       create type app.mood as enum ('sad', 'happy');
       create type app.pair as (a int, b int);
       create type app.span as range (subtype = int4);
       create domain app.code as text;
       create function app.same(int, int) returns boolean language sql immutable return $1 = $2;
       create function app.negate(int) returns int language sql immutable return -$1;
       create procedure app.noop() language sql begin atomic select 1; end;
       create aggregate app.tally(*) (sfunc = int8inc, stype = int8, initcond = '0');
       create aggregate app.total(int) (sfunc = int4pl, stype = int4);
       create operator app.=== (leftarg = int, rightarg = int, function = app.same);
       create operator app.~~~ (rightarg = int, function = app.negate);
       create collation app.c_copy from "C";
       create statistics app.items_stats on id, code from app.items;
       create text search dictionary app.simple_copy (template = pg_catalog.simple);
       create text search configuration app.config_copy (copy = pg_catalog.simple);
       reset role;
       create operator family app.ints using btree;
       create operator class app.int_ops for type int using btree family app.ints as operator 1 <, function 1 btint4cmp(int, int);
       alter operator family app.ints using btree owner to ${admin};
       alter operator class app.int_ops using btree owner to ${admin};`,
      [],
      database,
    );
    const notOwned = async () =>
      (await status(project, { target: "dev" })).preflight.notOwned;

    const found = await notOwned();

    expect(found.map(({ fix }) => fix)).toEqual(
      [
        "SCHEMA app",
        "AGGREGATE app.tally(*)",
        "AGGREGATE app.total(integer)",
        "COLLATION app.c_copy",
        "DOMAIN app.code",
        "FUNCTION app.negate(integer)",
        "FUNCTION app.same(integer, integer)",
        "MATERIALIZED VIEW app.item_count",
        "OPERATOR app.===(integer, integer)",
        "OPERATOR app.~~~(NONE, integer)",
        "OPERATOR CLASS app.int_ops USING btree",
        "OPERATOR FAMILY app.ints USING btree",
        "PROCEDURE app.noop()",
        "SEQUENCE app.counter",
        "STATISTICS app.items_stats",
        "TABLE app.items",
        "TEXT SEARCH CONFIGURATION app.config_copy",
        "TEXT SEARCH DICTIONARY app.simple_copy",
        "TYPE app.mood",
        "TYPE app.pair",
        "TYPE app.span",
        "VIEW app.item_ids",
      ].map((object) => `ALTER ${object} OWNER TO ${deployer}`),
    );
    expect(found.every(({ owner }) => owner === admin)).toBe(true);
    for (const { fix } of found) {
      await server.query(fix, [], database);
    }
    expect(await notOwned()).toEqual([]);
  });
});

describe("the deploy role can create the history schema", () => {
  test("refuses the first deployment while the deploy role lacks CREATE on the database, naming the grant, and needs it no longer once the history schema exists", async () => {
    const deployer = roleName("deployer");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create database ${database}`);
    await server.query(
      `create schema app authorization ${deployer}`,
      [],
      database,
    );
    const { project, dir } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        database,
        preamble: asDeployerPreamble(database, deployer),
        adapter: "asDeployer",
        settings: 'managedSchema: "app",',
      },
    );
    await finalizeMigration(project, "add customers");
    const finding = {
      role: deployer,
      database,
      historySchema: "deployment_history",
      fix: `GRANT CREATE ON DATABASE ${database} TO ${deployer}`,
    };
    expect(
      (await status(project, { target: "dev" })).preflight
        .historySchemaNotCreatable,
    ).toEqual(finding);

    const refusal = await deploy(project, { target: "dev" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(HistorySchemaNotCreatableError);
    expect(refusal).toMatchObject({ target: "dev", finding });
    expect((refusal as Error).message).toContain(
      `the deploy role ${deployer} needs CREATE on database ${database} to create the history schema "deployment_history" (fix: ${finding.fix})`,
    );
    expect(
      await server.query(
        "select nspname from pg_namespace where nspname = 'deployment_history'",
        [],
        database,
      ),
    ).toEqual([]);

    await server.query(finding.fix);
    await deploy(project, { target: "dev" });
    await server.query(
      `revoke create on database ${database} from ${deployer}`,
    );
    expect(
      (await status(project, { target: "dev" })).preflight
        .historySchemaNotCreatable,
    ).toBeUndefined();
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await finalizeMigration(project, "add orders");
    await expect(deploy(project, { target: "dev" })).resolves.toMatchObject({
      deployed: [{ folder: "00002-add-orders" }],
    });
  });
});

describe("the deploy role's privileges", () => {
  test("warns, without refusing, when the deploy role is a superuser", async () => {
    const database = targetDatabaseName();
    await server.query(`create database ${database}`);
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      { database, adapter: asSuperuser(database) },
    );
    await finalizeMigration(project, "add customers");
    const warnings: string[] = [];

    const result = await deploy(project, {
      target: "dev",
      onWarning: (warning) => warnings.push(warning),
    });

    expect(result.deployed).toHaveLength(1);
    expect(warnings).toEqual([
      `The deploy role "super_deploy" on target dev is a superuser: deploy with a role that isn't, so deploy-time SQL can't reach beyond the database`,
    ]);
    expect(
      (await status(project, { target: "dev" })).preflight.warnings,
    ).toEqual(warnings);
  });

  test("warns when the deploy role holds pg_read_server_files, pg_write_server_files, pg_execute_server_program or pg_signal_backend, directly or through another role", async () => {
    const deployer = roleName("deployer");
    const group = roleName("ops");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create database ${database} owner ${deployer}`);
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        database,
        preamble: asDeployerPreamble(database, deployer),
        adapter: "asDeployer",
      },
    );
    await finalizeMigration(project, "add customers");
    const warnings = async () =>
      (await status(project, { target: "dev" })).preflight.warnings;

    expect(await warnings()).toEqual([]);

    await server.query(`create role ${group} nologin`);
    await server.query(`grant pg_write_server_files to ${group}`);
    await server.query(`grant ${group} to ${deployer}`);
    await server.query(`grant pg_signal_backend to ${deployer}`);
    const seen: string[] = [];
    const result = await deploy(project, {
      target: "dev",
      onWarning: (warning) => seen.push(warning),
    });

    expect(result.deployed).toHaveLength(1);
    expect(seen).toEqual([
      `The deploy role "${deployer}" on target dev holds pg_signal_backend, pg_write_server_files (it can cancel or terminate other sessions, write files on the database server): deploy with a role that doesn't`,
    ]);

    await server.query(`revoke pg_signal_backend, ${group} from ${deployer}`);
    await server.query(`grant pg_execute_server_program to ${deployer}`);
    expect(await warnings()).toEqual([
      `The deploy role "${deployer}" on target dev holds pg_execute_server_program (it can run programs on the database server): deploy with a role that doesn't`,
    ]);

    await server.query(`revoke pg_execute_server_program from ${deployer}`);
    await server.query(`grant pg_read_server_files to ${deployer}`);
    expect(await warnings()).toEqual([
      `The deploy role "${deployer}" on target dev holds pg_read_server_files (it can read files on the database server): deploy with a role that doesn't`,
    ]);
  });
});
