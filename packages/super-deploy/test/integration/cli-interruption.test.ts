// Interruption at the CLI process seam: signals and closed output stop the
// running command, clean up and exit 129, 130, 141 or 143. Signals print one
// notice; closed output prints none. The same signal twice within a second
// is one interruption; a later second one exits at once.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
} from "vitest";
import { runCli, spawnCli, waitForFile } from "../support/cli.ts";
import { deployConfig } from "../support/deploy.ts";
import {
  onStoppedServer,
  serverRunning,
  startTestServer,
  stopServerOn,
  type TestServer,
} from "../support/postgres.ts";
import {
  createTestProject,
  downTargetConfig,
  stallingConfig,
} from "../support/project.ts";
import { silentHost } from "../support/silent-host.ts";
import { spawnTerminal } from "../support/terminal.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers =
  "create table customers (id bigint primary key, name text not null);\n";

async function rehearsalDatabases(): Promise<string[]> {
  return (await server.databases()).filter((name) =>
    name.startsWith("super_deploy_rehearsal_"),
  );
}

async function stallingProject() {
  const dir = await createTestProject({
    config: stallingConfig(JSON.stringify(server.dataDir)),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const marker = dir.path("stalled");
  return { dir, marker, env: { TEST_STALL: "query", TEST_MARKER: marker } };
}

describe.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const)("%s during a command", (signal, exitCode) => {
  test(`drops throwaway databases, prints one notice and exits ${exitCode}`, async () => {
    const { dir, marker, env } = await stallingProject();
    const started = Date.now();
    const cli = spawnCli(["draft", "--name", "add customers"], {
      cwd: dir.root,
      env,
    });
    await waitForFile(marker);
    expect(await rehearsalDatabases()).not.toEqual([]);

    cli.signal(signal);
    const result = await cli.result;

    expect(result.exitCode).toBe(exitCode);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toEqual([
      expect.stringContaining(`Interrupted by ${signal}`),
    ]);
    // Well before the stalled statement's 60 s.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await rehearsalDatabases()).toEqual([]);
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});

test("SIGTERM while connecting to a target that doesn't answer exits 143 at once", async () => {
  const host = await silentHost();
  const variable = "SUPER_DEPLOY_TEST_DOWN_URL";
  const dir = await createTestProject({
    config: downTargetConfig(variable, 'connectTimeout: "1min"'),
  });
  const cli = spawnCli(["status", "--target", "down"], {
    cwd: dir.root,
    env: { [variable]: host.url },
  });
  await host.connected;

  const signalled = Date.now();
  cli.signal("SIGTERM");
  const result = await cli.result;

  expect(result.exitCode).toBe(143);
  expect(result.stderr.trim().split("\n")).toEqual([
    expect.stringContaining("Interrupted by SIGTERM"),
  ]);
  // Well before the 1 min connectTimeout; a second leaves room for a loaded machine.
  expect(Date.now() - signalled).toBeLessThan(2000);
});

test("a second interrupt a second or more after the first exits at once, even while cleanup is still running", async () => {
  const { dir, marker } = await stallingProject();
  const cli = spawnCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
    env: { TEST_STALL: "drop", TEST_MARKER: marker },
  });
  await waitForFile(marker);

  cli.signal("SIGINT");
  // Wait for the notice, so the first interrupt has surely been handled.
  await new Promise<void>((resolve) => {
    cli.child.stderr?.on("data", () => resolve());
  });
  // Sooner, a repeat of the same signal counts as the same interruption.
  await delay(1100);
  cli.signal("SIGINT");
  const result = await cli.result;

  expect(result.exitCode).toBe(130);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  for (const name of await rehearsalDatabases()) {
    await server.query(`drop database "${name}" with (force)`);
  }
});

test("closed output (e.g. `| head`) stops the command and exits 141 without a notice", async () => {
  const dir = await createTestProject();
  const cli = spawnCli(["--help"], { cwd: dir.root });
  cli.child.stdout?.destroy();

  const result = await cli.result;

  expect(result.exitCode).toBe(141);
  expect(result.stderr).toBe("");
});

test("`status | head` with the pipe closed exits 141 without a notice, leaving no throwaway database or server client behind", async () => {
  const { config } = deployConfig(server);
  const dir = await createTestProject({
    config,
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  for (const args of [
    ["draft", "--name", "add customers"],
    ["finalize"],
    ["deploy", "--target", "dev"],
  ]) {
    expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
  }
  const clients = () => readdir(join(server.dataDir, "super-deploy-clients"));
  const before = await clients();

  // status reads the target and builds a replica for its drift check.
  const cli = spawnCli(["status", "--target", "dev"], { cwd: dir.root });
  cli.child.stdout?.destroy();
  const result = await cli.result;

  expect(result.exitCode).toBe(141);
  expect(result.stderr).toBe("");
  expect(await rehearsalDatabases()).toEqual([]);
  expect(await clients()).toEqual(before);
});

async function ownServerProject() {
  const dir = await createTestProject({
    config: stallingConfig(
      'new URL(".super-deploy/postgres/", import.meta.url)',
    ),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const marker = join(dir.root, "stalled");
  return { dir, marker, env: { TEST_STALL: "query", TEST_MARKER: marker } };
}

async function ownServerDatabases(dataDir: string): Promise<string[]> {
  const rows = await onStoppedServer<{ datname: string }>(
    dataDir,
    "select datname from pg_database where datname like 'super_deploy_rehearsal_%'",
  );
  return rows.map((row) => row.datname);
}

test("SIGTERM while the command runs its own embedded server drops throwaway databases before stopping it", async () => {
  const { dir, marker, env } = await ownServerProject();
  const cli = spawnCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
    env,
  });
  await waitForFile(marker);

  cli.signal("SIGTERM");
  const result = await cli.result;

  expect(result.exitCode).toBe(143);
  expect(result.stderr.trim().split("\n")).toEqual([
    expect.stringContaining("Interrupted by SIGTERM"),
  ]);
  expect(dir.exists(".super-deploy/postgres/postmaster.pid")).toBe(false);
  expect(await ownServerDatabases(dir.path(".super-deploy/postgres"))).toEqual(
    [],
  );
});

test("Ctrl+C to the process group of a command that started its embedded server exits 130 and stops the server", async () => {
  const { dir, marker, env } = await ownServerProject();
  const cli = spawnCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
    env,
    detached: true,
  });
  await waitForFile(marker);

  cli.signalGroup("SIGINT");
  const result = await cli.result;

  expect(result.exitCode).toBe(130);
  expect(result.stderr.trim().split("\n")).toEqual([
    expect.stringContaining("Interrupted by SIGINT"),
  ]);
  expect(dir.exists(".super-deploy/postgres/postmaster.pid")).toBe(false);
});

// In a terminal, a wrapper such as `pnpm exec` forwards SIGTERM and SIGHUP
// to the CLI that the kernel has already signalled as part of the foreground
// group: one interruption, delivered twice within milliseconds.
describe.each([
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)("%s delivered twice within 100 ms", (signal, exitCode) => {
  test(`counts as one interruption: cleans up, stops the embedded server and exits ${exitCode}`, async () => {
    const { dir, marker, env } = await ownServerProject();
    const dataDir = dir.path(".super-deploy/postgres");
    onTestFinished(() => stopServerOn(dataDir));
    const cli = spawnCli(["draft", "--name", "add customers"], {
      cwd: dir.root,
      env,
      detached: true,
    });
    await waitForFile(marker);

    cli.signalGroup(signal);
    await delay(50);
    cli.signalGroup(signal);
    const result = await cli.result;

    expect(result.exitCode).toBe(exitCode);
    expect(result.stderr.trim().split("\n")).toEqual([
      expect.stringContaining(`Interrupted by ${signal}`),
    ]);
    expect(await serverRunning(dataDir)).toBe(false);
    expect(await ownServerDatabases(dataDir)).toEqual([]);
  });
});

// 162: at a guarded command's YES prompt, closing the terminal under
// `pnpm exec` delivers SIGHUP twice (or SIGTERM, signalled to the group).
describe.skipIf(process.platform === "win32").each([
  ["SIGHUP", 129],
  ["SIGTERM", 143],
] as const)(
  "%s twice to the terminal's group at a YES prompt",
  (signal, exitCode) => {
    test(`stops the embedded server the command started and exits ${exitCode}`, async () => {
      const { dir } = await ownServerProject();
      const dataDir = dir.path(".super-deploy/postgres");
      onTestFinished(() => stopServerOn(dataDir));
      const terminal = spawnTerminal(
        ["disposable", "--target", "dev", "--set", "yes"],
        { cwd: dir.root },
      );
      await terminal.waitFor("Type YES to mark target dev as disposable");
      expect(await serverRunning(dataDir)).toBe(true);

      // A few milliseconds apart, as a wrapper forwards it: before cleanup
      // has stopped the server.
      terminal.signalGroup(signal);
      await delay(5);
      terminal.signalGroup(signal);

      expect(await terminal.exited).toBe(exitCode);
      expect(await serverRunning(dataDir)).toBe(false);
      expect(terminal.screen).toContain(
        "Target dev is unchanged: the interruption came before the flag change started.",
      );
    });
  },
);

test("throwaway databases left on the project's own stopped embedded server are dropped when a command next starts it", async () => {
  const { dir } = await ownServerProject();
  const dataDir = dir.path(".super-deploy/postgres");
  const own = embeddedPostgres({ dataDir });
  await own.start();
  await own.stop();
  await onStoppedServer(dataDir, "create database super_deploy_rehearsal_00ff");

  const result = await runCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
  });

  expect(result.exitCode).toBe(0);
  expect(await ownServerDatabases(dataDir)).toEqual([]);
});
