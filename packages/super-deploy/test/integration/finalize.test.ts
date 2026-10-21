import { chmod, readdir, readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  DraftChangedError,
  discardDraft,
  draft,
  finalize,
  InvalidEncodingError,
  loadProject,
  MigrationIntegrityError,
  rehearse,
  SuperDeployError,
  validate,
} from "super-deploy";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
} from "vitest";
import { deployProject } from "../support/deploy.ts";
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

async function draftedProject() {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": customers },
  });
  const project = await loadProject({ cwd: dir.root });
  await draft(project, { name: "Add customers" });
  return { dir, project };
}

/** Every file under `folder`, relative, with forward slashes, sorted. */
async function filesUnder(folder: string): Promise<string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(folder.length + 1)
        .split("\\")
        .join("/"),
    )
    .sort();
}

describe("finalize", () => {
  test("freezes the draft as migration 00001-add-customers with a desired-schema snapshot", async () => {
    const { dir, project } = await draftedProject();
    const schemaChange = await dir.read("data-model/draft/schema-change.sql");

    const result = await finalize(project);

    expect(result).toMatchObject({ number: 1, name: "add-customers" });
    const folder = "data-model/migrations/00001-add-customers";
    expect(result.path).toBe(dir.path(folder));
    expect(await filesUnder(dir.path(folder))).toEqual([
      "desired-schema/customers.sql",
      "metadata.json",
      "schema-change.sql",
    ]);
    expect(await dir.read(`${folder}/schema-change.sql`)).toBe(schemaChange);
    expect(await dir.read(`${folder}/desired-schema/customers.sql`)).toBe(
      customers,
    );
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("records tool, differ, parser and rehearsal server versions, and no timestamps or usernames", async () => {
    const { dir, project } = await draftedProject();

    const result = await finalize(project);

    const metadata = JSON.parse(
      await dir.read("data-model/migrations/00001-add-customers/metadata.json"),
    );
    expect(metadata).toEqual({
      tool: { name: "super-deploy", version: "0.0.0" },
      differ: {
        name: "@supabase/pg-delta",
        version: "1.0.0-alpha.59 (engine 0.3.0)",
      },
      parser: { name: "libpg-query", version: "18.1.5" },
      rehearsalServer: { version: expect.stringMatching(/^18\.\d+/) },
      overrides: [],
    });
    expect(result.metadata).toEqual(metadata);
    const username = userInfo().username;
    for (const file of await filesUnder(result.path)) {
      const text = await readFile(join(result.path, file), "utf8");
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toContain(username);
    }
  });

  test("makes every finalized file read-only", async () => {
    const { project } = await draftedProject();

    const result = await finalize(project);

    for (const file of await filesUnder(result.path)) {
      const { mode } = await stat(join(result.path, file));
      expect({ file, writable: (mode & 0o222) !== 0 }).toEqual({
        file,
        writable: false,
      });
    }
  });

  test("the next draft starts from the finalized migrations, and finalizes as 00002", async () => {
    const { dir, project } = await draftedProject();
    const first = await finalize(project);
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  email text",
      ),
    );

    const next = await draft(project, { name: "add email" });

    expect(next.statements.map((statement) => statement.sql)).toEqual([
      'ALTER TABLE "public"."customers" ADD COLUMN "email" text;',
    ]);
    const second = await finalize(project);
    expect(second).toMatchObject({ number: 2, name: "add-email" });
    expect(second.chainHash).not.toBe(first.chainHash);
    expect(
      JSON.parse(await dir.read("data-model/migrations/index.json")),
    ).toEqual({
      migrations: [
        {
          folder: "00001-add-customers",
          contentHash: first.contentHash,
          chainHash: first.chainHash,
        },
        {
          folder: "00002-add-email",
          contentHash: second.contentHash,
          chainHash: second.chainHash,
        },
      ],
    });
  });

  test("draft, rehearse and finalize refuse to build on an edited migration", async () => {
    const { dir, project } = await draftedProject();
    await finalize(project);
    await draft(project, { name: "next" });
    const schemaChange =
      "data-model/migrations/00001-add-customers/schema-change.sql";
    await chmod(dir.path(schemaChange), 0o644);
    await dir.write(schemaChange, `${await dir.read(schemaChange)}-- edited\n`);

    await expect(draft(project)).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
    await expect(rehearse(project)).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
    const error = await finalize(project).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationIntegrityError);
    expect((error as MigrationIntegrityError).problems).toMatchObject([
      { code: "content-hash-mismatch" },
    ]);
  });

  test("refuses a byte-order mark in a file it would freeze", async () => {
    const { dir, project } = await draftedProject();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `\uFEFF${customers}`,
    );

    const error = await finalize(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidEncodingError);
    expect(error).toMatchObject({
      file: "data-model/desired-schema/customers.sql",
    });
    expect(dir.exists("data-model/migrations")).toBe(false);
    expect(dir.exists("data-model/draft")).toBe(true);
  });
});

