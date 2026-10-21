// Guarded commands at the CLI process seam: they refuse in CI and without a
// terminal on stdin and stdout, and in a real terminal they show what they
// are about to do and go ahead only when YES is typed.
import { userInfo } from "node:os";
import { deploy, draft, finalize, loadProject } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { asDeployRole, deployConfig } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";
import { keys, showCursor, spawnTerminal } from "../support/terminal.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

async function guardedProject(
  options: Parameters<typeof deployConfig>[1] = {},
) {
  const { config, database } = deployConfig(server, options);
  const dir = await createTestProject({
    config,
    files: {
      "data-model/desired-schema/customers.sql":
        "create table customers (id bigint primary key, name text not null);\n",
    },
  });
  return { dir, database };
}

describe("guarded commands refuse", () => {
  test("in CI, without connecting to the target", async () => {
    const { dir, database } = await guardedProject();

    const result = await runCli(
      ["disposable", "--target", "dev", "--set", "yes"],
      {
        cwd: dir.root,
        env: { CI: "true" },
      },
    );

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toBe(
      "Error: disposable never runs in CI: run it yourself at a terminal, where it asks you to type YES\n",
    );
    expect(await server.databases()).not.toContain(database);
  });

  test("without a terminal on stdin and stdout, even outside CI", async () => {
    const { dir, database } = await guardedProject();

    const result = await runCli(
      ["disposable", "--target", "dev", "--set", "yes"],
      {
        cwd: dir.root,
        env: { CI: "" },
      },
    );

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toBe(
      "Error: disposable needs a terminal on stdin and stdout: run it yourself at a terminal, where it asks you to type YES\n",
    );
    expect(await server.databases()).not.toContain(database);
  });

  test.skipIf(process.platform === "win32")(
    "in CI even at a terminal",
    async () => {
      const { dir, database } = await guardedProject();

      const terminal = spawnTerminal(
        ["disposable", "--target", "dev", "--set", "yes"],
        { cwd: dir.root, env: { CI: "1" } },
      );

      await terminal.waitFor("disposable never runs in CI");
      expect(await terminal.exited).toBe(1);
      expect(await server.databases()).not.toContain(database);
    },
  );
});

/** Drafts, finalizes and deploys `add customers` to `dev`. */
async function deployedProject(
  options: Parameters<typeof deployConfig>[1] = {},
) {
  const project = await guardedProject(options);
  for (const args of [
    ["draft", "--name", "add customers"],
    ["finalize"],
    ["deploy", "--target", "dev"],
  ]) {
    expect((await runCli(args, { cwd: project.dir.root })).exitCode).toBe(0);
  }
  return project;
}

/** A URL for `database` on the test server as the deploy role, naming its host `localhost`. */
async function localhostUrl(database: string): Promise<string> {
  const client = embeddedPostgres({ dataDir: server.dataDir });
  try {
    const url = new URL(await client.connectionString(database));
    url.hostname = "localhost";
    url.username = "deployer";
    url.password = "deployer";
    return url.href;
  } finally {
    await client.stop();
  }
}

