// CLI seam for unfinalize, restore-schema and discard-draft: without a
// terminal they refuse unless --acknowledge-overwrite is passed.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";

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
        "Error: discard-draft would delete or overwrite data-model/draft; pass --acknowledge-overwrite to go ahead without a terminal\n",
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
  test("moves the newest migration back into the draft", async () => {
    const dir = await finalizedProject();

    const result = await runCli(["unfinalize"], { cwd: dir.root });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout:
        "Moved migration 00001-add-customers back into draft add-customers in data-model/draft\n",
      stderr: "",
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