describe("a schema change edited by hand", () => {
  const index = "create index customers_name_idx on customers (name);\n";

  /** The report's case: an index appended to both the schema change and the desired schema. */
  async function editedByHand() {
    const { dir, project } = await draftedProject();
    const schemaChange = "data-model/draft/schema-change.sql";
    await dir.write(schemaChange, `${await dir.read(schemaChange)}${index}`);
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}${index}`,
    );
    return { dir, project };
  }

  test("finalizes with a warning, recording the edit in metadata.json and in HAND-EDITED.md with the diff", async () => {
    const { dir, project } = await editedByHand();

    const result = await finalize(project);

    expect(result.handEdited).toBe("data-model/draft/schema-change.sql");
    const folder = "data-model/migrations/00001-add-customers";
    expect(JSON.parse(await dir.read(`${folder}/metadata.json`))).toMatchObject(
      { schemaChangeEditedByHand: true },
    );
    expect(result.metadata.schemaChangeEditedByHand).toBe(true);
    expect(await dir.read(`${folder}/schema-change.sql`)).toContain(index);
    const report = await dir.read(`${folder}/HAND-EDITED.md`);
    expect(report).toContain(
      [
        "```diff",
        "--- schema-change.sql (generated by draft)",
        "+++ schema-change.sql (finalized)",
        "@@ -2,3 +2,4 @@",
        " -- desired schema (or the pre-migration script) and run draft again.",
        " ",
        ' CREATE TABLE "public"."customers" ("id" bigint NOT NULL, "name" text NOT NULL, CONSTRAINT "customers_pkey" PRIMARY KEY (id));',
        "+create index customers_name_idx on customers (name);",
        "```",
      ].join("\n"),
    );
    expect(await filesUnder(dir.path(folder))).toEqual([
      "HAND-EDITED.md",
      "desired-schema/customers.sql",
      "metadata.json",
      "schema-change.sql",
    ]);
  });

  test("running draft again regenerates the schema change, which finalizes as not edited", async () => {
    const { dir, project } = await editedByHand();
    await draft(project);

    const result = await finalize(project);

    expect(result.handEdited).toBeUndefined();
    expect(result.metadata).not.toHaveProperty("schemaChangeEditedByHand");
    expect(await filesUnder(result.path)).toEqual([
      "desired-schema/customers.sql",
      "metadata.json",
      "schema-change.sql",
    ]);
    expect(
      await dir.read(
        "data-model/migrations/00001-add-customers/schema-change.sql",
      ),
    ).toContain("CREATE INDEX customers_name_idx");
  });
});

describe("the draft changing while finalize runs", () => {
  /**
   * A project whose rehearsal adapter, before each throwaway database, awaits
   * `globalThis.duringFinalizeRehearsal`.
   */
  async function interruptibleProject() {
    const { dir, project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        rehearsal: `{
  async createDatabase(request) {
    await globalThis.duringFinalizeRehearsal?.();
    return postgres.rehearsal.createDatabase(request);
  },
}`,
      },
    );
    await draft(project, { name: "Add customers" });
    return { dir, project };
  }

  /** Runs `change` before the next throwaway database (or every one, with `{ every: true }`). */
  function duringRehearsal(
    change: () => Promise<unknown>,
    { every = false } = {},
  ): void {
    const hook = async () => {
      if (!every) {
        Object.assign(globalThis, { duringFinalizeRehearsal: undefined });
      }
      await change();
    };
    Object.assign(globalThis, { duringFinalizeRehearsal: hook });
    onTestFinished(() => {
      Object.assign(globalThis, { duringFinalizeRehearsal: undefined });
    });
  }

  /** What the migrations folder holds, sorted (none when it doesn't exist). */
  async function migrationsFolder(dir: TestProject): Promise<string[]> {
    return dir.exists("data-model/migrations")
      ? (await readdir(dir.path("data-model/migrations"))).sort()
      : [];
  }

  async function expectNothingFinalized(dir: TestProject) {
    expect(await migrationsFolder(dir)).toEqual([]);
  }

  test("refuses with DraftChangedError, writing nothing, when the draft is discarded during the rehearsal", async () => {
    const { dir, project } = await interruptibleProject();
    duringRehearsal(() =>
      discardDraft(project, { acknowledgeOverwrite: true }),
    );

    const error = await finalize(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DraftChangedError);
    expect(error).toMatchObject({ code: "draft-changed" });
    await expectNothingFinalized(dir);
  });

  test("refuses with DraftChangedError, writing nothing, when the schema change is edited during the rehearsal", async () => {
    const { dir, project } = await interruptibleProject();
    duringRehearsal(async () =>
      dir.write(
        "data-model/draft/schema-change.sql",
        `${await dir.read("data-model/draft/schema-change.sql")}\n-- edited\n`,
      ),
    );

    await expect(finalize(project)).rejects.toBeInstanceOf(DraftChangedError);
    await expectNothingFinalized(dir);
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(true);
  });

  test("of two finalize at once, one finalizes and the other refuses with a typed error, leaving no staging folder", async () => {
    const { dir, project } = await interruptibleProject();
    const other = await loadProject({ cwd: dir.root });
    onTestFinished(() => other.close());
    // Both rehearsals wait for each other, so both finalize the same draft.
    let arrived = 0;
    let bothArrived: () => void = () => {};
    const together = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const meet = async () => {
      arrived += 1;
      if (arrived === 2) {
        bothArrived();
      }
      await together;
    };
    duringRehearsal(meet, { every: true });
    const results = await Promise.allSettled([
      finalize(project),
      finalize(other),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.reason).toBeInstanceOf(SuperDeployError);
    expect(await migrationsFolder(dir)).toEqual([
      "00001-add-customers",
      "index.json",
    ]);
    await expect(validate(project, { strict: true })).resolves.toMatchObject({
      migrations: 1,
      problems: [],
    });
  });
});
