// Snapshots stored as diffs (ADR-0008), through the commands that write and
// read them: finalize writes desired-schema.diff, and unfinalize,
// restore-schema, validate and deploy get the developer's files and
// behaviour back across a history of several migrations.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  deploy,
  draft,
  finalize,
  restoreSchema,
  SnapshotDiffDoesNotApplyError,
  unfinalize,
  ValidationFailedError,
  validate,
} from "superdeploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  attemptLog,
  deployProject,
  finalizeMigration,
} from "../support/deploy.ts";
import { type Files, readFiles, writeFiles } from "../support/files.ts";
import { gitApply } from "../support/git-apply.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import {
  rehashMigration,
  type TestProject,
  tamperFinalized,
} from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const migrations = "data-model/migrations";
const desiredSchema = "data-model/desired-schema";

const marker =
  "-- OVERRIDE SUPER-DEPLOY REFUSAL: loads tables named by the caller";
const loadStaging = `${marker}
create function load_staging(source text) returns void
language plpgsql as $$
begin
  execute format('insert into staging select * from %I', source);
end
$$;
`;
const customers = `-- Everyone who has ever ordered.
create table customers (
  id bigint primary key,

  name text not null
);
`;

/**
 * The desired schema at each migration of the history, by path relative to
 * the desired-schema folder: comments, blank lines, an override marker,
 * nested folders and a file without a trailing newline.
 */
const stages: readonly {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly postMigration?: string;
  readonly destructive?: true;
}[] = [
  {
    name: "add customers",
    files: {
      "tables/customers.sql": customers,
      "loaders.sql": `create table staging (id bigint primary key, name text);\n\n${loadStaging}`,
      "tables/tags/tags.sql": "create table tags (id bigint primary key);",
    },
  },
  {
    // Edits a file, splits another into two in new folders, and edits the
    // file without a trailing newline, keeping it so.
    name: "split loaders",
    files: {
      "tables/customers.sql": customers.replace(
        "  name text not null\n",
        "  name text not null,\n  -- Where receipts go.\n  email text\n",
      ),
      "tables/staging.sql":
        "create table staging (id bigint primary key, name text);\n",
      "functions/loaders/load-staging.sql": loadStaging,
      "tables/tags/tags.sql":
        "create table tags (id bigint primary key, label text);",
    },
  },
  {
    // Changes only scripts.
    name: "backfill emails",
    files: {},
    postMigration:
      "update customers set email = 'unknown@example.com' where email is null;\n",
  },
  {
    // Deletes a file and the folders it leaves empty.
    name: "drop tags",
    files: {},
    destructive: true,
  },
];

/** The desired schema each migration was finalized with, in order. */
function desiredSchemas(): Record<string, string>[] {
  const schemas: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  for (const stage of stages) {
    current =
      stage.name === "drop tags"
        ? Object.fromEntries(
            Object.entries(current).filter(
              ([path]) => path !== "tables/tags/tags.sql",
            ),
          )
        : Object.keys(stage.files).length === 0
          ? current
          : { ...stage.files };
    schemas.push(current);
  }
  return schemas;
}

/** Replaces the desired-schema folder's contents with `files`. */
async function setDesiredSchema(
  root: string,
  files: Readonly<Record<string, string>>,
) {
  await rm(join(root, desiredSchema), { recursive: true, force: true });
  await writeFiles(join(root, desiredSchema), files);
}

/** A project with the four migrations of `stages` finalized, and its folders. */
async function history() {
  const { dir, project, database } = await deployProject(server, {});
  const folders: string[] = [];
  const schemas = desiredSchemas();
  for (const [index, stage] of stages.entries()) {
    await setDesiredSchema(dir.root, schemas[index] ?? {});
    await draft(project, { name: stage.name });
    if (stage.postMigration !== undefined) {
      await dir.write(
        "data-model/draft/post-migration.sql",
        stage.postMigration,
      );
    }
    const result = await finalize(project, {
      acknowledgeDestructive: stage.destructive === true,
    });
    folders.push(`${migrations}/${result.folder}`);
  }
  return { dir, project, database, folders, schemas };
}

