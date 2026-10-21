// CLI seam for unfinalize, restore-schema and discard-draft: without a
// terminal they refuse unless --acknowledge-overwrite is passed, and
// unfinalize warns that a deployed migration must not change.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";
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
const customersFile = "data-model/desired-schema/customers.sql";

async function draftedProject() {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { [customersFile]: customers },
  });
  const drafted = await runCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
  });
  expect(drafted.exitCode).toBe(0);
  return dir;
}

async function finalizedProject() {
  const dir = await draftedProject();
  expect((await runCli(["finalize"], { cwd: dir.root })).exitCode).toBe(0);
  return dir;
}

describe("discard-draft", () => {
  test("refuses without --acknowledge-overwrite and no terminal, exiting 1", async () => {
    const dir = await draftedProject();

    const result = await runCli(["discard-draft"], { cwd: dir.root });

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr:
        "Error: Discard draft add-customers? Refused without a terminal: pass --acknowledge-overwrite to delete or overwrite data-model/draft\n",
    });
    expect(dir.exists("data-model/draft")).toBe(true);
  });

  test("discards the draft with --acknowledge-overwrite", async () => {
    const dir = await draftedProject();

    const result = await runCli(["discard-draft", "--acknowledge-overwrite"], {
      cwd: dir.path("data-model"),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "Discarded draft add-customers (draft)\n",
      stderr: "",
    });
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("in a terminal", () => {
  test("asks yes/no, default no: Enter changes nothing and exits 0", async () => {
    const dir = await draftedProject();
    const terminal = spawnTerminal(["discard-draft"], { cwd: dir.root });

    const question = await terminal.waitFor("Discard draft add-customers?");
    terminal.type(keys.enter);

    await terminal.waitFor("Nothing changed");
    expect(await terminal.exited).toBe(0);
    expect(question).not.toContain("Error");
    expect(dir.exists("data-model/draft")).toBe(true);
  });

  test("answering yes goes ahead, listing what is lost in the question", async () => {
    const dir = await finalizedProject();
    await dir.write("data-model/desired-schema/orders.sql", "-- new\n");
    const terminal = spawnTerminal(["restore-schema"], { cwd: dir.root });

    await terminal.waitFor("discarding 1 changed file?");
    await terminal.waitFor("data-model/desired-schema/orders.sql");
    terminal.type("y");
    terminal.type(keys.enter);

    await terminal.waitFor("Deleted data-model/desired-schema/orders.sql");
    expect(await terminal.exited).toBe(0);
    expect(dir.exists("data-model/desired-schema/orders.sql")).toBe(false);
  });
});

describe("restore-schema", () => {
  test("lists the restored files with --acknowledge-overwrite", async () => {
    const dir = await finalizedProject();
    await dir.write(customersFile, "-- edited\n");
    await dir.write("data-model/desired-schema/orders.sql", "-- new\n");

    const result = await runCli(["restore-schema", "--acknowledge-overwrite"], {
      cwd: dir.root,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: [
        "Reset the desired schema to migration 00001-add-customers's snapshot",
        `Restored ${customersFile}`,
        "Deleted data-model/desired-schema/orders.sql",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("needs no flag when there is nothing to discard", async () => {
    const dir = await finalizedProject();

    const result = await runCli(["restore-schema"], { cwd: dir.root });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout:
        "The desired schema already matches migration 00001-add-customers's snapshot\n",
    });
  });
});

describe("unfinalize", () => {
  test("moves the newest migration back into the draft, warning not to change it if it was deployed", async () => {
    const dir = await finalizedProject();

    const result = await runCli(["unfinalize"], { cwd: dir.root });

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "Moved migration 00001-add-customers back into draft add-customers in data-model/draft\n",
      stderr:
        "warning: If migration 00001-add-customers was deployed anywhere, don't change it: finalize it again unchanged to put it back, then make the change in a new migration (or in a Recovery, if it failed on a target)\n",
    });
  });

  test("refuses without --acknowledge-overwrite when it would discard desired-schema edits", async () => {
    const dir = await finalizedProject();
    await dir.write("data-model/desired-schema/orders.sql", "-- new\n");

    const result = await runCli(["unfinalize"], { cwd: dir.root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--acknowledge-overwrite");
    expect(dir.exists("data-model/migrations/00001-add-customers")).toBe(true);
  });
});
