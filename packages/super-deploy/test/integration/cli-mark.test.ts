// `mark` at the CLI process seam, in a real terminal (it is a guarded
// command, so this is the only place its behaviour can be tested): after a
// target was fixed by hand, it records the next pending migration as marked,
// but only if the target matches a replica of its migrations up to it.
import { userInfo } from "node:os";
import { deploy, draft, finalize, loadProject } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import {
  asDeployerPreamble,
  type DeployConfigOptions,
  deployConfig,
  roleName,
  targetDatabaseName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";
import { keys, spawnTerminal } from "../support/terminal.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers =
  "create table customers (id bigint primary key, name text not null);\n";
const orders =
  "create table orders (id bigint primary key, customer_id bigint not null, note text);\n";

/**
 * Migration 1 (customers) deployed to `dev`; migrations 2 (orders, with a
 * post-migration script adding a customer) and 3 (notes) pending.
 */
async function pendingProject(options: DeployConfigOptions = {}) {
  const { config, database } = deployConfig(server, options);
  const dir = await createTestProject({
    config,
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const project = await loadProject({ cwd: dir.root });
  try {
    await draft(project, { name: "add customers" });
    await finalize(project);
    await deploy(project, { target: "dev" });
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await draft(project, { name: "add orders" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "insert into customers (id, name) values (1, 'first');\n",
    );
    await finalize(project);
    await dir.write(
      "data-model/desired-schema/notes.sql",
      "create table notes (id bigint primary key);\n",
    );
    await draft(project, { name: "add notes" });
    await finalize(project);
  } finally {
    await project.close();
  }
  return { dir, database };
}

async function recordedMigrations(database: string) {
  return server.query(
    "select number, recorded_how, recovery, attempt_id::int as attempt from deployment_history.migrations order by number",
    [],
    database,
  );
}

async function attempts(database: string) {
  return server.query<{ command: string; outcome: string }>(
    "select command, outcome, error from deployment_history.attempts order by id",
    [],
    database,
  );
}

describe.skipIf(process.platform === "win32")("mark at a terminal", () => {
  test("records the next pending migration as marked once YES is typed, when the target matches a replica (column order aside), without running its scripts", async () => {
    const { dir, database } = await pendingProject();
    const owner = `mark_owner_${database}`;
    // Fixed by hand: columns in another order, owned by another role (the
    // superuser deploy role is a member of every role).
    await server.query(`create role ${owner}`);
    await server.query(
      `create table orders (note text, customer_id bigint not null, id bigint primary key);
       alter table orders owner to ${owner};`,
      [],
      database,
    );

    const terminal = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });

    const shown = await terminal.waitFor(
      "Type YES to mark migration 00002-add-orders as deployed on target dev",
    );
    expect(shown).toContain(
      "mark: Mark migration 00002-add-orders as deployed on target dev",
    );
    expect(shown).toMatch(/Target: +dev/);
    expect(shown).toMatch(new RegExp(`Database: +${database}`));
    expect(shown).toContain("Last recorded migration: 00001-add-customers");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Marked migration 00002-add-orders as deployed on target dev (attempt #2)",
    );
    expect(await terminal.exited).toBe(0);

    expect(await recordedMigrations(database)).toEqual([
      { number: 1, recorded_how: "deployed", recovery: null, attempt: 1 },
      { number: 2, recorded_how: "marked", recovery: null, attempt: 2 },
    ]);
    expect(
      await server.query(
        "select command, target, os_user, from_migration, to_migration, outcome from deployment_history.attempts where id = 2",
        [],
        database,
      ),
    ).toEqual([
      {
        command: "mark",
        target: "dev",
        os_user: userInfo().username,
        from_migration: 2,
        to_migration: 2,
        outcome: "succeeded",
      },
    ]);
    // The post-migration script never ran.
    expect(
      await server.query(
        "select count(*)::int as count from customers",
        [],
        database,
      ),
    ).toEqual([{ count: 0 }]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toMatch(
      /^Target dev: 2 migrations recorded, 1 pending\n/,
    );
    expect(status.stdout).toContain("Pending:\n  00003-add-notes\n");
  });
  test("refuses without asking when the target differs from the replica, listing the differences: nothing is recorded", async () => {
    const { dir, database } = await pendingProject();
    // Fixed by hand, but without orders.note, and migration 3's table added too.
    await server.query(
      `create table orders (id bigint primary key, customer_id bigint not null);
       create table notes (id bigint primary key);`,
      [],
      database,
    );

    const terminal = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });

    const shown = await terminal.waitFor(
      "Error: Target dev does not match a replica of its migrations up to 00002-add-orders: column note of table orders (missing), index notes_pkey (extra), table notes (extra). Nothing was recorded",
    );
    expect(await terminal.exited).toBe(1);
    expect(shown).toContain(
      "The target differs from a replica of its migrations up to 00002-add-orders:",
    );
    expect(shown).toContain("missing: column note of table orders");
    expect(shown).toContain("extra: table notes");
    expect(shown).not.toContain("Type YES");
    expect(await recordedMigrations(database)).toEqual([
      { number: 1, recorded_how: "deployed", recovery: null, attempt: 1 },
    ]);
    expect(await attempts(database)).toEqual([
      { command: "deploy", outcome: "succeeded", error: null },
    ]);
  });

  test("refuses without asking when the hand-applied objects belong to a role the deploy role isn't a member of, until it owns them", async () => {
    const deployer = roleName("deployer");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create database ${database} owner ${deployer}`);
    const { dir } = await pendingProject({
      database,
      preamble: asDeployerPreamble(database, deployer),
      adapter: "asDeployer",
    });
    // Fixed by hand as the superuser, so it owns the table.
    await server.query(orders, [], database);
    const fix = `ALTER TABLE public.orders OWNER TO ${deployer}`;

    const terminal = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });

    await terminal.waitFor(
      `Error: The deploy role on target dev doesn't own everything in the managed schema: table public.orders is owned by super_deploy, whose privileges the deploy role doesn't have (fix: ${fix})`,
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.screen).not.toContain("Type YES");
    expect(await recordedMigrations(database)).toEqual([
      { number: 1, recorded_how: "deployed", recovery: null, attempt: 1 },
    ]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).toContain(
      `Deploy would refuse:\n  table public.orders is owned by super_deploy, whose privileges the deploy role doesn't have (fix: ${fix})\n`,
    );

    await server.query(fix, [], database);
    const again = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });
    await again.waitFor("Type YES");
    again.type(`YES${keys.enter}`);
    await again.waitFor(
      "Marked migration 00002-add-orders as deployed on target dev",
    );
    expect(await again.exited).toBe(0);
  });

  test("refuses when nothing is pending", async () => {
    const { dir, database } = await pendingProject();
    const project = await loadProject({ cwd: dir.root });
    try {
      await deploy(project, { target: "dev" });
    } finally {
      await project.close();
    }

    const terminal = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });

    await terminal.waitFor(
      "Error: Target dev has no pending migration to mark: it records every migration in the project",
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.screen).not.toContain("Type YES");
    expect((await attempts(database)).map((a) => a.command)).toEqual([
      "deploy",
      "deploy",
    ]);
  });

  test("checks the replica again under the lock: a target changed while waiting for YES is refused", async () => {
    const { dir, database } = await pendingProject();
    await server.query(orders, [], database);

    const terminal = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });

    await terminal.waitFor("Type YES");
    await server.query("alter table orders drop column note", [], database);
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Error: Target dev does not match a replica of its migrations up to 00002-add-orders: column note of table orders (missing)",
    );
    expect(await terminal.exited).toBe(1);
    expect(await recordedMigrations(database)).toEqual([
      { number: 1, recorded_how: "deployed", recovery: null, attempt: 1 },
    ]);
    expect(await attempts(database)).toEqual([
      { command: "deploy", outcome: "succeeded", error: null },
      {
        command: "mark",
        outcome: "failed",
        error: expect.stringContaining("does not match a replica"),
      },
    ]);
  });

  test("a mark whose COMMIT outcome was lost settles from its migrations row: failed when it never landed, succeeded when it did", async () => {
    const { dir, database } = await pendingProject({ adapter: losingAdapter });
    await server.query(orders, [], database);
    const markLosingCommit = async (when: "before" | "after") => {
      const terminal = spawnTerminal(["mark", "--target", "dev"], {
        cwd: dir.root,
        env: { TEST_LOSE_COMMIT: when },
      });
      await terminal.waitFor("Type YES");
      terminal.type(`YES${keys.enter}`);
      await terminal.waitFor(
        "Lost the connection to target dev during COMMIT, so it is unknown whether attempt",
      );
      expect(await terminal.exited).toBe(1);
      expect((await attempts(database)).at(-1)).toMatchObject({
        command: "mark",
        outcome: "unknown",
      });
    };
    // status settles; it exits 1 while orders is drift (not yet recorded).
    const settle = async (exitCode: number) => {
      const status = await runCli(["status", "--target", "dev"], {
        cwd: dir.root,
      });
      expect(status.exitCode).toBe(exitCode);
    };

    await markLosingCommit("before");
    await settle(1);
    expect((await attempts(database)).at(-1)).toMatchObject({
      command: "mark",
      outcome: "failed",
      error: expect.stringContaining("settled as failed"),
    });
    expect(await recordedMigrations(database)).toHaveLength(1);

    await markLosingCommit("after");
    await settle(0);
    expect((await attempts(database)).at(-1)).toMatchObject({
      command: "mark",
      outcome: "succeeded",
      error: expect.stringContaining("settled as succeeded"),
    });
    expect(await recordedMigrations(database)).toEqual([
      { number: 1, recorded_how: "deployed", recovery: null, attempt: 1 },
      { number: 2, recorded_how: "marked", recovery: null, attempt: 3 },
    ]);
  });
});

/**
 * A \`dev\` adapter whose next transaction that sets lock_timeout (outside a
 * READ ONLY catalog read) loses its COMMIT when the CLI runs with
 * TEST_LOSE_COMMIT: \`before\` sending it, or \`after\` it landed.
 */
const losingAdapter = `{
  async connect() {
    const session = await real.connect();
    let writing = false;
    let lost = false;
    const dead = () => { throw new Error("Client has encountered a connection error and is not queryable"); };
    return {
      ...session,
      async query(sql, values) {
        if (lost) dead();
        return session.query(sql, values);
      },
      async execute(sql) {
        if (lost) dead();
        writing ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        const lose = process.env.TEST_LOSE_COMMIT;
        if (writing && sql === "COMMIT" && lose !== undefined) {
          if (lose === "after") await session.execute(sql);
          lost = true;
          await session.close();
          throw new Error("Connection terminated unexpectedly");
        }
        return session.execute(sql);
      },
      async close() {
        if (!lost) await session.close();
      },
    };
  },
}`;
