// CLI seam for finalize's destructive acknowledgement and lock warnings:
// without a terminal it refuses unless --acknowledge-destructive is passed;
// warnings go to stderr.
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

const schemaFile = "data-model/desired-schema/schema.sql";
const customers =
  "create table customers (id bigint primary key, name text not null);\n";
const orders = "create table orders (id bigint primary key);\n";

/** Migration 1 creates customers and orders; the draft `next` changes the schema to `next`. */
async function draftedProject(next: string) {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { [schemaFile]: customers + orders },
  });
  for (const args of [["draft", "--name", "start"], ["finalize"]]) {
    expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
  }
  await dir.write(schemaFile, next);
  const drafted = await runCli(["draft", "--name", "next"], { cwd: dir.root });
  expect(drafted.exitCode).toBe(0);
  return dir;
}

describe("finalize with destructive statements", () => {
  test("refuses without --acknowledge-destructive and no terminal, exiting 1", async () => {
    const dir = await draftedProject(customers);

    const result = await runCli(["finalize"], { cwd: dir.root });

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toMatch(
      /^Error: Draft next drops structure or deletes data in 1 statement\. Finalize it anyway\? data-model\/draft\/schema-change\.sql:\d+: DROP TABLE public\.orders drops the table and every row in it\. Refused without a terminal: pass --acknowledge-destructive to finalize it anyway\n$/,
    );
    expect(dir.exists("data-model/draft")).toBe(true);
  });

  test("finalizes with --acknowledge-destructive and says the acknowledgement is recorded", async () => {
    const dir = await draftedProject(customers);

    const result = await runCli(["finalize", "--acknowledge-destructive"], {
      cwd: dir.root,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: [
        "Finalized migration 00002-next in data-model/migrations/00002-next",
        "Recorded the acknowledgement of 1 destructive statement in its metadata.json",
        "",
      ].join("\n"),
      stderr: "",
    });
  });
});

describe.skipIf(process.platform === "win32")("in a terminal", () => {
  test("asks yes/no listing the statements; yes finalizes", async () => {
    const dir = await draftedProject(customers);
    const terminal = spawnTerminal(["finalize"], { cwd: dir.root });

    await terminal.waitFor("Finalize it anyway?");
    await terminal.waitFor(
      /data-model\/draft\/schema-change\.sql:\d+: DROP TABLE public\.orders/,
    );
    terminal.type("y");
    terminal.type(keys.enter);

    await terminal.waitFor("Finalized migration 00002-next");
    expect(await terminal.exited).toBe(0);
  });

  test("Enter (no) changes nothing and exits 0", async () => {
    const dir = await draftedProject(customers);
    const terminal = spawnTerminal(["finalize"], { cwd: dir.root });

    await terminal.waitFor("Finalize it anyway?");
    terminal.type(keys.enter);

    await terminal.waitFor("Nothing changed");
    expect(await terminal.exited).toBe(0);
    expect(dir.exists("data-model/draft")).toBe(true);
  });
});

describe("lock warnings", () => {
  test("rehearse and finalize print them on stderr", async () => {
    const dir = await draftedProject(
      `${customers + orders}create index customers_name_idx on customers (name);\n`,
    );

    const rehearsed = await runCli(["rehearse"], { cwd: dir.root });
    const finalized = await runCli(["finalize"], { cwd: dir.root });

    const warning = (folder: string) =>
      new RegExp(
        `^warning: ${folder}/schema-change\\.sql:\\d+: CREATE INDEX customers_name_idx reads every row of customers, holding a SHARE lock that blocks writes to it until the deployment commits\n$`,
      );
    expect(rehearsed.exitCode).toBe(0);
    expect(rehearsed.stderr).toMatch(warning("data-model/draft"));
    expect(finalized).toMatchObject({
      exitCode: 0,
      stdout:
        "Finalized migration 00002-next in data-model/migrations/00002-next\n",
    });
    expect(finalized.stderr).toMatch(
      warning("data-model/migrations/00002-next"),
    );
  });
});
