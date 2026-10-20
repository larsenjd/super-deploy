// Desired-schema rules through the programmatic API: refusals stop draft
// before any database work, declared external schemas are honoured in
// PL/pgSQL bodies, and objects that bind at CREATE to an external schema fail
// in rehearsal with a hint.
import {
  DesiredSchemaLoadError,
  draft,
  finalize,
  loadProject,
  SqlRuleViolationError,
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

async function projectWith(files: Record<string, string>, settings = "") {
  const dir = await createTestProject({
    config: embeddedConfig(server, settings),
    files,
  });
  return { dir, project: await loadProject({ cwd: dir.root }) };
}

const external = 'externalSchemas: ["ext"],';

describe("desired-schema rules in draft", () => {
  test("refuse every violation with file, line, statement and rule, before creating any database", async () => {
    const { dir, project } = await projectWith({
      "data-model/desired-schema/types.sql":
        "create type mood as enum ('happy');\n",
      "data-model/desired-schema/tables.sql":
        "create table t (\n  id serial\n);\n\ncreate function f() returns int language plpgsql as $$\nbegin\n  execute 'select 1';\n  return 1;\nend $$;\n",
    });
    const before = await server.databases();

    const error = await draft(project, { name: "first" }).catch((e) => e);

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    const violations = (error as SqlRuleViolationError).violations;
    expect(violations.map((v) => [v.file, v.line, v.rule]).sort()).toEqual([
      ["data-model/desired-schema/tables.sql", 1, "unsupported-object"],
      ["data-model/desired-schema/tables.sql", 7, "plpgsql-dynamic-sql"],
      ["data-model/desired-schema/types.sql", 1, "unsupported-object"],
    ]);
    expect(await server.databases()).toEqual(before);
    expect(dir.exists("data-model/draft")).toBe(false);
  });

  test("PL/pgSQL bodies may read declared external schemas, which rehearsals don't contain", async () => {
    const { dir, project } = await projectWith(
      {
        "data-model/desired-schema/loader.sql": `create table t (id int constraint t_pkey primary key);

create function load_from_ext() returns bigint language plpgsql as $$
begin
  insert into t (id) select id from ext.source;
  return ext.row_count();
end $$;
`,
      },
      external,
    );

    await draft(project, { name: "loader" });
    await finalize(project);

    expect(
      dir.exists("data-model/migrations/00001-loader/schema-change.sql"),
    ).toBe(true);
  });

  test.each([
    ["view", "create view v as select id from ext.source;"],
    [
      "LANGUAGE sql body",
      "create function f() returns bigint language sql as $$ select count(*) from ext.source $$;",
    ],
    [
      "PL/pgSQL variable declaration",
      "create function f() returns int language plpgsql as $$\ndeclare r ext.source%rowtype;\nbegin return 1; end $$;",
    ],
  ])(
    "an external schema referenced by a %s fails in rehearsal with a hint",
    async (_name, sql) => {
      const { project } = await projectWith(
        {
          "data-model/desired-schema/a.sql": `create table t (id int constraint t_pkey primary key);\n\n${sql}\n`,
        },
        external,
      );

      const error = await draft(project, { name: "x" }).catch((e) => e);

      expect(error).toBeInstanceOf(DesiredSchemaLoadError);
      expect(error).toMatchObject({
        file: "data-model/desired-schema/a.sql",
        hint: expect.stringContaining('external schema "ext"'),
      });
      expect((error as Error).message).toMatch(
        /Hint: .*external schema "ext".*rehearsals don't contain.*Only PL\/pgSQL bodies/,
      );
    },
  );

  test("a materialized view calling a LANGUAGE sql function with unqualified names fails with a hint", async () => {
    const { project } = await projectWith({
      "data-model/desired-schema/a.sql": `create table t (id int constraint t_pkey primary key);
create function n() returns bigint language sql stable as $$ select count(*) from t $$;
create materialized view mv as select n() as n;
`,
    });

    const error = await draft(project, { name: "x" }).catch((e) => e);

    expect(error).toBeInstanceOf(DesiredSchemaLoadError);
    expect(error).toMatchObject({
      line: 3,
      hint: expect.stringContaining("must schema-qualify"),
    });
  });

  test("CREATE EXTENSION plpgsql is accepted and changes nothing", async () => {
    const { dir, project } = await projectWith({
      "data-model/desired-schema/a.sql":
        "create extension plpgsql;\ncreate extension if not exists plpgsql;\n",
    });

    const result = await draft(project, { name: "nothing" });
    await finalize(project);

    expect(result.statements).toEqual([]);
    expect(dir.exists("data-model/migrations/00001-nothing")).toBe(true);
  });
});
