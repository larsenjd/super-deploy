// CLI process seam: a signal during a real `deploy` rolls back, records the
// attempt as abandoned, releases the target lock, drops throwaway databases
// and exits with the signal's code, promptly even when Ctrl+C also stopped the
// project's own embedded server. A process killed outright leaves its attempt
// running, and the next `status` settles it; killed mid-statement, its
// server process ends within seconds (the client connection check). A
// `status` while a deployment holds the target names the holder, what its
// server process runs and how to end it, and leaves drift unchecked.
import { userInfo } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli, spawnCli, waitForFile } from "../support/cli.ts";
import { asDeployRole, deployConfig } from "../support/deploy.ts";
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
// TEST_MARKER is written first, then `pg_sleep(60)` runs. With
// TEST_STALL=committed the deploy transaction's COMMIT succeeds, then the
// marker is written and the deployment waits for SIGINT before going on. With
// TEST_STALL=close, closing the project (after the command has finished)
// writes the marker, then takes 2 s. `rehearsal` is the
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
  async close() {
    if (stall === "close") {
      writeFileSync(process.env.TEST_MARKER, "");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await ${rehearsal}.close();
  },
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
        const result = await session.execute(sql);
        if (stall === "committed" && deploying && sql === "COMMIT") {
          writeFileSync(process.env.TEST_MARKER, "");
          await new Promise((resolve) => process.once("SIGINT", resolve));
        }
        return result;
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
      expect.stringContaining(`Interrupted by ${signal}`),
      "The deployment rolled back: target dev is unchanged, with no migration recorded.",
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

/** `finalizedProject`, deployed, then a second migration pending on `dev`. */
async function secondMigrationPending() {
  const project = await finalizedProject();
  const { dir } = project;
  await dir.write(
    "data-model/desired-schema/orders.sql",
    "create table orders (id bigint primary key);\n",
  );
  for (const args of [
    ["deploy", "--target", "dev"],
    ["draft", "--name", "add orders"],
    ["finalize"],
  ]) {
    expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
  }
  return project;
}

// 110: once cleanup has finished, a command that changes a target says what
// happened to it.
describe.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("%s during a deploy transaction", (signal, exitCode) => {
  test(`exits ${exitCode}, ending with the rolled-back line naming the target's last recorded migration`, async () => {
    const { dir, marker } = await secondMigrationPending();
    const cli = spawnCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
      env: { TEST_STALL: "transaction", TEST_MARKER: marker },
    });
    await waitForFile(marker);

    cli.signal(signal);
    const result = await cli.result;

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toEqual([
      expect.stringContaining(`Interrupted by ${signal}`),
      "The deployment rolled back: target dev is unchanged, still at migration 00001-add-customers.",
    ]);
  });
});

test("SIGINT after the deploy transaction committed exits 130, saying the deployment had already finished", async () => {
  const { dir, marker } = await finalizedProject();
  const cli = spawnCli(["deploy", "--target", "dev"], {
    cwd: dir.root,
    env: { TEST_STALL: "committed", TEST_MARKER: marker },
  });
  await waitForFile(marker);

  cli.signal("SIGINT");
  const result = await cli.result;

  expect(result.exitCode).toBe(130);
  expect(result.stdout).toBe(
    "Deployed 1 migration to dev: 00001-add-customers\n",
  );
  expect(result.stderr.trim().split("\n")).toEqual([
    expect.stringContaining("Interrupted by SIGINT"),
    "The deployment had already finished: the interruption came too late to stop it on target dev.",
  ]);
  const status = await runCli(["status", "--target", "dev"], {
    cwd: dir.root,
  });
  expect(status.stdout).toContain("#1 deploy succeeded migration 1 by ");
});

// Ctrl+C in a terminal reaches the whole process group. The project's own
// embedded server runs in a session of its own, so the CLI cleans up on it
// and then stops it as its last client.
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
      // Promptly: well inside a stop's 60 s timeout.
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

// 144: once the command has finished, an interruption while the CLI closes
// the project (stopping embedded servers) doesn't change its exit code.
describe("SIGINT after the command has finished, while the project closes", () => {
  test("exits 0 after a deploy that succeeded, which stays succeeded", async () => {
    const { dir, marker } = await finalizedProject();
    const cli = spawnCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
      env: { TEST_STALL: "close", TEST_MARKER: marker },
      detached: true,
    });
    await waitForFile(marker);

    cli.signalGroup("SIGINT");
    const result = await cli.result;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "Deployed 1 migration to dev: 00001-add-customers\n",
    );
    expect(result.stderr).toContain(
      "Interrupted by SIGINT after deploy finished",
    );
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).toContain("#1 deploy succeeded migration 1 by ");
  });

  test("exits 1 after a deploy that failed", async () => {
    const { dir, database, marker } = await finalizedProject();
    await asDeployRole(
      server,
      database,
      "create table customers (id bigint primary key)",
    );
    const cli = spawnCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
      env: { TEST_STALL: "close", TEST_MARKER: marker },
      detached: true,
    });
    await waitForFile(marker);

    cli.signalGroup("SIGINT");
    const result = await cli.result;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^Error: /m);
  });
});

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
    const holder = `attempt #1 \\(deploy by ${userInfo().username}, started \\S+, server process (\\d+), active, statement started \\S+: select pg_sleep\\(60\\)\\)`;
    const locked = result.stdout.match(
      new RegExp(`^Locked by ${holder}$`, "m"),
    );
    expect(locked).not.toBeNull();
    const pid = locked?.[1];
    expect(result.stderr).toMatch(
      new RegExp(
        `^Error: Target dev is locked by ${holder}; try again when it has finished, or, if it is known to be dead, end its session with select pg_terminate_backend\\(${pid}\\)$`,
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

test("a deployment killed outright mid-statement has its server process end within seconds, not when the statement finishes", async () => {
  const { dir, database, marker } = await finalizedProject();
  const cli = spawnCli(["deploy", "--target", "dev"], {
    cwd: dir.root,
    env: { TEST_STALL: "transaction", TEST_MARKER: marker },
  });
  await waitForFile(marker);

  cli.signal("SIGKILL");
  await cli.result;
  const killed = Date.now();
  // The orphaned `pg_sleep(60)` holds the target lock until its server
  // process notices the client is gone: the 5 s client connection check plus
  // a margin, well before the 60 s.
  while ((await advisoryLocks(database)) > 0 && Date.now() - killed < 15_000) {
    await delay(100);
  }

  expect(await advisoryLocks(database)).toBe(0);
  const result = await runCli(["deploy", "--target", "dev"], {
    cwd: dir.root,
  });
  expect(result.stdout).toBe(
    "Deployed 1 migration to dev: 00001-add-customers\n",
  );
});