describe.skipIf(process.platform === "win32")("at a terminal", () => {
  test("the Host line shows a postgresTarget's host as configured, then the server's address", async () => {
    const { dir, database } = await deployedProject({
      preamble: 'import { postgresTarget } from "super-deploy";',
      otherTargets:
        'qa: { adapter: postgresTarget({ env: "SUPER_DEPLOY_TEST_QA_URL" }) },',
    });

    const terminal = spawnTerminal(
      ["disposable", "--target", "qa", "--set", "yes"],
      {
        cwd: dir.root,
        env: { SUPER_DEPLOY_TEST_QA_URL: await localhostUrl(database) },
      },
    );

    const shown = await terminal.waitFor("Type YES");
    expect(shown).toMatch(/Target: +qa/);
    expect(shown).toMatch(
      /Host: +localhost:(\d+) \((?:127\.0\.0\.1|\[::1\]):\1\)/,
    );
    expect(shown).not.toContain("deployer");
    terminal.type(keys.ctrlC);
    expect(await terminal.exited).toBe(1);
  });

  test("the Host line shows only the server's address for an adapter that doesn't say where it connects", async () => {
    const { dir } = await deployedProject({
      otherTargets:
        "qa: { adapter: { connect: (options) => real.connect(options) } },",
    });

    const terminal = spawnTerminal(
      ["disposable", "--target", "qa", "--set", "yes"],
      { cwd: dir.root },
    );

    expect(await terminal.waitFor("Type YES")).toMatch(
      /Host: +127\.0\.0\.1:\d+ +│/,
    );
    terminal.type(keys.ctrlC);
    expect(await terminal.exited).toBe(1);
  });

  test("disposable shows the action and the target's details, and sets the flag once YES is typed, recording a manual attempt", async () => {
    const { dir, database } = await deployedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    const shown = await terminal.waitFor(
      "Type YES to mark target dev as disposable",
    );
    expect(shown).toContain("disposable: Mark target dev as disposable");
    expect(shown).toMatch(/Target: +dev/);
    expect(shown).toMatch(/Host: +127\.0\.0\.1:\d+|Host: +local socket/);
    expect(shown).toMatch(new RegExp(`Database: +${database}`));
    expect(shown).toContain("Last recorded migration: 00001-add-customers");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("Target dev is now disposable");
    expect(await terminal.exited).toBe(0);

    expect(
      await server.query(
        "select disposable from deployment_history.settings",
        [],
        database,
      ),
    ).toEqual([{ disposable: true }]);
    expect(
      await server.query(
        "select command, target, os_user, outcome from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([
      expect.objectContaining({ command: "deploy" }),
      {
        command: "disposable",
        target: "dev",
        os_user: userInfo().username,
        outcome: "succeeded",
      },
    ]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).toMatch(/^Target dev \(disposable\):/);
  });

  test("each disposable attempt records which way it set the flag, and status shows it", async () => {
    const { dir } = await deployedProject();
    for (const [set, now] of [
      ["yes", "disposable"],
      ["no", "not disposable"],
    ] as const) {
      const terminal = spawnTerminal(
        ["disposable", "--target", "dev", "--set", set],
        { cwd: dir.root },
      );
      await terminal.waitFor("Type YES");
      terminal.type(`YES${keys.enter}`);
      await terminal.waitFor(`Target dev is now ${now}`);
      expect(await terminal.exited).toBe(0);
    }

    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).toMatch(
      /^ {2}#3 disposable set no succeeded by \S+ at \S+\n {2}#2 disposable set yes succeeded by \S+ at \S+\n {2}#1 deploy succeeded migration 1 by /m,
    );
  });

  test("disposable --set yes says how many tables the managed schema holds and about how many rows, and what the flag allows", async () => {
    const { dir, database } = await deployedProject();
    await asDeployRole(
      server,
      database,
      `insert into customers select n, 'customer ' || n from generate_series(1, 1000) n;
       create table notes (id bigint);
       insert into notes values (1), (2);
       analyze customers;
       analyze notes;`,
    );

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    const shown = await terminal.waitFor("Type YES");
    expect(shown).toContain("Schema public holds 2 tables, about 1,002 rows");
    expect(shown).toContain(
      "deploy-draft will then be allowed to deploy a draft and its seed data to it, and rebuild to wipe it",
    );
    terminal.type(keys.ctrlC);
    expect(await terminal.exited).toBe(1);
  });

  test("disposable --set yes counts a partitioned table once, with its partitions' rows", async () => {
    const { dir, database } = await deployedProject();
    await asDeployRole(
      server,
      database,
      `create table events (id bigint, at date) partition by range (at);
       create table events_2025 partition of events
         for values from ('2025-01-01') to ('2026-01-01');
       create table events_2026 partition of events
         for values from ('2026-01-01') to ('2027-01-01');
       insert into events select n, date '2025-06-01' + n * 30 from generate_series(1, 10) n;
       analyze customers;
       analyze events;`,
    );

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    expect(await terminal.waitFor("Type YES")).toContain(
      "Schema public holds 2 tables, about 10 rows",
    );
    terminal.type(keys.ctrlC);
    expect(await terminal.exited).toBe(1);
  });

  test("disposable --set yes counts the rows of a table not yet analyzed, and says when the managed schema holds no tables", async () => {
    const { dir, database } = await deployedProject();
    await asDeployRole(
      server,
      database,
      "insert into customers select n, 'customer ' || n from generate_series(1, 500) n",
    );
    // Until autovacuum analyzes it, the table's row estimate is the
    // statistics' live-row count, which its inserting session reports when
    // it ends.
    await expect
      .poll(
        async () =>
          (
            await server.query<{ rows: number }>(
              "select pg_stat_get_live_tuples('customers'::regclass)::int as rows",
              [],
              database,
            )
          )[0]?.rows,
      )
      .toBe(500);

    const counted = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );
    expect(await counted.waitFor("Type YES")).toContain(
      "Schema public holds 1 table, about 500 rows",
    );
    counted.type(keys.ctrlC);
    expect(await counted.exited).toBe(1);

    const empty = await guardedProject();
    const none = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: empty.dir.root },
    );
    expect(await none.waitFor("Type YES")).toContain(
      "Schema public holds no tables",
    );
    none.type(keys.ctrlC);
    expect(await none.exited).toBe(1);
  });

  test("anything but YES typed exactly refuses: nothing changes and no attempt is recorded", async () => {
    const { dir, database } = await deployedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    await terminal.waitFor("Type YES");
    terminal.type(`yes${keys.enter}`);
    await terminal.waitFor(
      'Error: disposable on target dev was not confirmed (typed "yes", not YES): nothing changed',
    );
    expect(await terminal.exited).toBe(1);
    expect(
      await server.query(
        "select disposable from deployment_history.settings",
        [],
        database,
      ),
    ).toEqual([{ disposable: false }]);
    expect(
      await server.query(
        "select command from deployment_history.attempts",
        [],
        database,
      ),
    ).toEqual([{ command: "deploy" }]);
  });

  test("Ctrl+C at the question cancels it: nothing changes", async () => {
    const { dir, database } = await guardedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    await terminal.waitFor("Type YES");
    terminal.type(keys.ctrlC);
    await terminal.waitFor(
      "Error: disposable on target dev was not confirmed (cancelled): nothing changed",
    );
    expect(await terminal.exited).toBe(1);
    expect(
      await server.query(
        "select count(*)::int as count from pg_namespace where nspname = 'deployment_history'",
        [],
        database,
      ),
    ).toEqual([{ count: 0 }]);
  });

  test("Ctrl+D on an empty answer cancels the question like Ctrl+C: nothing changes and the cursor is shown again", async () => {
    const { dir, database } = await guardedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    await terminal.waitFor("Type YES");
    const before = terminal.output.length;
    terminal.type(keys.ctrlD);
    await terminal.waitFor(
      "Error: disposable on target dev was not confirmed (cancelled): nothing changed",
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.output.slice(before)).toContain(showCursor);
    expect(terminal.screen).not.toContain("unsettled top-level await");
    expect(
      await server.query(
        "select count(*)::int as count from pg_namespace where nspname = 'deployment_history'",
        [],
        database,
      ),
    ).toEqual([{ count: 0 }]);
  });

  test("Ctrl+D after typing part of the answer leaves the question waiting", async () => {
    const { dir } = await deployedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    await terminal.waitFor("Type YES");
    terminal.type("YE");
    terminal.type(keys.ctrlD);
    terminal.type(`S${keys.enter}`);
    await terminal.waitFor("Target dev is now disposable");
    expect(await terminal.exited).toBe(0);
  });

  test("a target that already has the value is left alone without asking", async () => {
    const { dir, database } = await guardedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "no"],
      { cwd: dir.root },
    );

    await terminal.waitFor(
      "Target dev is already not disposable: nothing changed",
    );
    expect(await terminal.exited).toBe(0);
    expect(terminal.screen).not.toContain("YES");
    // Reading it did not even create the history schema.
    expect(
      await server.query(
        "select count(*)::int as count from pg_namespace where nspname = 'deployment_history'",
        [],
        database,
      ),
    ).toEqual([{ count: 0 }]);
  });

  test("refuses if the target changes between showing its details and taking the lock", async () => {
    const { dir, database } = await deployedProject();

    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );

    await terminal.waitFor("Type YES");
    await server.query(
      "update deployment_history.settings set disposable = true",
      [],
      database,
    );
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Error: Target dev changed while disposable waited for YES",
    );
    expect(await terminal.exited).toBe(1);
    expect(
      await server.query(
        "select command, outcome from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([
      { command: "deploy", outcome: "succeeded" },
      { command: "disposable", outcome: "failed" },
    ]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).toContain("#2 disposable set yes failed by ");
  });

  test("refuses before asking while a deployment holds the target lock, naming that attempt: no attempt is recorded", async () => {
    const { dir, database } = await guardedProject({
      adapter: pausingAtCommit,
    });
    await whileDeploying(dir.root, async () => {
      const terminal = spawnTerminal(
        ["disposable", "--target", "dev", "--set", "yes"],
        { cwd: dir.root },
      );
      await terminal.waitFor(
        /Error: Target dev is locked by attempt #1 \(deploy by \S+, started/,
      );
      expect(await terminal.exited).toBe(1);
      expect(terminal.screen).not.toContain("Type YES");
    });
    expect(await attemptOutcomes(database)).toEqual([
      { command: "deploy", outcome: "succeeded" },
    ]);
  });

  test("takes the target lock after YES: refuses if a deployment took it while the question waited", async () => {
    const { dir, database } = await guardedProject({
      adapter: pausingAtCommit,
    });
    const terminal = spawnTerminal(
      ["disposable", "--target", "dev", "--set", "yes"],
      { cwd: dir.root },
    );
    await terminal.waitFor("Type YES");
    await whileDeploying(dir.root, async () => {
      terminal.type(`YES${keys.enter}`);
      await terminal.waitFor(
        /Error: Target dev is locked by attempt #1 \(deploy by \S+, started/,
      );
      expect(await terminal.exited).toBe(1);
    });
    expect(await attemptOutcomes(database)).toEqual([
      { command: "deploy", outcome: "succeeded" },
      { command: "disposable", outcome: "failed" },
    ]);
  });
});

