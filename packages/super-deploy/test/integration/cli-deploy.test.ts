// CLI seam for deploy and status: output streams and exit codes.
import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { deployConfig } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

async function finalizedProject() {
  const dir = await createTestProject({
    config: deployConfig(server).config,
    files: {
      "data-model/desired-schema/customers.sql":
        "create table customers (id bigint primary key, name text not null);\n",
    },
  });
  for (const args of [["draft", "--name", "add customers"], ["finalize"]]) {
    expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
  }
  return dir;
}

describe("deploy and status", () => {
  test("status shows what is pending, deploy applies it, and status then shows the attempt", async () => {
    const dir = await finalizedProject();

    const before = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(before).toMatchObject({
      exitCode: 0,
      stdout:
        "Target dev: 0 migrations recorded, 1 pending\nPending:\n  00001-add-customers\n",
      stderr: "",
    });

    const deployed = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(deployed).toMatchObject({
      exitCode: 0,
      stdout: "Deployed 1 migration to dev: 00001-add-customers\n",
      stderr: "",
    });

    const again = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(again.stdout).toBe("Target dev is up to date: nothing to deploy\n");

    const after = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(after.exitCode).toBe(0);
    const user = userInfo().username;
    expect(after.stdout).toMatch(
      new RegExp(
        `^Target dev: 1 migration recorded, 0 pending\nRecent attempts:\n  #2 deploy succeeded by ${user} at \\S+Z\n  #1 deploy succeeded migration 1 by ${user} at \\S+Z\n$`,
      ),
    );
  });

  test("an unknown or missing --target is a usage error", async () => {
    const dir = await finalizedProject();

    const unknown = await runCli(["deploy", "--target", "prod"], {
      cwd: dir.root,
    });
    expect(unknown).toMatchObject({ exitCode: 2, stdout: "" });
    expect(unknown.stderr).toContain('Unknown target "prod"');

    const missing = await runCli(["status"], { cwd: dir.root });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("Missing required option --target");
  });
});
