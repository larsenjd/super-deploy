// The interactive menu at the CLI process seam, in a real pseudo-terminal.
// Skipped on Windows: ConPTY's key and Ctrl+C handling is unverified there.
import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli, waitForFile } from "../support/cli.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import {
  createTestProject,
  embeddedConfig,
  stallingConfig,
} from "../support/project.ts";
import {
  keys,
  menuFooters,
  showCursor,
  spawnTerminal,
} from "../support/terminal.ts";

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
  test("no arguments in a terminal opens the menu at its sections; it asks for each option, runs the command and returns to it inside its section", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    const menu = await terminal.waitForMenu();
    // Each section is listed with the commands inside it.
    expect(menu).toMatch(/Author\s+.*draft/);
    expect(menu).not.toContain("Delete the draft");
    await terminal.chooseMenuItem("Author", "draft");
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
    // Back at the menu, inside Author on the command just run: Enter runs
    // draft again.
    await terminal.waitFor(menuFooters.section);
    terminal.type(keys.enter);
    await terminal.waitFor("Name");
    terminal.type(keys.enter);
    await terminal.waitFor("Regenerated draft add-customers");

    await terminal.waitForMenu();
    await terminal.chooseMenuItem("quit");
    expect(await terminal.exited).toBe(0);
  });

  test("Enter or Right opens a section, where its cursor was left; Backspace or Left go back to the sections; Escape leaves from a section", async () => {
    const dir = await createTestProject({ config: embeddedConfig(server) });
    const terminal = spawnTerminal([], { cwd: dir.root });

    // In a project the menu opens on Author.
    await terminal.waitFor(menuFooters.top);
    terminal.type(keys.right);
    const author = await terminal.waitFor(menuFooters.section);
    expect(author).toMatch(/Author\s*\n.*draft/);
    expect(author).toContain(
      "Delete the draft, leaving the desired schema alone",
    );
    terminal.type(keys.left);
    await terminal.waitFor(menuFooters.top);
    terminal.type(keys.enter);
    await terminal.waitFor(menuFooters.section);
    terminal.type(keys.backspace);
    await terminal.waitFor(menuFooters.top);
    terminal.type(keys.down);
    await terminal.waitFor(menuFooters.top);
    terminal.type(keys.enter);
    const deploy = await terminal.waitFor(menuFooters.section);
    expect(deploy).toMatch(/Deploy\s*\n.*deploy/);
    terminal.type(keys.down);
    await terminal.waitFor(menuFooters.section);
    terminal.type(keys.left);
    await terminal.waitFor(menuFooters.top);
    // A section reopens on the command its cursor was left on.
    terminal.type(keys.enter);
    expect(await terminal.waitFor(menuFooters.section)).toMatch(/● status/);
    terminal.type(keys.escape);
    await terminal.waitFor("Bye");
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

    await terminal.waitForMenu();
    await terminal.chooseMenuItem("Author", "draft");
    await terminal.waitFor("Name");
    terminal.type(`add customers${keys.enter}`);

    await terminal.waitFor(
      /Error: data-model\/desired-schema\/customers\.sql:1: .*moneyamount/,
    );
    await terminal.waitForMenu();
    await terminal.chooseMenuItem("quit");
    expect(await terminal.exited).toBe(0);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("validate asks whether to allow a draft in progress; yes passes --strict with a draft present", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const drafted = await runCli(["draft", "--name", "add customers"], {
      cwd: dir.root,
    });
    expect(drafted.exitCode).toBe(0);
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitForMenu();
    await terminal.chooseMenuItem("Author", "validate");
    // A yes/no question takes "y" as its answer, without Enter.
    await terminal.waitFor("Fail on warnings too");
    terminal.type("y");
    await terminal.waitFor("Allow a draft in progress?");
    terminal.type("y");

    await terminal.waitFor("Draft add-customers is not finalized yet");
    await terminal.waitFor("Validated 0 migrations");
    await terminal.waitForMenu();
    await terminal.chooseMenuItem("quit");
    expect(await terminal.exited).toBe(0);
  });

  test("cancelling a question runs nothing and returns to the menu; Ctrl+C there leaves", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitForMenu();
    await terminal.chooseMenuItem("Author", "draft");
    await terminal.waitFor("Name");
    terminal.type("add customers");
    terminal.type(keys.escape);
    await terminal.waitFor("Cancelled: nothing ran");

    await terminal.waitForMenu();
    terminal.type(keys.ctrlC);
    expect(await terminal.exited).toBe(0);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("Ctrl+D on an empty answer cancels a question and returns to the menu; Ctrl+D there leaves", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitForMenu();
    await terminal.chooseMenuItem("Author", "draft");
    await terminal.waitFor("Name");
    terminal.type(keys.ctrlD);
    await terminal.waitFor("Cancelled: nothing ran");

    await terminal.waitForMenu();
    const before = terminal.output.length;
    terminal.type(keys.ctrlD);
    await terminal.waitFor("Bye");
    expect(await terminal.exited).toBe(0);
    expect(terminal.output.slice(before)).toContain(showCursor);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("Ctrl+D at the sections leaves, showing the cursor again", async () => {
    const dir = await createTestProject({ config: embeddedConfig(server) });
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor(menuFooters.top);
    const before = terminal.output.length;
    terminal.type(keys.ctrlD);
    await terminal.waitFor("Bye");
    expect(await terminal.exited).toBe(0);
    expect(terminal.output.slice(before)).toContain(showCursor);
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

    await terminal.waitForMenu();
    await terminal.chooseMenuItem("Author", "draft");
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

  test("without a project the menu opens on Project, whose init needs none; inside the new project adopt asks which target", async () => {
    const dir = await createTestProject();
    await rm(dir.path("package.json"));
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor(menuFooters.top);
    terminal.type(keys.enter);
    const project = await terminal.waitFor(menuFooters.section);
    expect(project).toMatch(/Project\s*\n.*init[^\n]*\n.*adopt/);
    terminal.type(keys.enter);
    await terminal.waitFor("Initialised a super-deploy project in");
    expect(dir.exists("super-deploy.config.ts")).toBe(true);

    // Inside the project now, adopt asks which target in the option's menu
    // question rather than its --help text (Escape cancels).
    await terminal.waitForMenu();
    await terminal.chooseMenuItem("Project", "adopt");
    const question = await terminal.waitFor("dev");
    expect(question).toContain(
      "Adopt which target's existing database as migration 1?",
    );
    expect(question).not.toContain("The target to use");
    terminal.type(keys.escape);
    await terminal.waitFor("Cancelled: nothing ran");
    await terminal.waitForMenu();
    await terminal.chooseMenuItem("quit");
    expect(await terminal.exited).toBe(0);
  });
});
