// The override marker through draft, finalize and validate (API and CLI
// seams). The marker rules themselves are covered at the SQL-analysis seam.
import { draft, finalize, loadProject, validate } from "super-deploy";
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

const reason = "loads tables named by the caller";
const loaders = `create table staging (id bigint primary key, name text);

-- OVERRIDE SUPER-DEPLOY REFUSAL: ${reason}
create function load_staging(source text) returns void
language plpgsql as $$
begin
  execute format('insert into staging select * from %I', source);
end
$$;
`;
const desiredFile = "data-model/desired-schema/loaders.sql";
const schemaChange = "data-model/draft/schema-change.sql";

async function project() {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { [desiredFile]: loaders },
  });
  return { dir, project: await loadProject({ cwd: dir.root }) };
}

/** 1-based line of the first line of `text` that starts with `prefix`. */
function lineStarting(text: string, prefix: string): number {
  return text.split("\n").findIndex((line) => line.startsWith(prefix)) + 1;
}

describe("draft and finalize", () => {
  test("the desired schema's marker is carried into the schema change and listed in the metadata", async () => {
    const { dir, project: p } = await project();
    await draft(p, { name: "add loader" });

    const generated = await dir.read(schemaChange);
    const markerLine = lineStarting(
      generated,
      "-- OVERRIDE SUPER-DEPLOY REFUSAL:",
    );
    expect(generated.split("\n")[markerLine - 1]).toBe(
      `-- OVERRIDE SUPER-DEPLOY REFUSAL: ${reason}`,
    );
    expect(generated.split("\n")[markerLine]).toMatch(
      /^CREATE (OR REPLACE )?FUNCTION public\.load_staging/,
    );

    const result = await finalize(p);
    const overrides = [
      {
        file: "schema-change.sql",
        line: markerLine,
        object: "function load_staging(text)",
        rules: ["plpgsql-dynamic-sql"],
        reason,
      },
    ];
    expect(result.metadata.overrides).toEqual(overrides);
    const metadata = JSON.parse(
      await dir.read("data-model/migrations/00001-add-loader/metadata.json"),
    );
    expect(metadata.overrides).toEqual(overrides);
  });
});

describe("validate", () => {
  test("lists every override: finalized migrations, the desired schema and the draft", async () => {
    const { dir, project: p } = await project();
    await draft(p, { name: "add loader" });
    const markerLine = lineStarting(
      await dir.read(schemaChange),
      "-- OVERRIDE SUPER-DEPLOY REFUSAL:",
    );
    const before = await validate(p);
    expect(before.overrides).toEqual([
      {
        file: desiredFile,
        line: 3,
        object: "function load_staging(text)",
        rules: ["plpgsql-dynamic-sql"],
        reason,
      },
      {
        file: schemaChange,
        line: markerLine,
        object: "function load_staging(text)",
        rules: ["plpgsql-dynamic-sql"],
        reason,
      },
    ]);

    await finalize(p);
    const after = await validate(p);
    expect(after.overrides.map((o) => `${o.file}:${o.line}`)).toEqual([
      `data-model/migrations/00001-add-loader/schema-change.sql:${markerLine}`,
      `${desiredFile}:3`,
    ]);
  });
});

describe("pre- and post-migration scripts", () => {
  test("a marker in the draft's post-migration script is accepted and listed by finalize and validate", async () => {
    const scriptReason = "move the sequence past imported ids";
    const dir = await createTestProject({
      config: embeddedConfig(server),
      files: {
        "data-model/desired-schema/counters.sql": `create table orders (id bigint generated always as identity primary key);

create table counters (name text primary key, value bigint);
`,
      },
    });
    const p = await loadProject({ cwd: dir.root });
    await draft(p, { name: "add counters" });
    await dir.write(
      "data-model/draft/post-migration.sql",
      `insert into counters (name, value) values ('orders', 0);
-- OVERRIDE SUPER-DEPLOY REFUSAL: ${scriptReason}
update counters set value = setval('orders_id_seq', 1000) where name = 'orders';
`,
    );
    const override = {
      line: 2,
      object: "UPDATE counters",
      rules: ["denylisted-call"],
      reason: scriptReason,
    };

    expect((await validate(p)).overrides).toEqual([
      { file: "data-model/draft/post-migration.sql", ...override },
    ]);

    const result = await finalize(p);
    expect(result.metadata.overrides).toEqual([
      { file: "post-migration.sql", ...override },
    ]);
    const migration = "data-model/migrations/00001-add-counters";
    expect(
      JSON.parse(await dir.read(`${migration}/metadata.json`)).overrides,
    ).toEqual([{ file: "post-migration.sql", ...override }]);

    expect((await validate(p)).overrides).toEqual([
      { file: `${migration}/post-migration.sql`, ...override },
    ]);
  });
});

describe("CLI", () => {
  test("finalize and validate print every override on stdout", async () => {
    const { dir } = await project();
    expect(
      (await runCli(["draft", "--name", "add loader"], { cwd: dir.root }))
        .exitCode,
    ).toBe(0);
    const markerLine = lineStarting(
      await dir.read(schemaChange),
      "-- OVERRIDE SUPER-DEPLOY REFUSAL:",
    );
    const migration = "data-model/migrations/00001-add-loader";

    const finalized = await runCli(["finalize"], { cwd: dir.root });
    expect(finalized).toMatchObject({ exitCode: 0, stderr: "" });
    expect(finalized.stdout.trimEnd().split("\n")).toEqual([
      `Finalized migration 00001-add-loader in ${migration}`,
      `override: ${migration}/schema-change.sql:${markerLine}: function load_staging(text) [plpgsql-dynamic-sql]: ${reason}`,
    ]);

    const validated = await runCli(["validate"], { cwd: dir.root });
    expect(validated).toMatchObject({ exitCode: 0, stderr: "" });
    expect(validated.stdout.trimEnd().split("\n")).toEqual([
      `override: ${migration}/schema-change.sql:${markerLine}: function load_staging(text) [plpgsql-dynamic-sql]: ${reason}`,
      `override: ${desiredFile}:3: function load_staging(text) [plpgsql-dynamic-sql]: ${reason}`,
      "Validated 1 migration",
    ]);
  });
});
