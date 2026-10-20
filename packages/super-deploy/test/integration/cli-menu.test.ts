// The interactive menu at the CLI process seam, in a real pseudo-terminal.
// Skipped on Windows: ConPTY's key and Ctrl+C handling is unverified there.
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { waitForFile } from "../support/cli.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import {
  createTestProject,
  embeddedConfig,
  stallingConfig,
} from "../support/project.ts";
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

describe.skipIf(process.platform === "win32")("menu", () => {
  test("no arguments in a terminal opens the menu; it asks for each option, runs the command and returns to it", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    const menu = await terminal.waitFor("quit");
    expect(menu).toMatch(/Author\s*\n.*draft/);
    terminal.type(keys.enter);
    await terminal.waitFor("Name");
    terminal.type("Add customers");
    // The normalised name is previewed as it is typed.
    await terminal.waitFor("add-customers");
    terminal.type(keys.enter);

    await terminal.waitFor(
      "Created draft add-customers: 1 statement in data-model/draft/schema-change.sql",
    );
    expect(await dir.read("data-model/draft/schema-change.sql")).toContain(
      "CREATE TABLE",
    );
    // Back at the menu, on the command just run: Enter runs draft again.
    await terminal.waitFor("quit");
    terminal.type(keys.enter);
    await terminal.waitFor("Name");
    terminal.type(keys.enter);
    await terminal.waitFor("Regenerated draft add-customers");

    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
  });

  test("a failure prints and returns to the menu; quit leaves", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/customers.sql":
          "create table t (a moneyamount);\n",
      },
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    terminal.type(keys.enter);
    await terminal.waitFor("Name");
    terminal.type(`add customers${keys.enter}`);

    await terminal.waitFor(
      /Error: data-model\/desired-schema\/customers\.sql:1: .*moneyamount/,
    );
    await terminal.waitFor("quit");
    // The menu starts on draft; Up passes init and wraps round to quit.
    terminal.type(`${keys.up}${keys.up}${keys.enter}`);
    expect(await terminal.exited).toBe(0);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("cancelling a question runs nothing and returns to the menu; Ctrl+C there leaves", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    terminal.type(keys.enter);
    await terminal.waitFor("Name");
    terminal.type("add customers");
    terminal.type(keys.escape);
    await terminal.waitFor("Cancelled: nothing ran");

    await terminal.waitFor("quit");
    terminal.type(keys.ctrlC);
    expect(await terminal.exited).toBe(0);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("Ctrl+C while a command runs cleans up, prints one notice and exits 130", async () => {
    const dir = await createTestProject({
      config: stallingConfig(JSON.stringify(server.dataDir)),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const marker = dir.path("stalled");
    const terminal = spawnTerminal([], {
      cwd: dir.root,
      env: { TEST_STALL: "query", TEST_MARKER: marker },
    });

    await terminal.waitFor("quit");
    terminal.type(keys.enter);
    await terminal.waitFor("Name");
    terminal.type(`add customers${keys.enter}`);
    await waitForFile(marker);
    terminal.type(keys.ctrlC);

    expect(await terminal.exited).toBe(130);
    const after = terminal.screen.slice(terminal.screen.indexOf("^C"));
    expect(after.match(/Interrupted by SIGINT/g)).toHaveLength(1);
    expect(after).not.toContain("Error");
    expect(after).not.toContain("What do you want to do?");
    const leftovers = (await server.databases()).filter((name) =>
      name.startsWith("super_deploy_rehearsal_"),
    );
    expect(leftovers).toEqual([]);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("without a project the menu starts on init, which needs none; inside the new project init adopts a target", async () => {
    const dir = await createTestProject();
    await rm(dir.path("package.json"));
    const terminal = spawnTerminal([], { cwd: dir.root });

    expect(await terminal.waitFor("quit")).toMatch(/Start\s*\n.*init/);
    terminal.type(keys.enter);
    await terminal.waitFor("Initialised a super-deploy project in .");
    expect(dir.exists("super-deploy.config.ts")).toBe(true);

    // Back on init: inside the project now, it adopts a target, so it asks
    // which one (Escape cancels).
    await terminal.waitFor("quit");
    terminal.type(keys.enter);
    await terminal.waitFor("turn this target's managed schema");
    await terminal.waitFor("dev");
    terminal.type(keys.escape);
    await terminal.waitFor("Cancelled: nothing ran");
    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
  });
});
