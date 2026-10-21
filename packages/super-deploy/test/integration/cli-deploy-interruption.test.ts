// CLI process seam: a signal during a real `deploy` rolls back, records the
// attempt as abandoned, releases the target lock, drops throwaway databases
// and exits with the signal's code, promptly even when Ctrl+C also stopped the
// project's own embedded server. A process killed outright leaves its attempt
// running, and the next `status` settles it. A `status` while a deployment
// holds the target names the holder and leaves drift unchecked.
import { userInfo } from "node:os";
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
// TEST_MARKER is written first, then `pg_sleep(60)` runs. `rehearsal` is the
// real rehearsal adapter's expression.
const stalling = (rehearsal: string) => `
import { writeFileSync } from "node:fs";
const stall = process.env.TEST_STALL;
async function stallOn(session) {
  writeFileSync(process.env.TEST_MARKER, "");
  await session.query("select pg_sleep(60)");
}
const stallingRehearsal = {
  async createDatabase(request) {
    const database = await ${rehearsal}.createDatabase(request);
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
  close: () => ${rehearsal}.close(),
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
        // The drift check reads the catalogs under the same timeouts, READ ONLY.
        deploying ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        return session.execute(sql);
      },
    };
  },
};
`;

/**
 * A project with one finalized migration pending on `dev`, a database on the
 * test server. With `ownRehearsalServer` its rehearsals run on the project's
 * own embedded server, which the CLI starts and so owns.
 */
async function finalizedProject({ ownRehearsalServer = false } = {}) {
  const own = `const own = embeddedPostgres({ dataDir: new URL(".super-deploy/postgres/", import.meta.url) });`;
  const { config, database } = deployConfig(server, {
    preamble: ownRehearsalServer
      ? `${own}\n${stalling("own.rehearsal")}`
      : stalling("postgres.rehearsal"),
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
      expect.stringContaining("is a superuser"),
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

// Ctrl+C in a terminal reaches the whole process group, so it also stops the
// project's own embedded server before the CLI has cleaned up.
describe.each([
  ["SIGINT", 130, "rehearsal"],
  ["SIGTERM", 143, "transaction"],
] as const)(
  "%s (exit %i) to the process group during a deployment's %s, while the CLI runs its own embedded server",
  (signal, exitCode, stage) => {
    test("exits promptly with that code, nothing recorded and the server stopped", async () => {
      const { dir, marker } = await finalizedProject({
        ownRehearsalServer: true,
      });
      const cli = spawnCli(["deploy", "--target", "dev"], {
        cwd: dir.root,
        env: { TEST_STALL: stage, TEST_MARKER: marker },
        detached: true,
      });
      await waitForFile(marker);
      const started = Date.now();

      cli.signalGroup(signal);
      const result = await cli.result;

      expect(result.exitCode).toBe(exitCode);
      // Not after the 10 s an exit hook waits for a server that has already stopped.
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(dir.exists(".super-deploy/postgres/postmaster.pid")).toBe(false);
      const status = await runCli(["status", "--target", "dev"], {
        cwd: dir.root,
      });
      expect(status.stdout).toContain(
        "Target dev: 0 migrations recorded, 1 pending\n",
      );
      expect(status.stdout).toContain("#1 deploy abandoned migration 1 by ");
      expect(status.stdout).toContain(`Interrupted (${signal})`);
    });
  },
);

test("status during a deployment names the holder, leaves drift unchecked and exits 1", async () => {
  const { dir, marker } = await finalizedProject();
  const cli = spawnCli(["deploy", "--target", "dev"], {
    cwd: dir.root,
    env: { TEST_STALL: "transaction", TEST_MARKER: marker },
  });
  try {
    await waitForFile(marker);

    const result = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(
      /^Error: Target dev is locked by attempt #1 \(deploy by .*\); try again when it has finished$/m,
    );
    expect(result.stdout).toMatch(
      new RegExp(
        `^Locked by attempt #1 \\(deploy by ${userInfo().username}, started \\S+, server process \\d+\\)$`,
        "m",
      ),
    );
    expect(result.stdout).toContain(
      "Drift: not checked (the target is locked by attempt #1)\n",
    );
  } finally {
    cli.signal("SIGTERM");
    await cli.result;
  }
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
