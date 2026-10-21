// CLI seam for rehearse, finalize and validate: output streams and exit codes.
import { chmod } from "node:fs/promises";
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

async function draftedProject() {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const drafted = await runCli(["draft", "--name", "add customers"], {
    cwd: dir.root,
  });
  expect(drafted.exitCode).toBe(0);
  return dir;
}

describe("rehearse and finalize", () => {
  test("rehearse reports the match on stdout and exits 0", async () => {
    const dir = await draftedProject();

    const result = await runCli(["rehearse"], { cwd: dir.root });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout:
        "Rehearsed draft add-customers after 0 migrations: matches the desired schema\n",
      stderr: "",
    });
  });

  test("a rehearsal mismatch lists every difference, then a summary Error line, and exits 1", async () => {
    const dir = await draftedProject();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace("not null", "not null, email text"),
    );

    const result = await runCli(["rehearse"], { cwd: dir.root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      'pg-delta: ALTER TABLE "public"."customers" ADD COLUMN "email" text;',
      expect.stringMatching(/^catalog: \+ column: customers\.email text /),
      "Error: The rehearsal does not match the desired schema; run draft again (2 differences, listed above)",
    ]);
  });

  test("finalize prints the new migration's folder and exits 0", async () => {
    const dir = await draftedProject();

    const result = await runCli(["finalize"], { cwd: dir.path("data-model") });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout:
        "Finalized migration 00001-add-customers in migrations/00001-add-customers\n",
      stderr: "",
    });
  });
});

describe("validate", () => {
  test("warns about the draft on stderr and exits 0; --strict exits 1", async () => {
    const dir = await draftedProject();

    const relaxed = await runCli(["validate"], { cwd: dir.root });
    expect(relaxed.exitCode).toBe(0);
    expect(relaxed.stdout).toBe("Validated 0 migrations\n");
    expect(relaxed.stderr).toBe(
      "warning: Draft add-customers is not finalized yet\n",
    );

    const strict = await runCli(["validate", "--strict"], { cwd: dir.root });
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toBe("");
    expect(strict.stderr.trimEnd().split("\n")).toEqual([
      "warning: Draft add-customers is not finalized yet",
      "Error: Validation failed with 1 warning (--strict): Draft add-customers is not finalized yet",
    ]);
  });

  test("--strict --allow-draft warns about the draft on stderr and exits 0", async () => {
    const dir = await draftedProject();

    const result = await runCli(["validate", "--strict", "--allow-draft"], {
      cwd: dir.root,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "Validated 0 migrations\n",
      stderr: "warning: Draft add-customers is not finalized yet\n",
    });
  });

  test("--help lists --allow-draft", async () => {
    const dir = await createTestProject();

    const result = await runCli(["validate", "--help"], { cwd: dir.root });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--allow-draft");
  });

  test("lists every error and exits 1 when a finalized migration was edited", async () => {
    const dir = await draftedProject();
    expect((await runCli(["finalize"], { cwd: dir.root })).exitCode).toBe(0);
    const file = "data-model/migrations/00001-add-customers/schema-change.sql";
    await chmod(dir.path(file), 0o644);
    await dir.write(file, `${await dir.read(file)}-- edited\n`);

    const result = await runCli(["validate", "--strict"], { cwd: dir.root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      "error: data-model/migrations/00001-add-customers was changed after it was finalized (its content hash does not match data-model/migrations/index.json)",
      expect.stringMatching(/^Error: Validation failed with 1 error: /),
    ]);
  });
});
