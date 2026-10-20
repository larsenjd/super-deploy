// API seam: deploy and status against embedded-postgres targets.

import { chmod } from "node:fs/promises";
import { userInfo } from "node:os";
import {
  AdapterError,
  deploy,
  draft,
  finalize,
  MigrationIntegrityError,
  SqlFileFailedError,
  status,
  TargetLockedError,
  toolVersion,
  UnknownTargetError,
  UnsupportedServerError,
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

describe("deploy", () => {
  test("applies a finalized migration to the target and records it in the history schema", async () => {
    const { project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    const migration = await finalizeMigration(project, "add customers");

    const result = await deploy(project, { target: "dev" });

    expect(result.deployed).toEqual([
      { number: 1, name: "add-customers", folder: "00001-add-customers" },
    ]);
    expect(
      await server.query(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'customers' order by column_name`,
        [],
        database,
      ),
    ).toEqual([{ column_name: "id" }, { column_name: "name" }]);
    expect(
      await server.query(
        `select number, name, content_hash, chain_hash, recovery, attempt_id, recorded_how
         from deployment_history.migrations order by number`,
        [],
        database,
      ),
    ).toEqual([
      {
        number: 1,
        name: "add-customers",
        content_hash: migration.contentHash,
        chain_hash: migration.chainHash,
        recovery: null,
        attempt_id: String(result.attemptId),
        recorded_how: "deployed",
      },
    ]);
  });

  test("logs the attempt as succeeded, with command, target, migration range, OS user and tool version", async () => {
    const { project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");

    const result = await deploy(project, { target: "dev" });

    const attempts = await server.query(
      `select id, command, target, from_migration, to_migration, os_user, tool_version, outcome, error,
              started_at <= ended_at as ended_after_start
         from deployment_history.attempts`,
      [],
      database,
    );
    expect(attempts).toEqual([
      {
        id: String(result.attemptId),
        command: "deploy",
        target: "dev",
        from_migration: 1,
        to_migration: 1,
        os_user: userInfo().username,
        tool_version: toolVersion,
        outcome: "succeeded",
        error: null,
        ended_after_start: true,
      },
    ]);
  });

  test("deploys only what is pending: nothing when up to date, then just the new migration", async () => {
    const { dir, project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });

    const again = await deploy(project, { target: "dev" });
    expect(again.deployed).toEqual([]);

    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  email text",
      ),
    );
    await finalizeMigration(project, "add email");
    const next = await deploy(project, { target: "dev" });

    expect(next.deployed).toEqual([
      { number: 2, name: "add-email", folder: "00002-add-email" },
    ]);
    expect(
      await server.query(
        `select m.number, a.id = $1 as by_last_attempt
           from deployment_history.migrations m join deployment_history.attempts a on a.id = m.attempt_id
          order by m.number`,
        [next.attemptId],
        database,
      ),
    ).toEqual([
      { number: 1, by_last_attempt: false },
      { number: 2, by_last_attempt: true },
    ]);
    expect(
      await server.query(
        `select id, from_migration, to_migration, outcome from deployment_history.attempts order by id`,
        [],
        database,
      ),
    ).toEqual([
      expect.objectContaining({
        from_migration: 1,
        to_migration: 1,
        outcome: "succeeded",
      }),
      {
        id: String(again.attemptId),
        from_migration: null,
        to_migration: null,
        outcome: "succeeded",
      },
      expect.objectContaining({
        from_migration: 2,
        to_migration: 2,
        outcome: "succeeded",
      }),
    ]);
  });

  test("applies every pending migration in one transaction: when a later one fails on the target's data, none is applied and the failed attempt is still logged", async () => {
    const { dir, project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    await server.query(
      "insert into customers (id, name) values (1, '')",
      [],
      database,
    );
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add orders");
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null constraint customers_name_present check (name <> '')",
      ),
    );
    await finalizeMigration(project, "require names");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    const file = "data-model/migrations/00003-require-names/schema-change.sql";
    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect(error).toMatchObject({ file });
    expect((error as SqlFileFailedError).detail).toContain(
      "customers_name_present",
    );
    expect(
      await server.query(
        "select to_regclass('orders') as orders",
        [],
        database,
      ),
    ).toEqual([{ orders: null }]);
    expect(
      await server.query(
        "select number from deployment_history.migrations",
        [],
        database,
      ),
    ).toEqual([{ number: 1 }]);
    expect(
      await server.query(
        `select from_migration, to_migration, outcome, error_file, error like '%customers_name_present%' as names_constraint, ended_at is not null as ended
           from deployment_history.attempts order by id desc limit 1`,
        [],
        database,
      ),
    ).toEqual([
      {
        from_migration: 2,
        to_migration: 3,
        outcome: "failed",
        error_file: file,
        names_constraint: true,
        ended: true,
      },
    ]);
  });

  test("a first deployment that fails still creates the history schema and logs the failed attempt, and nothing else", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        // Fault injection: the target refuses migration 2's schema change.
        adapter: `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async execute(sql) {
        if (sql.includes('"orders"')) throw new Error("injected failure");
        return session.execute(sql);
      },
    };
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add orders");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect(error).toMatchObject({
      file: "data-model/migrations/00002-add-orders/schema-change.sql",
    });
    expect(
      await server.query(
        "select to_regclass('customers') as customers",
        [],
        database,
      ),
    ).toEqual([{ customers: null }]);
    expect(
      await server.query(
        "select count(*)::int as count from deployment_history.migrations",
        [],
        database,
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await server.query(
        "select outcome, error, from_migration, to_migration from deployment_history.attempts",
        [],
        database,
      ),
    ).toEqual([
      {
        outcome: "failed",
        error: expect.stringContaining("injected failure"),
        from_migration: 1,
        to_migration: 2,
      },
    ]);
  });

  test("fails fast when a lock isn't granted within the target's lock timeout", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { target: 'lockTimeout: "200ms",' },
    );
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  email text",
      ),
    );
    await finalizeMigration(project, "add email");
    const holder = await testSession(server, database);
    try {
      await holder.execute(
        // ACCESS SHARE: the drift check can still read the table's
        // definition, but the migration's ALTER TABLE has to wait.
        "BEGIN; LOCK TABLE customers IN ACCESS SHARE MODE",
      );

      const error = await deploy(project, { target: "dev" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SqlFileFailedError);
      expect((error as SqlFileFailedError).detail).toMatch(/lock timeout/);
    } finally {
      await holder.close();
    }
    expect(
      (await deploy(project, { target: "dev" })).deployed.map((m) => m.number),
    ).toEqual([2]);
  });

  test("cancels a statement that runs longer than the target's statement timeout", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { target: 'lockTimeout: "1min", statementTimeout: "300ms",' },
    );
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  email text",
      ),
    );
    await finalizeMigration(project, "add email");
    const holder = await testSession(server, database);
    try {
      await holder.execute(
        // ACCESS SHARE: the drift check can still read the table's
        // definition, but the migration's ALTER TABLE has to wait.
        "BEGIN; LOCK TABLE customers IN ACCESS SHARE MODE",
      );

      const error = await deploy(project, { target: "dev" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SqlFileFailedError);
      expect((error as SqlFileFailedError).detail).toMatch(/statement timeout/);
    } finally {
      await holder.close();
    }
  });

  test("pins search path, time zone, date and interval styles and the target's timeouts inside the transaction", async () => {
    // The adapter reads the settings on the deploy session right after the
    // schema change runs (deploy-time rules keep DML out of schema changes,
    // so the schema change cannot record them itself).
    const { project, database } = await deployProject(
      server,
      {
        "settings.sql":
          "create table deploy_settings (name text primary key, value text not null);\n",
      },
      {
        target: 'lockTimeout: "2s", statementTimeout: "1min",',
        adapter: settingsRecordingAdapter,
      },
    );
    await draft(project, { name: "record settings" });
    await finalize(project);
    // Server defaults that the pinned settings must override.
    await server.query(`create database ${database}`);
    await server.query(
      `alter database ${database} set "TimeZone" to 'America/New_York'`,
    );
    await server.query(
      `alter database ${database} set "DateStyle" to 'SQL, DMY'`,
    );

    await deploy(project, { target: "dev" });

    expect((globalThis as { deploySettings?: unknown }).deploySettings).toEqual(
      [
        { name: "DateStyle", value: "ISO, YMD" },
        { name: "IntervalStyle", value: "postgres" },
        { name: "TimeZone", value: "UTC" },
        { name: "lock_timeout", value: "2s" },
        { name: "search_path", value: "public, pg_catalog" },
        { name: "statement_timeout", value: "1min" },
      ],
    );
  });

  test("rehearses on a throwaway database matching the target's encoding, locale and collation provider, and drops it", async () => {
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        rehearsal: `{
  async createDatabase(request) {
    (globalThis.deployRehearsalRequests ??= []).push(request);
    return postgres.rehearsal.createDatabase(request);
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");
    const requests: unknown[] = [];
    Object.assign(globalThis, { deployRehearsalRequests: requests });
    const rehearsalDatabases = async () =>
      (await server.databases()).filter((name) =>
        name.startsWith("super_deploy_rehearsal_"),
      );
    const before = await rehearsalDatabases();

    await deploy(project, { target: "dev" });

    // The test server's databases are initialised with UTF8 and libc locale C.
    // Two: the replica (drift check, then the pending migrations) and the
    // newest desired-schema snapshot it must match.
    const targetLocale = {
      encoding: "UTF8",
      locale: "C",
      collationProvider: "libc",
    };
    expect(requests).toEqual([targetLocale, targetLocale]);
    expect(await rehearsalDatabases()).toEqual(before);

    // Up to date: only the replica, for the drift check.
    requests.length = 0;
    await deploy(project, { target: "dev" });
    expect(requests).toEqual([targetLocale]);
  });

  test("never touches the target when the rehearsal fails", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        // Fault injection: only drafts and finalize get throwaway databases.
        rehearsal: `{
  async createDatabase(request) {
    if (request.collationProvider === "libc") throw new Error("rehearsal server unavailable");
    return postgres.rehearsal.createDatabase(request);
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as Error).message).toContain("rehearsal server unavailable");
    expect(
      await server.query(
        "select to_regclass('customers') as customers",
        [],
        database,
      ),
    ).toEqual([{ customers: null }]);
    expect(
      await server.query(
        "select outcome from deployment_history.attempts",
        [],
        database,
      ),
    ).toEqual([{ outcome: "failed" }]);
  });
});

