import { existsSync } from "node:fs";
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

function oneLine(text: string): string[] {
  return text.trimEnd().split("\n");
}

describe("help", () => {
  test("--help lists the commands on stdout and exits 0", async () => {
    const dir = await createTestProject();

    const result = await runCli(["--help"], { cwd: dir.root });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: super-deploy <command> [options]");
    expect(result.stdout).toMatch(/Author:\n\s+draft\s/);
    expect(result.stderr).toBe("");
  });

  test("<command> --help describes the command's options and exits 0", async () => {
    const dir = await createTestProject();

    const result = await runCli(["draft", "--help"], { cwd: dir.root });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: super-deploy draft [options]");
    expect(result.stdout).toContain("--name <name>");
    expect(result.stderr).toBe("");
  });

  test("--version prints the version and exits 0", async () => {
    const dir = await createTestProject();

    const result = await runCli(["--version"], { cwd: dir.root });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "super-deploy 0.0.0\n",
      stderr: "",
    });
  });
});

describe("usage errors", () => {
  test("no arguments without a terminal prints usage to stderr and exits 2", async () => {
    const dir = await createTestProject();

    const result = await runCli([], { cwd: dir.root });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: super-deploy <command> [options]");
  });

  test.each([
    [["frobnicate"], 'Error: Unknown command "frobnicate"'],
    [["--bogus"], "Error: Unknown option --bogus"],
    [["draft", "--nmae", "x"], "Error: Unknown option --nmae for draft"],
    [["draft", "--name"], "Error: Option --name needs a value"],
    [
      ["draft", "--name", "a", "--name", "b"],
      "Error: Option --name was given more than once",
    ],
    [["draft", "extra"], 'Error: Unexpected argument "extra"'],
    [["draft", "--help=yes"], "Error: Option --help does not take a value"],
    [
      ["draft", "--name", "Add customers!"],
      'Error: Invalid draft name "Add customers!"',
    ],
  ])("%j exits 2 with a one-line error", async (args, message) => {
    const dir = await createTestProject();

    const result = await runCli(args, { cwd: dir.root });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(oneLine(result.stderr)).toHaveLength(1);
    expect(result.stderr.startsWith(message)).toBe(true);
  });

  test("run nothing", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });

    const result = await runCli(
      ["draft", "--name", "add customers", "--bogus"],
      { cwd: dir.root },
    );

    expect(result.exitCode).toBe(2);
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});

describe("draft", () => {
  test("creates the draft, prints the result on stdout and exits 0", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });

    const result = await runCli(["draft", "--name", "Add customers"], {
      cwd: dir.path("data-model"),
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // Paths are shown relative to the working directory (data-model/ here).
    expect(result.stdout).toBe(
      "Created draft add-customers: 1 statement in draft/schema-change.sql\n",
    );
    expect(await dir.read("data-model/draft/schema-change.sql")).toContain(
      "CREATE TABLE",
    );
  });

  test("a failure prints one Error line on stderr and exits 1", async () => {
    const dir = await createTestProject();

    const result = await runCli(["draft", "--name", "add customers"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(oneLine(result.stderr)).toEqual([
      expect.stringMatching(
        /^Error: No super-deploy\.config\.ts found in .+ or any parent directory$/,
      ),
    ]);
  });

  test("--debug adds the stack trace", async () => {
    const dir = await createTestProject();

    const result = await runCli(["draft", "--name", "x", "--debug"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(oneLine(result.stderr).length).toBeGreaterThan(1);
    expect(result.stderr).toContain("ProjectNotFoundError");
  });
});

describe("embedded-postgres adapter", () => {
  const ownServerConfig = `import { defineConfig } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: new URL(".super-deploy/postgres/", import.meta.url) });

export default defineConfig({
  postgresVersion: 18,
  rehearsal: postgres.rehearsal,
  targets: { dev: { adapter: postgres.target("dev") } },
});
`;

  test("starts its own server for a command and stops it afterwards", async () => {
    const dir = await createTestProject({
      config: ownServerConfig,
      files: { "data-model/desired-schema/customers.sql": customers },
    });

    const result = await runCli(["draft", "--name", "add customers"], {
      cwd: dir.root,
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(dir.exists(".super-deploy/postgres/PG_VERSION")).toBe(true);
    expect(existsSync(dir.path(".super-deploy/postgres/postmaster.pid"))).toBe(
      false,
    );
  });

  test("keeps exit code 1 when a command fails after starting the server", async () => {
    const dir = await createTestProject({
      config: ownServerConfig,
      files: {
        "data-model/desired-schema/customers.sql":
          "create table t (a moneyamount);\n",
      },
    });

    const result = await runCli(["draft", "--name", "add customers"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(oneLine(result.stderr)).toEqual([
      expect.stringContaining("data-model/desired-schema/customers.sql:1:"),
    ]);
    expect(existsSync(dir.path(".super-deploy/postgres/postmaster.pid"))).toBe(
      false,
    );
  });
});
