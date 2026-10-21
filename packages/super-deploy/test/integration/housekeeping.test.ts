// unfinalize, restore-schema and discard-draft: undoing authoring mistakes,
// asking (through the confirm callback) before discarding work, and refusing
// without acknowledgeOverwrite when nothing can be asked.
import { chmod, readFile, rm, stat } from "node:fs/promises";
import {
  type Confirm,
  discardDraft,
  draft,
  finalize,
  loadProject,
  MigrationIntegrityError,
  NoDraftError,
  NoMigrationError,
  OverwriteNotAcknowledgedError,
  type Question,
  restoreSchema,
  unfinalize,
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
const customersFile = "data-model/desired-schema/customers.sql";

async function draftedProject() {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { [customersFile]: customers },
  });
  const project = await loadProject({ cwd: dir.root });
  await draft(project, { name: "Add customers" });
  return { dir, project };
}

/** A project with migration 00001-add-customers finalized and no draft. */
async function finalizedProject() {
  const { dir, project } = await draftedProject();
  await finalize(project);
  return { dir, project };
}

const orders = "create table orders (id bigint primary key);\n";

/** A confirm callback that records each question and gives `answer`. */
function answering(answer: boolean): Confirm & { questions: Question[] } {
  const questions: Question[] = [];
  const confirm = async (question: Question) => {
    questions.push(question);
    return answer;
  };
  return Object.assign(confirm, { questions });
}

describe("discard-draft", () => {
  test("deletes the draft and leaves the desired schema alone", async () => {
    const { dir, project } = await draftedProject();

    const result = await discardDraft(project, { acknowledgeOverwrite: true });

    expect(result).toEqual({
      name: "add-customers",
      path: dir.path("data-model/draft"),
    });
    expect(dir.exists("data-model/draft")).toBe(false);
    expect(await dir.read(customersFile)).toBe(customers);
  });

  test("refuses without acknowledgeOverwrite when nothing can ask, and keeps the draft", async () => {
    const { dir, project } = await draftedProject();

    const error = await discardDraft(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OverwriteNotAcknowledgedError);
    expect(error).toMatchObject({
      code: "overwrite-not-acknowledged",
      declined: false,
      question: { paths: ["data-model/draft"] },
    });
    expect((error as Error).message).toContain("--acknowledge-overwrite");
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(true);
  });

  test("asks yes/no first, and answering no changes nothing", async () => {
    const { dir, project } = await draftedProject();
    const confirm = answering(false);

    const error = await discardDraft(project, { confirm }).catch(
      (e: unknown) => e,
    );

    expect(confirm.questions).toEqual([
      {
        kind: "acknowledge-overwrite",
        command: "discard-draft",
        message: "Discard draft add-customers?",
        paths: ["data-model/draft"],
      },
    ]);
    expect(error).toBeInstanceOf(OverwriteNotAcknowledgedError);
    expect(error).toMatchObject({ declined: true });
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(true);
  });

  test("answering yes discards the draft", async () => {
    const { dir, project } = await draftedProject();

    await discardDraft(project, { confirm: answering(true) });

    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("fails with NoDraftError when there is no draft", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { [customersFile]: customers },
    });
    const project = await loadProject({ cwd: dir.root });

    await expect(
      discardDraft(project, { acknowledgeOverwrite: true }),
    ).rejects.toBeInstanceOf(NoDraftError);
  });
});

