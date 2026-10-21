// CLI seam for Recoveries: the `recovery` command (Recover section of the
// menu, asking for a migration), and how finalize, validate, unfinalize,
// status and deploy report Recoveries.
import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { deployConfig, targetDatabaseName } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import {
  createTestProject,
  embeddedConfig,
  type TestProject,
} from "../support/project.ts";
import { keys, spawnTerminal } from "../support/terminal.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const schema = "data-model/desired-schema/customers.sql";

/** Migrations 1 (customers) and 2 (email required), finalized with the CLI. */
async function twoMigrations(): Promise<TestProject> {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: {
      [schema]: "create table customers (id bigint primary key, email text);\n",
    },
  });
  const cli = (args: string[]) => runCli(args, { cwd: dir.root });
  expect((await cli(["draft", "--name", "add customers"])).exitCode).toBe(0);
  expect((await cli(["finalize"])).exitCode).toBe(0);
  await dir.write(
    schema,
    "create table customers (id bigint primary key, email text not null);\n",
  );
  expect((await cli(["draft", "--name", "require email"])).exitCode).toBe(0);
  expect((await cli(["finalize"])).exitCode).toBe(0);
  return dir;
}

test("recovery, rehearse, finalize, validate and unfinalize report Recoveries", async () => {
  const dir = await twoMigrations();
  const cli = (args: string[]) => runCli(args, { cwd: dir.root });
  const recovery1 =
    "data-model/migrations/00002-require-email/recoveries/recovery-1";

  expect(await cli(["recovery"])).toMatchObject({ exitCode: 2 });
  expect(await cli(["recovery", "--migration", "00002"])).toEqual({
    exitCode: 0,
    stdout:
      "Created a Recovery draft of migration 00002-require-email in data-model/draft (it becomes Recovery 1 when finalized)\n",
    stderr: "",
  });
  expect(await cli(["recovery", "--migration", "1"])).toEqual({
    exitCode: 1,
    stdout: "",
    stderr:
      "Error: Cannot start a Recovery of migration 1 while draft require-email exists: finalize it or run discard-draft first\n",
  });
  expect(await cli(["draft"])).toMatchObject({ exitCode: 1 });

  await dir.write(
    "data-model/draft/pre-migration.sql",
    "update customers set email = 'unknown@example.com' where email is null;\n",
  );
  expect(await cli(["rehearse"])).toMatchObject({
    exitCode: 0,
    stdout:
      "Rehearsed the Recovery draft of migration 00002-require-email: it ends in the same structure as the original\n",
  });
  expect(await cli(["finalize"])).toMatchObject({
    exitCode: 0,
    stdout: `Finalized Recovery 1 of migration 00002-require-email in ${recovery1}\n`,
  });
  expect(await cli(["validate", "--strict"])).toEqual({
    exitCode: 0,
    stdout: "Validated 2 migrations and 1 Recovery\n",
    stderr: "",
  });
  expect(await cli(["unfinalize", "--recovery-of", "2"])).toMatchObject({
    exitCode: 0,
    stdout:
      "Moved Recovery 1 of migration 00002-require-email back into a Recovery draft in data-model/draft\n",
  });
  expect(dir.exists(recovery1)).toBe(false);
});

test("status and deploy show the migrations that run as a Recovery", async () => {
  const dir = await createTestProject({
    config: deployConfig(server, {
      otherTargets: `qa: { adapter: postgres.target(${JSON.stringify(targetDatabaseName())}) },`,
    }).config,
    files: {
      [schema]: "create table customers (id bigint primary key, email text);\n",
    },
  });
  const cli = (args: string[]) => runCli(args, { cwd: dir.root });
  for (const args of [
    ["draft", "--name", "add customers"],
    ["finalize"],
    ["deploy", "--target", "dev"],
  ]) {
    expect((await cli(args)).exitCode).toBe(0);
  }
  await dir.write(
    schema,
    "create table customers (id bigint primary key, email text not null);\n",
  );
  for (const args of [
    ["draft", "--name", "require email"],
    ["finalize"],
    ["recovery", "--migration", "2"],
  ]) {
    expect((await cli(args)).exitCode).toBe(0);
  }
  await dir.write(
    "data-model/draft/pre-migration.sql",
    "update customers set email = 'unknown@example.com' where email is null;\n",
  );
  expect((await cli(["finalize"])).exitCode).toBe(0);

  expect((await cli(["status", "--target", "dev"])).stdout).toContain(
    "Pending:\n  00002-require-email (Recovery 1)\n",
  );
  expect(await cli(["deploy", "--target", "dev"])).toMatchObject({
    exitCode: 0,
    stdout: "Deployed 1 migration to dev: 00002-require-email (Recovery 1)\n",
  });
  // qa runs both in one deployment: the original of 1, Recovery 1 of 2.
  expect((await cli(["status", "--target", "qa"])).stdout).toContain(
    "Pending:\n  00001-add-customers\n  00002-require-email (Recovery 1)\n",
  );
  expect(await cli(["deploy", "--target", "qa"])).toMatchObject({
    exitCode: 0,
    stdout:
      "Deployed 2 migrations to qa: 00001-add-customers, 00002-require-email (Recovery 1)\n",
  });

  const user = userInfo().username;
  const dev = await cli(["status", "--target", "dev"]);
  expect(dev.stdout).toMatch(
    new RegExp(
      `\n  #2 deploy succeeded migration 2 \\(Recovery 1\\) by ${user} at \\S+Z\n  #1 deploy succeeded migration 1 by ${user} at \\S+Z\n$`,
    ),
  );
  const qa = await cli(["status", "--target", "qa"]);
  expect(qa.stdout).toMatch(
    new RegExp(
      `\n  #1 deploy succeeded migrations 1-2 \\(migration 2 as Recovery 1\\) by ${user} at \\S+Z\n$`,
    ),
  );
});

describe.skipIf(process.platform === "win32")("menu", () => {
  test("the Recover section has recovery, which asks for a migration, newest first", async () => {
    const dir = await twoMigrations();
    const terminal = spawnTerminal([], { cwd: dir.root });

    const menu = await terminal.waitFor("quit");
    expect(menu).toMatch(/Recover\s*\n.*recovery/);
    await terminal.chooseMenuItem("recovery");
    const question = await terminal.waitFor("00001-add-customers");
    // Shown before 00001-add-customers, the first one offered.
    expect(question).toContain("00002-require-email");
    terminal.type(keys.enter);

    await terminal.waitFor(
      "Created a Recovery draft of migration 00002-require-email",
    );
    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
    expect(JSON.parse(await dir.read("data-model/draft/draft.json"))).toEqual({
      name: "require-email",
      recoveryOf: 2,
    });
  });
});
