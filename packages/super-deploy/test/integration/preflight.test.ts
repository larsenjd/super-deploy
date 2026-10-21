// API seam: roles in rehearsals, and the deploy pre-flight (granted roles and
// external schemas exist on the target, the deploy role owns the managed
// schema and everything in it, the deploy role's privileges, recorded hashes
// match the repo), which status reports too.

import {
  deploy,
  draft,
  finalize,
  PreflightFailedError,
  status,
  unfinalize,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployerPreamble,
  deployProject,
  finalizeMigration,
  roleName,
  targetDatabaseName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

async function role(name: string) {
  return (
    await server.query<{ rolcanlogin: boolean }>(
      "select rolcanlogin from pg_roles where rolname = $1",
      [name],
    )
  )[0];
}

const customers =
  "create table customers (id bigint primary key, name text not null);\n";
const orders =
  "create table orders (id bigint primary key, customer_id bigint not null constraint orders_customer_fk references customers (id));\n";

describe("roles in rehearsals", () => {
  test("a role the desired schema grants to is created as NOLOGIN when the rehearsal server lacks it, and never dropped", async () => {
    const reader = roleName();
    const { project } = await deployProject(server, {
      "reports.sql": `create table reports (id bigint primary key);\ngrant select on reports to ${reader};\n`,
    });

    await draft(project, { name: "add reports" });
    await server.query(`drop role ${reader}`);
    await finalize(project);

    expect(await role(reader)).toEqual({ rolcanlogin: false });
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

async function lastAttempt(database: string) {
  return (
    await server.query<{ outcome: string; error: string | null }>(
      "select outcome, error from deployment_history.attempts order by id desc limit 1",
      [],
      database,
    )
  )[0];
}

describe("deploy pre-flight", () => {
  test("refuses when a role the desired schema grants to is missing on the target, touching nothing, until it exists", async () => {
    const reader = roleName();
    const { project, database } = await deployProject(server, {
      "reports.sql": `create table reports (id bigint primary key);\ngrant select on reports to ${reader};\n`,
    });
    await finalizeMigration(project, "add reports");
    // The rehearsals created it on the shared server; the target lacks it.
    await server.query(`drop role ${reader}`);

    const refusal = await deploy(project, { target: "dev" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(PreflightFailedError);
    expect(refusal).toMatchObject({
      code: "preflight-failed",
      target: "dev",
      findings: { missingRoles: [reader] },
    });
    expect((refusal as Error).message).toContain(
      `role "${reader}" does not exist`,
    );
    expect(await tables(database)).toEqual([]);
    expect(await lastAttempt(database)).toEqual({
      outcome: "failed",
      error: (refusal as Error).message,
    });
    expect(await role(reader)).toBeUndefined();
    expect((await status(project, { target: "dev" })).preflight).toMatchObject({
      missingRoles: [reader],
    });

    await server.query(`create role ${reader} nologin`);
    expect((await status(project, { target: "dev" })).preflight).toMatchObject({
      missingRoles: [],
    });
    await deploy(project, { target: "dev" });
    expect(await tables(database)).toEqual(["reports"]);
  });

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
      findings: { missingRoles: [], missingExternalSchemas: [loader] },
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
            message: `the target records migration 00001-add-customers with content hash edited, but the repo's is ${first.contentHash}`,
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
        message:
          "the target records migration 1 as 00001-add-clients, but the repo's is 00001-add-customers",
      },
    ]);

    await history(
      "update deployment_history.migrations set name = 'add-customers' where number = 1",
    );
    expect(await refusal()).toMatchObject({
      findings: { historyMismatches: [{ number: 1, reason: "chain-hash" }] },
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
            message:
              "the target records migration 00002-add-orders, which the repo doesn't have",
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
});

describe("the deploy role's privileges", () => {
  test("warns, without refusing, when the deploy role is a superuser", async () => {
    const { project } = await deployProject(server, {
      "customers.sql": customers,
    });
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