describe("restore-schema", () => {
  test("resets the desired schema to the newest snapshot and deletes the draft", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write(customersFile, `${customers}-- edited\n`);
    await dir.write("data-model/desired-schema/sales/orders.sql", orders);
    await dir.write("data-model/desired-schema/README.md", "notes\n");
    await draft(project, { name: "Add orders" });

    const result = await restoreSchema(project, { acknowledgeOverwrite: true });

    expect(result).toEqual({
      migration: "00001-add-customers",
      restored: [customersFile],
      deleted: ["data-model/desired-schema/sales/orders.sql"],
      discardedDraft: "add-orders",
    });
    expect(await dir.read(customersFile)).toBe(customers);
    expect(dir.exists("data-model/desired-schema/sales")).toBe(false);
    expect(await dir.read("data-model/desired-schema/README.md")).toBe(
      "notes\n",
    );
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("brings back a deleted desired-schema file", async () => {
    const { dir, project } = await finalizedProject();
    await rm(dir.path(customersFile));

    const result = await restoreSchema(project, { acknowledgeOverwrite: true });

    expect(result.restored).toEqual([customersFile]);
    expect(await dir.read(customersFile)).toBe(customers);
  });

  test("asks before discarding, listing the draft and every changed file", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await draft(project, { name: "Add orders" });
    const confirm = answering(false);

    const error = await restoreSchema(project, { confirm }).catch(
      (e: unknown) => e,
    );

    expect(confirm.questions).toEqual([
      {
        kind: "acknowledge-overwrite",
        command: "restore-schema",
        message:
          "Reset the desired schema to migration 00001-add-customers's snapshot, discarding draft add-orders and 1 changed file?",
        paths: ["data-model/draft", "data-model/desired-schema/orders.sql"],
      },
    ]);
    expect(error).toMatchObject({ declined: true });
    expect(dir.exists("data-model/desired-schema/orders.sql")).toBe(true);
    expect(dir.exists("data-model/draft")).toBe(true);
  });

  test("refuses without acknowledgeOverwrite when nothing can ask", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write(customersFile, `${customers}-- edited\n`);

    await expect(restoreSchema(project)).rejects.toBeInstanceOf(
      OverwriteNotAcknowledgedError,
    );
    expect(await dir.read(customersFile)).toBe(`${customers}-- edited\n`);
  });

  test("does not ask when there is nothing to discard, and counts line endings as unchanged", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write(customersFile, customers.replaceAll("\n", "\r\n"));
    const confirm = answering(false);

    const result = await restoreSchema(project, { confirm });

    expect(confirm.questions).toEqual([]);
    expect(result).toMatchObject({ restored: [], deleted: [] });
  });

  test("fails with NoMigrationError before the first migration", async () => {
    const { project } = await draftedProject();

    await expect(
      restoreSchema(project, { acknowledgeOverwrite: true }),
    ).rejects.toBeInstanceOf(NoMigrationError);
  });

  test("refuses to restore from migrations that fail their integrity check", async () => {
    const { dir, project } = await finalizedProject();
    const snapshot =
      "data-model/migrations/00001-add-customers/desired-schema/customers.sql";
    await chmod(dir.path(snapshot), 0o644);
    await dir.write(snapshot, orders);
    await dir.write(customersFile, `${customers}-- edited\n`);

    await expect(
      restoreSchema(project, { acknowledgeOverwrite: true }),
    ).rejects.toBeInstanceOf(MigrationIntegrityError);
    expect(await dir.read(customersFile)).toBe(`${customers}-- edited\n`);
  });
});

