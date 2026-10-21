// The CLI process seam for commands run at the same time in one project
// (ticket 14): they share the project's own embedded server, none stops it
// under another, and a server left by a command killed outright is cleaned up
// by the next one. Each project has its own data directory on a free port.
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  type RunningCli,
  runCli,
  spawnCli,
  waitForFile,
} from "../support/cli.ts";
import {
  onStoppedServer,
  serverRunning,
  stopServerOn,
} from "../support/postgres.ts";
import { createTestProject, stallingConfig } from "../support/project.ts";

const customers =
  "create table customers (id bigint primary key, name text not null);\n";

/** A project with a draft and its own embedded server, stopped. */
async function draftedProject() {
  const dir = await createTestProject({
    config: stallingConfig(
      'new URL(".super-deploy/postgres/", import.meta.url)',
    ),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const dataDir = dir.path(".super-deploy/postgres");
  onTestFinished(() => stopServerOn(dataDir));
  const drafted = await runCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
  });
  expect(drafted.exitCode).toBe(0);
  return { dir, dataDir };
}

/** Spawns a command, killed when the test finishes if it is still running. */
function spawned(
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): RunningCli {
  const cli = spawnCli(args, { cwd, env });
  onTestFinished(async () => {
    if (cli.child.exitCode === null && cli.child.signalCode === null) {
      cli.signal("SIGKILL");
    }
    await cli.result;
  });
  return cli;
}

test.each([
  [["status --target dev", "status --target dev"]],
  [["status --target dev", "rehearse", "status --target dev"]],
])(
  "commands run at the same time all succeed, and the server stops after the last: %j",
  async (commands) => {
    const { dir, dataDir } = await draftedProject();

    const results = await Promise.all(
      commands.map((command) => spawned(command.split(" "), dir.root).result),
    );

    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    expect(await serverRunning(dataDir)).toBe(false);
  },
);

test("a rehearsal is not cut off by the command that started the server finishing", async () => {
  const { dir, dataDir } = await draftedProject();
  const stalling = (name: string) => {
    const marker = join(dir.root, name);
    const cli = spawned(["rehearse"], dir.root, {
      TEST_STALL: "query",
      TEST_STALL_SECONDS: "4",
      TEST_MARKER: marker,
    });
    return { cli, stalled: waitForFile(marker) };
  };
  const starter = stalling("starter-stalled");
  await starter.stalled;
  const attached = stalling("attached-stalled");
  await attached.stalled;

  const started = await starter.cli.result;

  expect(started.exitCode).toBe(0);
  expect(attached.cli.child.exitCode).toBeNull();
  const rehearsed = await attached.cli.result;
  expect(rehearsed.stderr).toBe("");
  expect(rehearsed.exitCode).toBe(0);
  expect(await serverRunning(dataDir)).toBe(false);
});

test("after a command killed outright, the next one drops its throwaway databases and stops the server", async () => {
  const { dir, dataDir } = await draftedProject();
  const marker = join(dir.root, "stalled");
  const killed = spawned(["rehearse"], dir.root, {
    TEST_STALL: "query",
    TEST_MARKER: marker,
  });
  await waitForFile(marker);
  killed.signal("SIGKILL");
  await killed.result;
  expect(await serverRunning(dataDir)).toBe(true);

  const status = await runCli(["status", "--target", "dev"], {
    cwd: dir.root,
  });

  expect(status.exitCode).toBe(0);
  expect(await serverRunning(dataDir)).toBe(false);
  expect(
    await onStoppedServer(
      dataDir,
      "select datname from pg_database where datname like 'super_deploy_rehearsal_%'",
    ),
  ).toEqual([]);
});
