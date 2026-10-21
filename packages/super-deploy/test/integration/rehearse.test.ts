import {
  draft,
  finalize,
  InvalidDraftError,
  loadProject,
  NoDraftError,
  RehearsalMismatchError,
  rehearse,
  SqlFileFailedError,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { finalizeMigration } from "../support/deploy.ts";
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

async function draftedProject(desiredSchema = customers) {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": desiredSchema },
  });
  const project = await loadProject({ cwd: dir.root });
  await draft(project, { name: "Add customers" });
  return { dir, project };
}

describe("rehearse", () => {
  test("replays the draft on a throwaway database and proves it matches the desired schema", async () => {
    const { project } = await draftedProject();
    const before = await server.databases();

    const result = await rehearse(project);

    expect(result).toMatchObject({
      name: "add-customers",
      migrationsReplayed: 0,
      serverVersion: expect.stringMatching(/^18\./),
    });
    expect(await server.databases()).toEqual(before);
  });

  test("fails when the desired schema changed after the draft was generated", async () => {
    const { dir, project } = await draftedProject();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace(
        "name text not null",
        "name text not null,\n  email text",
      ),
    );
    const before = await server.databases();

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    const { differences, subject } = error as RehearsalMismatchError;
    expect(subject).toBe(
      "The rehearsal does not match the desired schema; run draft again",
    );
    expect(differences).toContain(
      'pg-delta: ALTER TABLE "public"."customers" ADD COLUMN "email" text;',
    );
    expect(differences).toContainEqual(
      expect.stringMatching(/^catalog: \+ column: customers\.email text /),
    );
    expect(await server.databases()).toEqual(before);
  });

  test("a mismatch re-drafting can't fix says the scripts or seed data cause it, not run draft again", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });
    await finalizeMigration(project, "Add customers");
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace("name text", "full_name text"),
    );
    // The README's rename, without the NOT NULL constraint's rename.
    await dir.write(
      "data-model/draft/pre-migration.sql",
      "alter table customers rename column name to full_name;\n",
    );
    await draft(project, { name: "Rename name" });

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as RehearsalMismatchError).subject).toBe(
      "The rehearsal does not match the desired schema, and running draft again won't change that: the desired schema hasn't changed since draft, so the pre-migration script, post-migration script or seed data cause the difference (a column renamed in the pre-migration script needs its NOT NULL constraint renamed too: see the README, \"Renaming a column\")",
    );
  });

  test("a mismatch after a hand edit of the schema change says it was edited by hand", async () => {
    const { dir, project } = await draftedProject();
    const file = "data-model/draft/schema-change.sql";
    await dir.write(
      file,
      `${await dir.read(file)}\ncreate index customers_name_idx on public.customers (name);\n`,
    );

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as RehearsalMismatchError).subject).toBe(
      "The rehearsal does not match the desired schema: data-model/draft/schema-change.sql was edited by hand since draft generated it, and the edited schema change doesn't produce the desired schema (run draft again to regenerate it)",
    );
  });

  test("a draft written before the schema-change hash existed counts as not edited by hand", async () => {
    const { dir, project } = await draftedProject();
    const metadata = "data-model/draft/draft.json";
    const { schemaChangeHash: _, ...older } = JSON.parse(
      await dir.read(metadata),
    );
    await dir.write(metadata, JSON.stringify(older));
    const file = "data-model/draft/schema-change.sql";
    await dir.write(
      file,
      `${await dir.read(file)}\ncreate index customers_name_idx on public.customers (name);\n`,
    );

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as RehearsalMismatchError).subject).toContain(
      "the pre-migration script, post-migration script or seed data cause the difference",
    );
  });

  test("our own catalog comparison catches what pg-delta misses: a named NOT NULL constraint", async () => {
    // pg-delta 1.0.0-alpha.59 ignores PG18 NOT NULL constraint names, so its
    // schema change creates customers_name_not_null and its re-diff is empty.
    const { project } = await draftedProject(
      customers.replace(
        "name text not null",
        "name text constraint customers_name_required not null",
      ),
    );

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as RehearsalMismatchError).differences).toEqual([
      "catalog: - constraint: customers customers_name_not_null n NOT NULL name deferrable=false deferred=false validated=true",
      "catalog: + constraint: customers customers_name_required n NOT NULL name deferrable=false deferred=false validated=true",
    ]);
  });

  test("our own catalog comparison catches what pg-delta misses: reordered composite type attributes", async () => {
    // pg-delta 1.0.0-alpha.59 doesn't diff attribute order, so the swap
    // generates nothing and its re-diff is empty.
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/size.sql":
          "create type size as (width integer, height integer);\n",
      },
    });
    const project = await loadProject({ cwd: dir.root });
    await finalizeMigration(project, "Add size");
    await dir.write(
      "data-model/desired-schema/size.sql",
      "create type size as (height integer, width integer);\n",
    );
    await draft(project, { name: "Swap size" });

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as RehearsalMismatchError).differences).toEqual([
      expect.stringMatching(/^catalog: - column: size\.height .* position=2$/),
      expect.stringMatching(/^catalog: - column: size\.width .* position=1$/),
      expect.stringMatching(/^catalog: \+ column: size\.height .* position=1$/),
      expect.stringMatching(/^catalog: \+ column: size\.width .* position=2$/),
    ]);
  });

  test("a comment on a domain-typed column passes, though pg-delta adds the column last", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/types.sql":
          "create domain email_address as text constraint email_address_check check (value like '%@%');\n",
        "data-model/desired-schema/customers.sql": `create table customers (
  id bigint primary key,
  email email_address not null,
  name text not null
);
comment on column customers.email is 'Login e-mail';
`,
      },
    });
    const project = await loadProject({ cwd: dir.root });
    await draft(project, { name: "Add customers" });

    await expect(rehearse(project)).resolves.toMatchObject({
      name: "add-customers",
    });
  });

  test("a comment on a column that a later migration moves to another position rehearses and finalizes", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/t.sql": `create table t (id bigint primary key, b text);
comment on column t.b is 'bee';
`,
      },
    });
    const project = await loadProject({ cwd: dir.root });
    await finalizeMigration(project, "Add t");
    await dir.write(
      "data-model/desired-schema/t.sql",
      `create table t (id bigint primary key, a text, b text);
comment on column t.b is 'bee';
`,
    );
    await draft(project, { name: "Add a" });

    await expect(finalize(project)).resolves.toMatchObject({ name: "add-a" });
  });

  test("a changed column comment is a difference, naming the column", async () => {
    const { dir, project } = await draftedProject(
      `${customers}comment on column customers.name is 'Full name';\n`,
    );
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}comment on column customers.name is 'Display name';\n`,
    );

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as RehearsalMismatchError).differences).toEqual(
      expect.arrayContaining([
        "catalog: - comment: pg_class customers.name Full name",
        "catalog: + comment: pg_class customers.name Display name",
      ]),
    );
  });

  test("names the file and line PostgreSQL refused while replaying, and rolls back", async () => {
    const { dir, project } = await draftedProject();
    const file = "data-model/draft/schema-change.sql";
    await dir.write(
      file,
      `${await dir.read(file)}\nCREATE VIEW "public"."names" AS\n  SELECT nmae FROM "public"."customers";\n`,
    );
    const before = await server.databases();

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect(error).toMatchObject({ file, line: 7 });
    expect((error as SqlFileFailedError).postgresMessage).toContain(
      'column "nmae" does not exist',
    );
    expect(await server.databases()).toEqual(before);
  });

  test("needs a draft", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/desired-schema/customers.sql": customers },
    });
    const project = await loadProject({ cwd: dir.root });

    await expect(rehearse(project)).rejects.toBeInstanceOf(NoDraftError);
  });

  test("refuses a draft.json it can't read, naming the file", async () => {
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: { "data-model/draft/draft.json": "{" },
    });
    const project = await loadProject({ cwd: dir.root });

    const error = await rehearse(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidDraftError);
    expect(error).toMatchObject({
      code: "invalid-draft",
      file: "data-model/draft/draft.json",
    });
  });
});

describe("finalize after a failed rehearsal", () => {
  test("writes nothing and keeps the draft", async () => {
    const { dir, project } = await draftedProject();
    const schemaChange = await dir.read("data-model/draft/schema-change.sql");
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers.replace("name text not null", "name text"),
    );

    await expect(finalize(project)).rejects.toBeInstanceOf(
      RehearsalMismatchError,
    );

    expect(dir.exists("data-model/migrations")).toBe(false);
    expect(await dir.read("data-model/draft/schema-change.sql")).toBe(
      schemaChange,
    );
  });
});