describe("unfinalize", () => {
  const folder = "data-model/migrations/00001-add-customers";

  test("moves the newest migration back into a writable draft and restores its snapshot", async () => {
    const { dir, project } = await finalizedProject();
    const schemaChange = await dir.read(`${folder}/schema-change.sql`);
    await rm(dir.path(customersFile));

    const warnings: { warning: string; moved: boolean }[] = [];

    const result = await unfinalize(project, {
      acknowledgeOverwrite: true,
      onWarning: (warning) =>
        warnings.push({ warning, moved: !dir.exists(folder) }),
    });

    expect(warnings).toEqual([
      {
        warning:
          "If migration 00001-add-customers was deployed anywhere, don't change it: finalize it again unchanged to put it back, then make the change in a new migration (or in a Recovery, if it failed on a target)",
        moved: false,
      },
    ]);
    expect(result).toEqual({
      number: 1,
      name: "add-customers",
      folder: "00001-add-customers",
      draftPath: dir.path("data-model/draft"),
      restored: [customersFile],
      deleted: [],
      discardedDraft: undefined,
    });
    expect(dir.exists(folder)).toBe(false);
    expect(
      JSON.parse(await dir.read("data-model/migrations/index.json")),
    ).toEqual({ migrations: [] });
    expect(await dir.read("data-model/draft/schema-change.sql")).toBe(
      schemaChange,
    );
    const mode = (await stat(dir.path("data-model/draft/schema-change.sql")))
      .mode;
    expect(mode & 0o200).not.toBe(0);
    expect(await dir.read(customersFile)).toBe(customers);
    // The draft is up to date with the restored desired schema.
    const report = await validate(project);
    expect(report.problems.map((p) => p.code)).toEqual(["unfinalized-draft"]);
  });

  test("finalizing again recreates the identical migration", async () => {
    const { dir, project } = await finalizedProject();
    const index = await dir.read("data-model/migrations/index.json");

    await unfinalize(project);
    await finalize(project);

    expect(await dir.read("data-model/migrations/index.json")).toBe(index);
  });

  test("finalizing again recreates a migration whose schema change was edited by hand", async () => {
    const tables = ["a", "b", "c", "d"]
      .map((name) => `create table ${name} (id bigint primary key);\n`)
      .join("");
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { [customersFile]: tables },
    });
    const project = await loadProject({ cwd: dir.root });
    await draft(project, { name: "Add tables" });
    // Two edits far apart, the second leaving no newline at the end.
    const file = "data-model/draft/schema-change.sql";
    const [first = "", ...rest] = (await dir.read(file)).split("\n");
    await dir.write(
      file,
      [first, "-- reviewed by hand", ...rest].join("\n") +
        "create index a_id_idx on a (id);",
    );
    await dir.write(
      customersFile,
      `${tables}create index a_id_idx on a (id);\n`,
    );
    const finalized = await finalize(project);
    expect(finalized.handEdited).toBe(file);
    const migration = "data-model/migrations/00001-add-tables";
    const index = await dir.read("data-model/migrations/index.json");
    const report = await dir.read(`${migration}/HAND-EDITED.md`);

    await unfinalize(project);
    expect(dir.exists("data-model/draft/HAND-EDITED.md")).toBe(false);
    await finalize(project);

    expect(await dir.read("data-model/migrations/index.json")).toBe(index);
    expect(await dir.read(`${migration}/HAND-EDITED.md`)).toBe(report);
  });

  test("only takes the newest migration, keeping earlier ones and their chain", async () => {
    const { dir, project } = await finalizedProject();
    const first = await dir.read("data-model/migrations/index.json");
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await draft(project, { name: "Add orders" });
    await finalize(project);

    const result = await unfinalize(project);

    expect(result).toMatchObject({ number: 2, name: "add-orders" });
    expect(await dir.read("data-model/migrations/index.json")).toBe(first);
    expect(dir.exists(folder)).toBe(true);
    expect(dir.exists("data-model/migrations/00002-add-orders")).toBe(false);
    expect(await dir.read("data-model/desired-schema/orders.sql")).toBe(orders);
    await expect(validate(project)).resolves.toMatchObject({ migrations: 1 });
  });

  test("asks before replacing a draft or desired-schema edits, and answering no changes nothing", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await draft(project, { name: "Add orders" });
    const draftBefore = await dir.read("data-model/draft/draft.json");
    const confirm = answering(false);

    const error = await unfinalize(project, { confirm }).catch(
      (e: unknown) => e,
    );

    expect(confirm.questions).toEqual([
      {
        kind: "acknowledge-overwrite",
        command: "unfinalize",
        message:
          "If migration 00001-add-customers was deployed anywhere, don't change it: finalize it again unchanged to put it back, then make the change in a new migration (or in a Recovery, if it failed on a target). Move migration 00001-add-customers back into the draft and restore its desired-schema snapshot, discarding draft add-orders and 1 changed file?",
        paths: ["data-model/draft", "data-model/desired-schema/orders.sql"],
      },
    ]);
    expect(error).toBeInstanceOf(OverwriteNotAcknowledgedError);
    expect(dir.exists(folder)).toBe(true);
    expect(await dir.read("data-model/draft/draft.json")).toBe(draftBefore);
    expect(dir.exists("data-model/desired-schema/orders.sql")).toBe(true);
  });

  test("refuses without acknowledgeOverwrite when it would discard edits and nothing can ask", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write(customersFile, `${customers}-- edited\n`);

    await expect(unfinalize(project)).rejects.toBeInstanceOf(
      OverwriteNotAcknowledgedError,
    );
    expect(dir.exists(folder)).toBe(true);
  });

  test("answering yes replaces the draft and the edits", async () => {
    const { dir, project } = await finalizedProject();
    await dir.write("data-model/desired-schema/orders.sql", orders);
    await draft(project, { name: "Add orders" });

    const result = await unfinalize(project, { confirm: answering(true) });

    expect(result).toMatchObject({
      deleted: ["data-model/desired-schema/orders.sql"],
      discardedDraft: "add-orders",
    });
    expect(
      JSON.parse(
        await readFile(dir.path("data-model/draft/draft.json"), "utf8"),
      ),
    ).toMatchObject({ name: "add-customers" });
  });

  test("fails with NoMigrationError when nothing is finalized", async () => {
    const { project } = await draftedProject();

    await expect(
      unfinalize(project, { acknowledgeOverwrite: true }),
    ).rejects.toBeInstanceOf(NoMigrationError);
  });

  test("refuses when the migrations fail their integrity check", async () => {
    const { dir, project } = await finalizedProject();
    await chmod(dir.path(`${folder}/schema-change.sql`), 0o644);
    await dir.write(`${folder}/schema-change.sql`, "-- tampered\n");

    await expect(
      unfinalize(project, { acknowledgeOverwrite: true }),
    ).rejects.toBeInstanceOf(MigrationIntegrityError);
    expect(dir.exists(folder)).toBe(true);
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});