/**
 * Finalizes `add customers` and runs `body` while its deployment to `dev`
 * holds the target lock, paused at COMMIT (the project's adapter must be
 * `pausingAtCommit`); the deployment then finishes.
 */
async function whileDeploying(
  root: string,
  body: () => Promise<void>,
): Promise<void> {
  const project = await loadProject({ cwd: root });
  try {
    await draft(project, { name: "add customers" });
    await finalize(project);
    let release = () => {};
    const reached = new Promise<void>((resolveReached) => {
      Object.assign(globalThis, {
        guardTestBeforeCommit: () => {
          resolveReached();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      });
    });
    const deploying = deploy(project, { target: "dev" });
    try {
      await reached;
      await body();
    } finally {
      release();
      await deploying;
    }
  } finally {
    await project.close();
  }
}

async function attemptOutcomes(database: string) {
  return server.query(
    "select command, outcome from deployment_history.attempts order by id",
    [],
    database,
  );
}

describe.skipIf(process.platform === "win32")("from the menu", () => {
  test("disposable asks for the target, then whether it should be disposable, naming its current flag with no preselected; the confirmation shows the flag too", async () => {
    const { dir, database } = await guardedProject();
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    await terminal.chooseMenuItem("disposable");
    await terminal.waitFor("The target to use");
    terminal.type(keys.enter);
    await terminal.waitFor(
      "Target dev is not disposable now. Make it disposable?",
    );
    await terminal.waitFor(noSelected);
    terminal.type(keys.up);
    terminal.type(keys.enter);
    await terminal.waitFor("Now: not disposable");
    await terminal.waitFor("Type YES to mark target dev as disposable");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("Target dev is now disposable");

    await terminal.waitFor("quit");
    await terminal.chooseMenuItem("disposable");
    await terminal.waitFor("The target to use");
    terminal.type(keys.enter);
    await terminal.waitFor("Target dev is disposable now. Keep it disposable?");
    await terminal.waitFor(noSelected);
    terminal.type(keys.enter);
    await terminal.waitFor("Now: disposable");
    await terminal.waitFor("Type YES to mark target dev as not disposable");
    terminal.type(`no${keys.enter}`);
    await terminal.waitFor("was not confirmed");

    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
    expect(
      await server.query(
        "select disposable from deployment_history.settings",
        [],
        database,
      ),
    ).toEqual([{ disposable: true }]);
  });

  test("disposable says when it can't read the target's current flag, and still preselects no", async () => {
    const { dir } = await guardedProject({
      otherTargets:
        'down: { adapter: { connect: async () => { throw new Error("no route to host"); } } },',
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    await terminal.chooseMenuItem("disposable");
    await terminal.waitFor("The target to use");
    terminal.type(keys.down);
    terminal.type(keys.enter);
    await terminal.waitFor(
      "Couldn't read whether target down is disposable now (",
    );
    await terminal.waitFor("no route to host");
    await terminal.waitFor("Make it disposable?");
    await terminal.waitFor(noSelected);
    terminal.type(keys.escape);
    await terminal.waitFor("Cancelled: nothing ran");
    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
  });
});

/** A yes/no select with no selected, as the screen shows it. */
const noSelected = /○ yes[^●]*● no/;

/**
 * A `dev` adapter whose deploy transaction waits at COMMIT while
 * `globalThis.guardTestBeforeCommit` is set (only in the test process, so
 * the CLI it spawns is not paused).
 */
const pausingAtCommit = `{
  async connect() {
    const session = await real.connect();
    let deploying = false;
    return {
      ...session,
      async execute(sql) {
        // The drift check reads the catalogs under the same timeouts, READ ONLY.
        deploying ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        const pause = globalThis.guardTestBeforeCommit;
        if (deploying && sql === "COMMIT" && pause !== undefined) {
          globalThis.guardTestBeforeCommit = undefined;
          await pause();
        }
        return session.execute(sql);
      },
    };
  },
}`;
