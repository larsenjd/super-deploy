// Guarded commands at the CLI process seam: they refuse in CI and without a
// terminal on stdin and stdout, and in a real terminal they show what they
// are about to do and go ahead only when YES is typed.
import { userInfo } from "node:os";
import { deploy, draft, finalize, loadProject } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { deployConfig } from "../support/deploy.ts";
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
async function deployedProject() {
  const project = await guardedProject();
  for (const args of [
    ["draft", "--name", "add customers"],
    ["finalize"],
    ["deploy", "--target", "dev"],
  ]) {
    expect((await runCli(args, { cwd: project.dir.root })).exitCode).toBe(0);
  }
  return project;
}

describe.skipIf(process.platform === "win32")("at a terminal", () => {
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
  });

  test("takes the target lock: refuses while a deployment holds it, naming that attempt", async () => {
    const { dir, database } = await guardedProject({
      adapter: pausingAtCommit,
    });
    const project = await loadProject({ cwd: dir.root });
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
      const terminal = spawnTerminal(
        ["disposable", "--target", "dev", "--set", "yes"],
        { cwd: dir.root },
      );
      await terminal.waitFor("Type YES");
      terminal.type(`YES${keys.enter}`);
      await terminal.waitFor(
        /Error: Target dev is locked by attempt #1 \(deploy by \S+, started/,
      );
      expect(await terminal.exited).toBe(1);
    } finally {
      release();
      await deploying;
      await project.close();
    }
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
  });
});

describe.skipIf(process.platform === "win32")("from the menu", () => {
  test("disposable asks for the target and the value, then goes through the guard and returns to the menu", async () => {
    const { dir, database } = await guardedProject();
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    // The menu starts on draft; Up passes init and wraps round to quit, and
    // disposable is above it.
    terminal.type(`${keys.up}${keys.up}${keys.up}${keys.enter}`);
    await terminal.waitFor("The target to use");
    terminal.type(keys.enter);
    await terminal.waitFor("yes to make the target disposable");
    terminal.type(keys.enter);
    await terminal.waitFor("Last recorded migration: none");
    await terminal.waitFor("Type YES to mark target dev as disposable");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("Target dev is now disposable");

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
});

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
