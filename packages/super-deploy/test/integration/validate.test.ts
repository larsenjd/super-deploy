import { chmod, rename, stat } from "node:fs/promises";
import {
  draft,
  finalize,
  loadProject,
  ValidationFailedError,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";

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

  test("fails when a finalized file's content was edited", async () => {
    const { project, tamper } = await finalizedProject();
    await tamper(`${folder}/schema-change.sql`, (text) =>
      text.replace("NOT NULL", "NULL"),
    );

    const error = await validationError(project);

    expect(error.problems).toEqual([
      {
        severity: "error",
        code: "content-hash-mismatch",
        message: `${folder} was changed after it was finalized (its content hash does not match data-model/migrations/index.json)`,
        path: folder,
      },
    ]);
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
    expect(error.message).toContain("1 warning (--strict)");
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
