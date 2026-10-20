import {
  draft,
  finalize,
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
    const { differences } = error as RehearsalMismatchError;
    expect(differences).toContain(
      'pg-delta: ALTER TABLE "public"."customers" ADD COLUMN "email" text;',
    );
    expect(differences).toContainEqual(
      expect.stringMatching(/^catalog: \+ column: customers\.email text /),
    );
    expect(await server.databases()).toEqual(before);
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
    expect((error as SqlFileFailedError).detail).toContain(
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
