// API seam: grants, default privileges, policies and row-level security on a
// target are set up outside super-deploy (ADR-0006). Nothing compares,
// generates, revokes or resets them: they are never drift, and deployments
// leave them as they are. The desired schema can't declare them.
import { deploy, draft, SqlRuleViolationError, status } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  deployProject,
  finalizeMigration,
  roleName,
  testSession,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

/** Runs `sql` on the target as `role`; resolves to its rows or the error message. */
async function asRole(
  database: string,
  role: string,
  sql: string,
): Promise<unknown> {
  const session = await testSession(server, database);
  try {
    await session.execute(`set role ${role}`);
    return (await session.query(sql)).rows;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await session.close();
  }
}

describe("privileges on a target", () => {
  test("grants, default privileges for the deploy role, a policy and row-level security made by hand are not drift, and the next deploy keeps them", async () => {
    const reader = roleName("app_reader");
    await server.query(`create role ${reader} nologin`);
    const { project, dir, database } = await deployProject(server, {
      "reports.sql":
        "create table reports (id bigint primary key, title text);\n",
    });
    await finalizeMigration(project, "add reports");
    await deploy(project, { target: "dev" });
    // As the embedded target's login, which is its deploy role.
    await server.query(
      `grant usage on schema public to ${reader};
       grant select on reports to ${reader};
       alter default privileges in schema public grant select on tables to ${reader};
       alter table reports enable row level security;
       create policy reports_read on reports for select to ${reader} using (true);
       insert into reports (id, title) values (1, 'Q1');`,
      [],
      database,
    );

    expect((await status(project, { target: "dev" })).drift).toEqual([]);

    await dir.write(
      "data-model/desired-schema/notes.sql",
      "create table notes (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add notes");
    await deploy(project, { target: "dev" });

    expect(await asRole(database, reader, "select id from notes")).toEqual([]);
    expect(
      await asRole(database, reader, "select id, title from reports"),
    ).toEqual([{ id: "1", title: "Q1" }]);
    expect(
      await server.query(
        "select relrowsecurity from pg_class where relname = 'reports'",
        [],
        database,
      ),
    ).toEqual([{ relrowsecurity: true }]);
    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });
});

describe("the desired schema", () => {
  test("can't declare grants, revokes, policies, row-level security or SECURITY DEFINER: draft refuses each, writing no draft", async () => {
    const { project, dir } = await deployProject(server, {
      "reports.sql": `create table reports (id bigint primary key, title text);
grant select on reports to app_reader;
revoke usage on schema public from public;
alter table reports enable row level security;
create policy reports_read on reports for select using (true);
create function report_count() returns bigint language sql security definer
  as $$ select count(*) from reports $$;
`,
    });

    const refusal = await draft(project, { name: "add reports" }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(SqlRuleViolationError);
    const { violations } = refusal as SqlRuleViolationError;
    expect(violations.map(({ line, rule }) => ({ line, rule }))).toEqual(
      [2, 3, 4, 5, 6].map((line) => ({ line, rule: "unsupported-object" })),
    );
    for (const { message } of violations) {
      expect(message).toContain("set up on targets outside super-deploy");
    }
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});