const scrambled = { "other/junk.sql": "create table junk (id int);\n" };

/** The desired-schema files `command` gives back after they were replaced with `scrambled`. */
async function givenBack(
  root: string,
  command: () => Promise<unknown>,
): Promise<Files> {
  await setDesiredSchema(root, scrambled);
  await command();
  return readFiles(join(root, desiredSchema));
}

describe("a history of migrations stored as diffs", () => {
  test("each migration's diff, applied with git apply to the previous desired schema, gives its own; a migration that changes only scripts has an empty diff", async () => {
    const { dir, folders, schemas } = await history();

    expect(await dir.read(`${folders[2]}/desired-schema.diff`)).toBe("");
    for (const [index, folder] of folders.entries()) {
      const diff = await dir.read(`${folder}/desired-schema.diff`);
      expect({
        folder,
        files: await gitApply(schemas[index - 1] ?? {}, diff),
      }).toEqual({
        folder,
        files: schemas[index],
      });
    }
  });

  test("unfinalize gives back each migration's desired-schema files exactly, newest first", async () => {
    const { dir, project, schemas } = await history();

    for (let index = stages.length - 1; index >= 0; index--) {
      expect({
        index,
        files: await givenBack(dir.root, () =>
          unfinalize(project, { acknowledgeOverwrite: true }),
        ),
      }).toEqual({
        index,
        files: schemas[index],
      });
    }
    expect(await readdir(dir.path("data-model/draft"))).not.toContain(
      "desired-schema.diff",
    );
  });

  test("finalizing again after unfinalize recreates the identical migration, diff included", async () => {
    const { dir, project, folders } = await history();
    const index = await dir.read(`${migrations}/index.json`);
    const diffs = await Promise.all(
      [1, 3].map((n) => dir.read(`${folders[n]}/desired-schema.diff`)),
    );

    // The newest, which deletes a file; then the one that splits files.
    await unfinalize(project);
    await finalize(project, { acknowledgeDestructive: true });
    await unfinalize(project, { acknowledgeOverwrite: true });
    await unfinalize(project, { acknowledgeOverwrite: true });
    await unfinalize(project, { acknowledgeOverwrite: true });
    await finalize(project);
    await setDesiredSchema(dir.root, desiredSchemas()[2] ?? {});
    await draft(project, { name: "backfill emails" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      stages[2]?.postMigration ?? "",
    );
    await finalize(project);
    await setDesiredSchema(dir.root, desiredSchemas()[3] ?? {});
    await draft(project, { name: "drop tags" });
    await finalize(project, { acknowledgeDestructive: true });

    expect(await dir.read(`${migrations}/index.json`)).toBe(index);
    expect(
      await Promise.all(
        [1, 3].map((n) => dir.read(`${folders[n]}/desired-schema.diff`)),
      ),
    ).toEqual(diffs);
  });

  test("restore-schema resets the desired schema to exactly the newest snapshot", async () => {
    const { dir, project, schemas } = await history();

    expect(
      await givenBack(dir.root, () =>
        restoreSchema(project, { acknowledgeOverwrite: true }),
      ),
    ).toEqual(schemas[3]);
  });

  test("validate passes the history, and reports a desired schema that differs from the newest snapshot", async () => {
    const { dir, project, folders } = await history();

    await expect(validate(project, { strict: true })).resolves.toMatchObject({
      migrations: 4,
      problems: [],
    });

    await dir.write(`${desiredSchema}/tables/tags/tags.sql`, "-- back\n");
    const error = await validate(project, { strict: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).problems).toEqual([
      expect.objectContaining({
        code: "undrafted-changes",
        message: expect.stringContaining(
          `migration ${folders[3]?.split("/").at(-1)}'s snapshot`,
        ),
      }),
    ]);
  });

  test("a file with a carriage return before a CRLF line ending finalizes, comes back as the snapshot holds it, and finalizes again identically", async () => {
    const { dir, project } = await deployProject(server, {});
    await setDesiredSchema(dir.root, {
      "customers.sql": customers.replaceAll("\n", "\r\r\n"),
    });
    await draft(project, { name: "add customers" });
    const { folder } = await finalize(project);
    const index = await dir.read(`${migrations}/index.json`);
    const diff = await dir.read(`${migrations}/${folder}/desired-schema.diff`);

    expect(await gitApply({}, diff)).toEqual({ "customers.sql": customers });
    expect(
      await givenBack(dir.root, () =>
        unfinalize(project, { acknowledgeOverwrite: true }),
      ),
    ).toEqual({ "customers.sql": customers });
    await finalize(project);
    expect(await dir.read(`${migrations}/index.json`)).toBe(index);
    expect(await dir.read(`${migrations}/${folder}/desired-schema.diff`)).toBe(
      diff,
    );
    expect(
      await givenBack(dir.root, () =>
        restoreSchema(project, { acknowledgeOverwrite: true }),
      ),
    ).toEqual({ "customers.sql": customers });
  });

  test("a file ending in a carriage return keeps it in desired-schema.diff, byte for byte, though finalize writes its other files LF", async () => {
    const { dir, project } = await deployProject(server, {});
    const endingInCarriageReturn = `${customers.trimEnd()}\r`;
    await setDesiredSchema(dir.root, {
      "customers.sql": endingInCarriageReturn,
    });
    await draft(project, { name: "add customers" });
    const { folder } = await finalize(project);
    const diff = await dir.read(`${migrations}/${folder}/desired-schema.diff`);

    expect(diff).toContain("+);\r\n\\ No newline at end of file\n");
    expect(await gitApply({}, diff)).toEqual({
      "customers.sql": endingInCarriageReturn,
    });
  });

  test("deploy rehearses the history against the newest snapshot and deploys it", async () => {
    const { project } = await history();

    const result = await deploy(project, { target: "dev" });

    expect(result.deployed.map((migration) => migration.name)).toEqual([
      "add-customers",
      "split-loaders",
      "backfill-emails",
      "drop-tags",
    ]);
    await expect(validate(project, { strict: true })).resolves.toMatchObject({
      problems: [],
    });
  });
});

describe("a desired-schema diff that doesn't apply", () => {
  /**
   * Edits migration `folder`'s diff, the first, so it no longer applies
   * (customers.sql's section loses its `new file mode` line) and rehashes
   * index.json to match, so the integrity check passes it.
   */
  async function breakDiff(dir: TestProject, folder: string) {
    await tamperFinalized(
      dir,
      `${migrations}/${folder}/desired-schema.diff`,
      (text) => text.replace("new file mode 100644\n", ""),
    );
    await rehashMigration(dir, folder);
  }

  test("is refused, naming the migration and the file", async () => {
    const { dir, project } = await deployProject(server, {
      "customers.sql": customers,
    });
    const { folder } = await finalizeMigration(project, "add customers");
    await breakDiff(dir, folder);

    const error = await restoreSchema(project, {
      acknowledgeOverwrite: true,
    }).catch((e: unknown) => e);

    const migration = `${migrations}/${folder}`;
    const file = `${migration}/desired-schema.diff/customers.sql`;
    expect(error).toBeInstanceOf(SnapshotDiffDoesNotApplyError);
    expect(error).toMatchObject({
      code: "snapshot-diff-does-not-apply",
      migration,
      file,
      message: expect.stringContaining(migration),
    });
    expect((error as Error).message).toContain(file);
  });

  test("deploy refuses it before touching the target", async () => {
    const { dir, project, database } = await deployProject(server, {});
    await deploy(project, { target: "dev" });
    await setDesiredSchema(dir.root, { "customers.sql": customers });
    const { folder } = await finalizeMigration(project, "add customers");
    await breakDiff(dir, folder);

    await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
      SnapshotDiffDoesNotApplyError,
    );
    expect(await attemptLog(server, database)).toHaveLength(1);
  });
});
