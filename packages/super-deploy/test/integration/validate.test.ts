import { createHash } from "node:crypto";
import { chmod, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  draft,
  finalize,
  loadProject,
  ValidationFailedError,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import {
  createTestProject,
  embeddedConfig,
  type TestProject,
} from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers = `create table customers (
  id bigint primary key,
  name text not null
);
`;
const folder = "data-model/migrations/00001-add-customers";

/** A project with migration 00001-add-customers finalized and no draft. */
async function finalizedProject() {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const project = await loadProject({ cwd: dir.root });
  await draft(project, { name: "Add customers" });
  await finalize(project);
  /** Rewrites a finalized file the way someone bypassing read-only would. */
  const tamper = async (relative: string, edit: (text: string) => string) => {
    await chmod(dir.path(relative), 0o644);
    await dir.write(relative, edit(await dir.read(relative)));
  };
  return { dir, project, tamper };
}

/**
 * Rewrites index.json so migration `name`, the first, matches its folder's
 * files again, by the hash format documented in src/store/hashing.ts.
 */
async function rehashMigration(dir: TestProject, name: string) {
  const sha256 = (text: string) =>
    createHash("sha256").update(text, "utf8").digest("hex");
  const migration = dir.path(`data-model/migrations/${name}`);
  const files = (
    await readdir(migration, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(migration, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .sort();
  let manifest = `super-deploy migration 1\nfolder ${JSON.stringify(name)}\n`;
  for (const file of files) {
    const text = await readFile(join(migration, file), "utf8");
    manifest += `file ${JSON.stringify(file)} ${sha256(text)}\n`;
  }
  const contentHash = sha256(manifest);
  const indexPath = "data-model/migrations/index.json";
  const index = JSON.parse(await dir.read(indexPath));
  index.migrations[0] = {
    ...index.migrations[0],
    contentHash,
    chainHash: sha256(contentHash),
  };
  await dir.write(indexPath, JSON.stringify(index));
}

async function validationError(
  ...args: Parameters<typeof validate>
): Promise<ValidationFailedError> {
  const error = await validate(...args).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ValidationFailedError);
  return error as ValidationFailedError;
}

describe("validate", () => {
  test("passes a freshly finalized project with nothing to report", async () => {
    const { project } = await finalizedProject();

    const report = await validate(project, { strict: true });

    expect(report).toEqual({
      migrations: 1,
      recoveries: 0,
      problems: [],
      readOnlyRestored: [],
      overrides: [],
    });
  });

  const changedAfterFinalizing = {
    severity: "error",
    code: "content-hash-mismatch",
    message: `${folder} was changed after it was finalized (its content hash does not match data-model/migrations/index.json): restore it from Git (\`git checkout HEAD -- ${folder}\`, and delete any file added to it), then run validate, which makes it read-only again. To change what a finalized migration does, finalize a new migration, or a Recovery for the targets where it failed`,
    path: folder,
  };

  test("fails when a finalized file's content was edited, saying how to restore it", async () => {
    const { project, tamper } = await finalizedProject();
    await tamper(`${folder}/schema-change.sql`, (text) =>
      text.replace("NOT NULL", "NULL"),
    );

    const error = await validationError(project);

    expect(error.problems).toEqual([changedAfterFinalizing]);
  });

  test("fails the same way when a file was added to a finalized migration or its desired-schema snapshot was edited", async () => {
    const added = await finalizedProject();
    await chmod(added.dir.path(folder), 0o755);
    await added.dir.write(`${folder}/notes.txt`, "why we did this\n");
    const edited = await finalizedProject();
    await edited.tamper(
      `${folder}/desired-schema/customers.sql`,
      (text) => `${text}-- edited\n`,
    );

    for (const { project } of [added, edited]) {
      const error = await validationError(project);
      expect(error.problems).toEqual([changedAfterFinalizing]);
    }
  });

  test("a change only in line endings passes", async () => {
    const { project, tamper } = await finalizedProject();
    for (const file of [
      "schema-change.sql",
      "metadata.json",
      "desired-schema/customers.sql",
    ]) {
      await tamper(`${folder}/${file}`, (text) =>
        text.replaceAll("\n", "\r\n"),
      );
    }

    await expect(validate(project, { strict: true })).resolves.toMatchObject({
      problems: [],
    });
  });

  test("fails when a migration folder was renamed", async () => {
    const { dir, project } = await finalizedProject();
    await rename(
      dir.path(folder),
      dir.path("data-model/migrations/00001-create-customers"),
    );

    const error = await validationError(project);

    expect(error.problems).toEqual([
      {
        severity: "error",
        code: "migration-renamed",
        message:
          "Migration 1 was renamed from 00001-add-customers to 00001-create-customers; finalized migrations never change",
        path: "data-model/migrations/00001-create-customers",
      },
    ]);
  });

  test("fails when the index's hash chain was edited", async () => {
    const { dir, project } = await finalizedProject();
    const index = JSON.parse(
      await dir.read("data-model/migrations/index.json"),
    );
    index.migrations[0].chainHash = "0".repeat(64);
    await dir.write("data-model/migrations/index.json", JSON.stringify(index));

    const error = await validationError(project);

    expect(error.problems).toMatchObject([
      { severity: "error", code: "chain-hash-mismatch" },
    ]);
  });

  test("fails when a migration has no schema-change.sql, even with its index entry rehashed to match", async () => {
    const { dir, project } = await finalizedProject();
    await chmod(dir.path(folder), 0o755);
    await rm(dir.path(`${folder}/schema-change.sql`));
    await rehashMigration(dir, "00001-add-customers");

    const error = await validationError(project);

    expect(error.problems).toEqual([
      {
        severity: "error",
        code: "schema-change-missing",
        message: `${folder} has no schema-change.sql; every migration has one, as finalize writes it`,
        path: folder,
      },
    ]);
  });

  test("fails when a finalized file gained a byte-order mark", async () => {
    const { project, tamper } = await finalizedProject();
    await tamper(`${folder}/schema-change.sql`, (text) => `\uFEFF${text}`);

    const error = await validationError(project);

    expect(error.problems).toMatchObject([
      {
        severity: "error",
        code: "invalid-encoding",
        path: `${folder}/schema-change.sql`,
      },
    ]);
  });

  test("makes writable finalized files read-only again (git does not store read-only state)", async () => {
    const { dir, project } = await finalizedProject();
    await chmod(dir.path(`${folder}/schema-change.sql`), 0o644);

    const report = await validate(project, { strict: true });

    expect(report.readOnlyRestored).toEqual([`${folder}/schema-change.sql`]);
    const { mode } = await stat(dir.path(`${folder}/schema-change.sql`));
    expect(mode & 0o222).toBe(0);
  });
});

describe("validate warnings", () => {
  const unfinalized = {
    severity: "warning",
    code: "unfinalized-draft",
    message: "Draft add-email is not finalized yet",
    path: "data-model/draft",
  };

  test("warn about an unfinalized draft; --strict turns that into a failure", async () => {
    const { project } = await finalizedProject();
    await draft(project, { name: "add email" });

    await expect(validate(project)).resolves.toMatchObject({
      problems: [unfinalized],
    });
    const error = await validationError(project, { strict: true });
    expect(error.problems).toEqual([unfinalized]);
    expect(error.message).toContain("1 warning (--strict fails on warnings)");
  });

  test("warn about desired-schema changes made after the draft was generated", async () => {
    const { dir, project } = await finalizedProject();
    await draft(project, { name: "add email" });
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  email text",
      ),
    );

    await expect(validate(project)).resolves.toMatchObject({
      problems: [
        unfinalized,
        {
          severity: "warning",
          code: "undrafted-changes",
          message:
            "The desired schema has changed since draft add-email was generated; run draft again",
          path: "data-model/desired-schema",
        },
      ],
    });
  });

  test("allowDraft lists a draft in progress as warnings without failing --strict", async () => {
    const { dir, project } = await finalizedProject();
    await draft(project, { name: "add email" });
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );

    const report = await validate(project, { strict: true, allowDraft: true });

    expect(report.problems).toEqual([
      unfinalized,
      expect.objectContaining({
        severity: "warning",
        code: "undrafted-changes",
      }),
    ]);
  });

  test("allowDraft lets only the work-in-progress warnings through: an edited migration still fails", async () => {
    const { project, tamper } = await finalizedProject();
    await draft(project, { name: "add email" });
    await tamper(`${folder}/schema-change.sql`, (text) => `${text}-- edited\n`);

    const error = await validationError(project, {
      strict: true,
      allowDraft: true,
    });

    expect(error.problems.map((problem) => problem.code)).toEqual([
      "content-hash-mismatch",
      "unfinalized-draft",
    ]);
  });

  test("warn about a file in the draft folder that isn't a draft's; --strict fails on it even with allowDraft", async () => {
    const { dir, project } = await finalizedProject();
    await draft(project, { name: "add email" });
    await dir.write(
      "data-model/draft/post-migrate.sql",
      "update customers set name = lower(name);\n",
    );
    const unknown = {
      severity: "warning",
      code: "unknown-draft-file",
      message:
        "data-model/draft/post-migrate.sql is not one of a draft's files, so it will not run (a draft holds draft.json, seed-data.sql, pre-migration.sql, schema-change.sql, schema-change.generated.sql and post-migration.sql)",
      path: "data-model/draft/post-migrate.sql",
    };

    const report = await validate(project);
    const error = await validationError(project, {
      strict: true,
      allowDraft: true,
    });

    expect(report.problems).toEqual([unfinalized, unknown]);
    expect(error.problems).toEqual([unfinalized, unknown]);
  });

  test("with allowDraft, the failure counts and leads with only what fails it, not the draft in progress", async () => {
    const { dir, project } = await finalizedProject();
    await draft(project, { name: "add email" });
    await dir.write("data-model/draft/post-migrate.sql", "select 1;\n");

    const error = await validationError(project, {
      strict: true,
      allowDraft: true,
    });

    expect(error.message).toBe(
      "Validation failed with 1 warning (--strict fails on warnings): data-model/draft/post-migrate.sql is not one of a draft's files, so it will not run (a draft holds draft.json, seed-data.sql, pre-migration.sql, schema-change.sql, schema-change.generated.sql and post-migration.sql)",
    );
    expect(error.problems.map((problem) => problem.code)).toEqual([
      "unfinalized-draft",
      "unknown-draft-file",
    ]);
  });

  test("a file in the draft folder that isn't SQL is named without saying it won't run", async () => {
    const { dir, project } = await finalizedProject();
    await draft(project, { name: "add email" });
    await dir.write("data-model/draft/notes/NOTES.md", "Why the backfill\n");

    const report = await validate(project);

    expect(report.problems).toContainEqual({
      severity: "warning",
      code: "unknown-draft-file",
      message:
        "data-model/draft/notes/NOTES.md is not one of a draft's files (a draft holds draft.json, seed-data.sql, pre-migration.sql, schema-change.sql, schema-change.generated.sql and post-migration.sql)",
      path: "data-model/draft/notes/NOTES.md",
    });
  });

  test("warn about desired-schema changes when there is no draft", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );

    const error = await validationError(project, { strict: true });

    expect(error.problems).toEqual([
      {
        severity: "warning",
        code: "undrafted-changes",
        message:
          "The desired schema differs from migration 00001-add-customers's snapshot and no draft covers it; run draft",
        path: "data-model/desired-schema",
      },
    ]);
  });

  test("a new project's desired schema counts as undrafted until it is drafted", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });

    await expect(validate(project)).resolves.toMatchObject({
      migrations: 0,
      problems: [
        {
          code: "undrafted-changes",
          message:
            "The desired schema has no migration or draft yet; run draft",
        },
      ],
    });
  });

  test("warn about a routine body naming the managed schema's objects unqualified, in draft, finalize and validate; --strict fails on it", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server, 'managedSchema: "app",'),
      files: {
        "data-model/desired-schema/orders.sql": `create table orders (id bigint primary key, customer_id bigint not null);

create function order_count(cid bigint) returns bigint
language sql stable as $$ select count(*) from orders where customer_id = cid $$;
`,
      },
    });
    const project = await loadProject({ cwd: dir.root });
    const warning = {
      file: "data-model/desired-schema/orders.sql",
      line: 3,
      routine: "function order_count(int8)",
      names: ["orders"],
    };

    const drafted = await draft(project, { name: "orders" });
    const finalized = await finalize(project);
    const error = await validationError(project, {
      strict: true,
      allowDraft: true,
    });

    expect(drafted.unqualifiedNames).toEqual([
      expect.objectContaining(warning),
    ]);
    expect(finalized.unqualifiedNames).toEqual([
      expect.objectContaining(warning),
    ]);
    expect(error.problems).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "unqualified-routine-names",
        path: warning.file,
        line: warning.line,
        message: expect.stringMatching(
          /^data-model\/desired-schema\/orders\.sql:3: function order_count\(int8\) names orders without a schema/,
        ),
      }),
    ]);
    await expect(validate(project)).resolves.toMatchObject({
      problems: [{ code: "unqualified-routine-names" }],
    });
  });

  test("never touches a database", async () => {
    const dir = await createTestProject({
      config: `import { defineConfig } from "super-deploy";
export default defineConfig({
  postgresVersion: 18,
  rehearsal: { createDatabase() { throw new Error("validate must not create databases"); } },
});
`,
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });

    await expect(validate(project)).resolves.toMatchObject({ migrations: 0 });
  });
});

describe("validate notices", () => {
  test("list a migration whose schema change was edited by hand, which --strict doesn't fail on", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });
    await draft(project, { name: "Add customers" });
    const index = "create index customers_name_idx on customers (name);\n";
    const schemaChange = "data-model/draft/schema-change.sql";
    await dir.write(schemaChange, `${await dir.read(schemaChange)}${index}`);
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}${index}`,
    );
    await finalize(project);

    const report = await validate(project, { strict: true });

    expect(report.problems).toEqual([
      {
        severity: "notice",
        code: "hand-edited-schema-change",
        message: `Migration 00001-add-customers's schema change was edited by hand after draft generated it: ${folder}/HAND-EDITED.md shows the diff`,
        path: `${folder}/HAND-EDITED.md`,
      },
    ]);
  });
});