/** A `dev` adapter that stores the deploy session's settings in `globalThis.deploySettings` after the batch creating deploy_settings. */
const settingsRecordingAdapter = `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async execute(sql) {
        const results = await session.execute(sql);
        if (sql.includes('"deploy_settings"')) {
          const { rows } = await session.query(
            "select name, current_setting(name) as value from pg_catalog.pg_settings where name in ('search_path', 'TimeZone', 'DateStyle', 'IntervalStyle', 'lock_timeout', 'statement_timeout') order by name",
          );
          globalThis.deploySettings = rows;
        }
        return results;
      },
    };
  },
}`;

/** A `dev` adapter whose deploy transaction waits at its COMMIT while `globalThis.deployBeforeCommit` is set. */
const pausingAdapter = `{
  async connect() {
    const session = await real.connect();
    // Only the deploy transaction sets lock_timeout (the attempt-log session
    // also commits once, when it creates the history schema).
    let deploying = false;
    return {
      ...session,
      async execute(sql) {
        // The drift check reads the catalogs under the same timeouts, READ ONLY.
        deploying ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        const pause = globalThis.deployBeforeCommit;
        if (deploying && sql === "COMMIT" && pause !== undefined) {
          globalThis.deployBeforeCommit = undefined;
          await pause();
        }
        return session.execute(sql);
      },
    };
  },
}`;

