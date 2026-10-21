// Interruption at the CLI process seam: signals and closed output stop the
// running command, clean up, print one notice and exit 130, 141 or 143.
import { join } from "node:path";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli, spawnCli, waitForFile } from "../support/cli.ts";
import {
  onStoppedServer,
  startTestServer,
  type TestServer,
} from "../support/postgres.ts";
import {
  createTestProject,
  downTargetConfig,
  stallingConfig,
} from "../support/project.ts";
import { silentHost } from "../support/silent-host.ts";

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

test("a second interrupt exits at once, even while cleanup is still running", async () => {
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
  cli.signal("SIGINT");
  const result = await cli.result;

  expect(result.exitCode).toBe(130);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  for (const name of await rehearsalDatabases()) {
    await server.query(`drop database "${name}" with (force)`);
  }
});

test("closed output stops the command and exits 141", async () => {
  const dir = await createTestProject();
  const cli = spawnCli(["--help"], { cwd: dir.root });
  cli.child.stdout?.destroy();

  const result = await cli.result;

  expect(result.exitCode).toBe(141);
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
