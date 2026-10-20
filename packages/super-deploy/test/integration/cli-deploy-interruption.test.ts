// CLI process seam: a signal during a real `deploy` rolls back, records the
// attempt as abandoned, releases the target lock, drops throwaway databases
// and exits with the signal's code. A process killed outright leaves its
// attempt running, and the next `status` settles it.
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli, spawnCli, waitForFile } from "../support/cli.ts";
import { deployConfig } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

// With TEST_STALL=rehearsal the deployment's rehearsal stalls in its first
// throwaway session; with TEST_STALL=transaction the deploy transaction stalls
// on the target before its first migration file. Either way the file named by
// TEST_MARKER is written first, then `pg_sleep(60)` runs.
const stalling = `
import { writeFileSync } from "node:fs";
const stall = process.env.TEST_STALL;
async function stallOn(session) {
  writeFileSync(process.env.TEST_MARKER, "");
  await session.query("select pg_sleep(60)");
}
const stallingRehearsal = {
  async createDatabase(request) {
    const database = await postgres.rehearsal.createDatabase(request);
    if (stall !== "rehearsal") return database;
    return {
      name: database.name,
      drop: () => database.drop(),
      async connect() {
        const session = await database.connect();
        let stalled = false;
        return {
          ...session,
          async execute(sql) {
            if (!stalled) {
              stalled = true;
              await stallOn(session);
            }
            return session.execute(sql);
          },
        };
      },
    };
  },
  close: () => postgres.rehearsal.close(),
};
const stallingTarget = {
  async connect() {
    const session = await real.connect();
    let deploying = false;
    let stalled = false;
    return {
      ...session,
      async execute(sql) {
        if (stall === "transaction" && deploying && !stalled) {
          stalled = true;
          await stallOn(session);
        }
        deploying ||= sql.includes("lock_timeout");
        return session.execute(sql);
      },
    };
  },
};
`;

async function finalizedProject() {
  const { config, database } = deployConfig(server, {
    preamble: stalling,
    adapter: "stallingTarget",
    rehearsal: "stallingRehearsal",
  });
  const dir = await createTestProject({
    config,
    files: {
      "data-model/desired-schema/customers.sql":
        "create table customers (id bigint primary key, name text not null);\n",
    },
  });
  for (const args of [["draft", "--name", "add customers"], ["finalize"]]) {
    expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
  }
  return { dir, database, marker: dir.path("stalled") };
}

async function rehearsalDatabases(): Promise<string[]> {
  return (await server.databases()).filter((name) =>
    name.startsWith("super_deploy_rehearsal_"),
  );
}

async function advisoryLocks(database: string): Promise<number> {
  const [row] = await server.query<{ count: number }>(
    `select count(*)::int as count from pg_locks
      where locktype = 'advisory' and granted
        and database = (select oid from pg_database where datname = $1)`,
    [database],
  );
  return row?.count ?? -1;
}

describe.each([
  ["SIGINT", 130, "rehearsal"],
  ["SIGTERM", 143, "transaction"],
] as const)("%s during a deployment's %s", (signal, exitCode, stage) => {
  test(`rolls back, records the attempt as abandoned, releases the lock, drops throwaway databases and exits ${exitCode}`, async () => {
    const { dir, database, marker } = await finalizedProject();
    const cli = spawnCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
      env: { TEST_STALL: stage, TEST_MARKER: marker },
    });
    await waitForFile(marker);
    expect(await advisoryLocks(database)).toBe(1);
    const started = Date.now();

    cli.signal(signal);
    const result = await cli.result;

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toEqual([
      expect.stringContaining(`Interrupted by ${signal}`),
    ]);
    // Well before the stalled statement's 60 s.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await advisoryLocks(database)).toBe(0);
    expect(await rehearsalDatabases()).toEqual([]);
    expect(
      await server.query(
        `select to_regclass('customers') as customers,
                (select count(*)::int from deployment_history.migrations) as recorded`,
        [],
        database,
      ),
    ).toEqual([{ customers: null, recorded: 0 }]);
    expect(
      await server.query(
        "select outcome, error from deployment_history.attempts",
        [],
        database,
      ),
    ).toEqual([{ outcome: "abandoned", error: `Interrupted (${signal})` }]);

    const deployed = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(deployed.stdout).toBe(
      "Deployed 1 migration to dev: 00001-add-customers\n",
    );
  });
});

test("a deployment killed outright leaves its attempt running, and the next status settles it as abandoned", async () => {
  const { dir, database, marker } = await finalizedProject();
  const before = await rehearsalDatabases();
  const cli = spawnCli(["deploy", "--target", "dev"], {
    cwd: dir.root,
    env: { TEST_STALL: "rehearsal", TEST_MARKER: marker },
  });
  await waitForFile(marker);

  cli.signal("SIGKILL");
  await cli.result;
  // The server notices the connection is gone and ends its process.
  while ((await advisoryLocks(database)) > 0) {
    await delay(20);
  }
  expect(
    await server.query(
      "select outcome from deployment_history.attempts",
      [],
      database,
    ),
  ).toEqual([{ outcome: "running" }]);

  const result = await runCli(["status", "--target", "dev"], {
    cwd: dir.root,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("#1 deploy abandoned migration 1 by ");
  expect(result.stdout).toContain(
    "The command ended without recording an outcome; settled as abandoned: none of its migrations are recorded",
  );
  for (const name of await rehearsalDatabases()) {
    if (!before.includes(name)) {
      await server.query(`drop database "${name}" with (force)`);
    }
  }
});