/** Makes the next deployment through `pausingAdapter` wait at COMMIT until released. */
function pauseAtCommit(): { reached: Promise<void>; release: () => void } {
  let release = () => {};
  const reached = new Promise<void>((resolveReached) => {
    Object.assign(globalThis, {
      deployBeforeCommit: () => {
        resolveReached();
        return new Promise<void>((resolveRelease) => {
          release = resolveRelease;
        });
      },
    });
  });
  return { reached, release: () => release() };
}

describe("the target lock", () => {
  test("a second deployment fails at once while one holds the session-level advisory lock, naming its attempt", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: pausingAdapter },
    );
    await finalizeMigration(project, "add customers");
    const advisoryLocks = async () =>
      server.query(
        `select count(*)::int as count from pg_locks
          where locktype = 'advisory' and granted
            and database = (select oid from pg_database where datname = $1)`,
        [database],
      );
    const paused = pauseAtCommit();

    const first = deploy(project, { target: "dev" });
    await paused.reached;
    const second = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );
    expect(await advisoryLocks()).toEqual([{ count: 1 }]);
    paused.release();
    const firstResult = await first;

    expect(second).toBeInstanceOf(TargetLockedError);
    expect((second as TargetLockedError).holder.attempt).toMatchObject({
      id: firstResult.attemptId,
      command: "deploy",
    });
    expect(await advisoryLocks()).toEqual([{ count: 0 }]);
    expect(
      await server.query(
        "select id, outcome, coalesce(error like '%locked by attempt #' || $1 || ' %', false) as names_holder from deployment_history.attempts order by id",
        [firstResult.attemptId],
        database,
      ),
    ).toEqual([
      {
        id: String(firstResult.attemptId),
        outcome: "succeeded",
        names_holder: false,
      },
      { id: expect.any(String), outcome: "failed", names_holder: true },
    ]);
  });

  test("is keyed from the history schema name: a project with another history schema on the same database is not blocked", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: pausingAdapter },
    );
    await finalizeMigration(project, "add customers");
    const other = await deployProject(
      server,
      { "customers.sql": customers },
      {
        database,
        settings: 'managedSchema: "other", historySchema: "other_history",',
      },
    );
    await finalizeMigration(other.project, "add customers");
    const paused = pauseAtCommit();

    const first = deploy(project, { target: "dev" });
    try {
      await paused.reached;
      await expect(
        deploy(other.project, { target: "dev" }),
      ).resolves.toMatchObject({ deployed: [{ number: 1 }] });
    } finally {
      paused.release();
      await first;
    }
  });
});

