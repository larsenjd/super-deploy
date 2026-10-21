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
      expect.stringMatching(
        /^catalog: from the desired schema: column: customers\.email text /,
      ),
      "Error: The rehearsal does not match the desired schema; run draft again (2 differences, listed above)",
    ]);
  });

  test("a rehearsal mismatch indents a multi-line difference's continuation lines", async () => {
    const dir = await draftedProject();
    await dir.write(
      "data-model/desired-schema/answer.sql",
      "create function answer() returns int language sql as 'select 42';\n",
    );

    const result = await runCli(["rehearse"], { cwd: dir.root });

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toContain(
      "catalog: from the desired schema: routine: CREATE OR REPLACE FUNCTION public.answer()",
    );
    expect(lines).toContain("   RETURNS integer");
    // Every line is a difference's label line, indented under one, or the Error line.
    for (const line of lines.slice(0, -1)) {
      expect(line).toMatch(/^(pg-delta: |catalog: | {2}\S| {3}\S)/);
    }
    expect(lines.at(-1)).toMatch(/^Error: .*listed above/);
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
      "Error: Validation failed with 1 warning (--strict fails on warnings), listed above",
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

  test("a hand-edited schema change: rehearse and finalize warn on stderr and exit 0, finalize says where it recorded it, validate --strict lists a notice and exits 0", async () => {
    const dir = await draftedProject();
    const index = "create index customers_name_idx on customers (name);\n";
    const schemaChange = "data-model/draft/schema-change.sql";
    await dir.write(schemaChange, `${await dir.read(schemaChange)}${index}`);
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}${index}`,
    );
    const warning =
      "warning: data-model/draft/schema-change.sql was edited by hand since draft generated it\n";
    const run = (...args: string[]) => runCli(args, { cwd: dir.root });

    const rehearsed = await run("rehearse");
    const finalized = await run("finalize");
    const validated = await run("validate", "--strict");

    for (const result of [rehearsed, finalized]) {
      expect(result).toMatchObject({ exitCode: 0, stderr: warning });
    }
    expect(finalized.stdout).toContain(
      "Recorded the hand edit in its metadata.json and HAND-EDITED.md\n",
    );
    expect(validated).toEqual({
      exitCode: 0,
      stdout: "Validated 1 migration\n",
      stderr:
        "notice: Migration 00001-add-customers's schema change was edited by hand after draft generated it: data-model/migrations/00001-add-customers/HAND-EDITED.md shows the diff\n",
    });
  });

  test("a misnamed script in the draft: draft, rehearse and finalize warn on stderr and exit 0; validate --strict --allow-draft exits 1", async () => {
    const dir = await draftedProject();
    await dir.write("data-model/draft/post-migrate.sql", "select 1/0;\n");
    const warning =
      "warning: data-model/draft/post-migrate.sql is not one of a draft's files, so it will not run (a draft holds draft.json, seed-data.sql, pre-migration.sql, schema-change.sql, schema-change.generated.sql and post-migration.sql)";
    const run = (...args: string[]) => runCli(args, { cwd: dir.root });

    const validated = await run("validate", "--strict", "--allow-draft");
    const drafted = await run("draft");
    const rehearsed = await run("rehearse");
    const finalized = await run("finalize");

    expect(validated.exitCode).toBe(1);
    expect(validated.stderr).toContain(`${warning}\n`);
    for (const result of [drafted, rehearsed, finalized]) {
      expect(result).toMatchObject({ exitCode: 0, stderr: `${warning}\n` });
    }
  });

  test("a misnamed script in a draft that then fails: draft, rehearse and finalize warn about it first", async () => {
    const dir = await draftedProject();
    await dir.write("data-model/draft/post-migrate.sql", "select 1;\n");
    // Runs before the schema change that creates customers.
    await dir.write(
      "data-model/draft/pre-migration.sql",
      "update customers set name = name;\n",
    );
    const warning =
      "warning: data-model/draft/post-migrate.sql is not one of a draft's files, so it will not run (a draft holds draft.json, seed-data.sql, pre-migration.sql, schema-change.sql, schema-change.generated.sql and post-migration.sql)";
    const run = (...args: string[]) => runCli(args, { cwd: dir.root });

    for (const command of ["draft", "rehearse", "finalize"]) {
      const result = await run(command);

      expect(result.exitCode).toBe(1);
      const lines = result.stderr.trimEnd().split("\n");
      expect(lines[0]).toBe(warning);
      expect(lines.at(-1)).toMatch(/^Error: .*"customers" does not exist/);
    }
  });

  test("a misnamed script in a destructive draft: finalize warns about it before asking for the acknowledgement", async () => {
    const dir = await draftedProject();
    expect((await runCli(["finalize"], { cwd: dir.root })).exitCode).toBe(0);
    await dir.write("data-model/desired-schema/customers.sql", "");
    expect(
      (await runCli(["draft", "--name", "drop customers"], { cwd: dir.root }))
        .exitCode,
    ).toBe(0);
    await dir.write("data-model/draft/post-migrate.sql", "select 1;\n");

    const result = await runCli(["finalize"], { cwd: dir.root });

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^warning: data-model\/draft\/post-migrate\.sql /);
    expect(lines.at(-1)).toContain("--acknowledge-destructive");
  });

  test("--help lists --allow-draft", async () => {
    const dir = await createTestProject();

    const result = await runCli(["validate", "--help"], { cwd: dir.root });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--allow-draft");
  });

  test("lists every error once, with the way back, and exits 1 when a finalized migration was edited", async () => {
    const dir = await draftedProject();
    expect((await runCli(["finalize"], { cwd: dir.root })).exitCode).toBe(0);
    const file = "data-model/migrations/00001-add-customers/schema-change.sql";
    await chmod(dir.path(file), 0o644);
    await dir.write(file, `${await dir.read(file)}-- edited\n`);

    const result = await runCli(["validate", "--strict"], { cwd: dir.root });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      expect.stringMatching(
        /^error: data-model\/migrations\/00001-add-customers was changed after it was finalized .*: restore it from Git \(`git checkout HEAD -- data-model\/migrations\/00001-add-customers`/,
      ),
      "Error: Validation failed with 1 error, listed above",
    ]);
  });
});
