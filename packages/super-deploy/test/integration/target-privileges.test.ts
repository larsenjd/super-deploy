// API seam: grants, default privileges, policies and row-level security on a
// target are set up outside super-deploy (ADR-0006). Nothing compares,
// generates, revokes or resets them: they are never drift, and deployments
// leave them as they are.
import { deploy, draft, status } from "super-deploy";
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

describe("generated schema changes", () => {
  // A desired schema may still declare these until
  // .scratch/privileges-out-of-scope/issues/02 refuses them.
  test("never grant, revoke, set default privileges, create policies or change row-level security", async () => {
    const reader = roleName("app_reader");
    await server.query(`create role ${reader} nologin`);
    const { project, dir } = await deployProject(server, {
      "reports.sql": `create table reports (id bigint primary key, title text);
grant select on reports to ${reader};
revoke usage on schema public from public;
alter table reports enable row level security;
alter table reports force row level security;
create policy reports_read on reports for select to ${reader} using (true);
`,
    });

    await draft(project, { name: "add reports" });

    const schemaChange = await dir.read("data-model/draft/schema-change.sql");
    expect(schemaChange).toContain("CREATE TABLE");
    expect(schemaChange).not.toMatch(
      /GRANT|REVOKE|DEFAULT PRIVILEGES|POLICY|ROW LEVEL SECURITY/,
    );
  });
});