describe("deploy configuration", () => {
  test("uses the configured managed and history schemas, creating both", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { settings: 'managedSchema: "app", historySchema: "ops_history",' },
    );
    await finalizeMigration(project, "add customers");

    await deploy(project, { target: "dev" });

    expect(
      await server.query(
        `select to_regclass('app.customers')::text as customers,
                to_regnamespace('deployment_history') as default_history,
                (select count(*)::int from ops_history.migrations) as recorded,
                (select count(*)::int from ops_history.attempts) as attempts,
                (select disposable from ops_history.settings) as disposable`,
        [],
        database,
      ),
    ).toEqual([
      {
        customers: "app.customers",
        default_history: null,
        recorded: 1,
        attempts: 1,
        disposable: false,
      },
    ]);
  });

  test("connects only to the target it names", async () => {
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        preamble: 'import { postgresTarget } from "super-deploy";',
        otherTargets:
          'prod: { adapter: postgresTarget({ env: "SUPER_DEPLOY_TEST_UNSET_URL" }) },',
      },
    );
    await finalizeMigration(project, "add customers");

    await expect(deploy(project, { target: "dev" })).resolves.toMatchObject({
      deployed: [{ number: 1 }],
    });
    await expect(status(project, { target: "dev" })).resolves.toMatchObject({
      pending: [],
    });
  });

  test("refuses a target that isn't in the config", async () => {
    const { project } = await deployProject(server, {
      "customers.sql": customers,
    });

    const error = await deploy(project, { target: "prod" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnknownTargetError);
    expect(error).toMatchObject({ target: "prod", known: ["dev"] });
    await expect(status(project, { target: "prod" })).rejects.toBeInstanceOf(
      UnknownTargetError,
    );
  });

  test("refuses a target that isn't PostgreSQL 18, writing nothing to it", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        adapter: `{
  async connect() {
    const session = await real.connect();
    return { ...session, serverVersion: async () => "17.6" };
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnsupportedServerError);
    expect(
      await server.query(
        "select to_regnamespace('deployment_history') as history",
        [],
        database,
      ),
    ).toEqual([{ history: null }]);
  });

  test("refuses to deploy edited migrations without connecting to the target", async () => {
    const { dir, project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");
    const schemaChange =
      "data-model/migrations/00001-add-customers/schema-change.sql";
    await chmod(dir.path(schemaChange), 0o644);
    await dir.write(schemaChange, `${await dir.read(schemaChange)}-- edited\n`);

    await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
    // The embedded target creates its database on first connect.
    expect(await server.databases()).not.toContain(database);
  });
});

describe("status", () => {
  test("lists every migration as pending on a new target, without writing to it", async () => {
    const { project, database } = await deployProject(server, {
      "customers.sql": customers,
    });
    await finalizeMigration(project, "add customers");

    const report = await status(project, { target: "dev" });

    expect(report).toEqual({
      target: "dev",
      historySchemaExists: false,
      recorded: [],
      pending: [
        { number: 1, name: "add-customers", folder: "00001-add-customers" },
      ],
      attempts: [],
      disposable: false,
      preflight: {
        missingRoles: [],
        missingExternalSchemas: [],
        historyMismatches: [],
        warnings: [expect.stringContaining("is a superuser")],
      },
      drift: [],
    });
    expect(
      await server.query(
        "select to_regnamespace('deployment_history') as history",
        [],
        database,
      ),
    ).toEqual([{ history: null }]);
  });

  test("lists recorded and pending migrations and the recent attempts, newest first", async () => {
    const { dir, project } = await deployProject(server, {
      "customers.sql": customers,
    });
    const first = await finalizeMigration(project, "add customers");
    const deployed = await deploy(project, { target: "dev" });
    const upToDate = await deploy(project, { target: "dev" });
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add orders");

    const report = await status(project, { target: "dev" });

    expect(report).toMatchObject({
      historySchemaExists: true,
      recorded: [
        {
          number: 1,
          name: "add-customers",
          contentHash: first.contentHash,
          chainHash: first.chainHash,
          recovery: undefined,
          attemptId: deployed.attemptId,
          recordedHow: "deployed",
        },
      ],
      pending: [{ number: 2, name: "add-orders", folder: "00002-add-orders" }],
      disposable: false,
    });
    expect(report.attempts).toEqual([
      expect.objectContaining({
        id: upToDate.attemptId,
        outcome: "succeeded",
        fromMigration: undefined,
      }),
      expect.objectContaining({
        id: deployed.attemptId,
        command: "deploy",
        target: "dev",
        outcome: "succeeded",
        fromMigration: 1,
        toMigration: 1,
        osUser: userInfo().username,
        startedAt: expect.any(Date),
        endedAt: expect.any(Date),
        error: undefined,
      }),
    ]);
  });
});
