// API seam: the desired schema grants USAGE on the managed schema and revokes
// PostgreSQL's default PUBLIC privileges on the objects it defines (stories
// 98-99). They are generated, deployed, compared by every catalog check
// (drift included), and their grantees must exist on targets.
import { randomBytes } from "node:crypto";
import {
  DriftError,
  deploy,
  draft,
  finalize,
  PreflightFailedError,
  status,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  deployProject,
  finalizeMigration,
  targetDatabaseName,
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

/** A role name no other test uses (roles are server-wide). */
function roleName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

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

const inApp = 'managedSchema: "app",';

describe("managed-schema grants", () => {
  test("an app role reads a table in a named managed schema through the desired schema's grants alone", async () => {
    const reader = roleName("app_reader");
    await server.query(`create role ${reader} nologin`);
    const { project, dir, database } = await deployProject(
      server,
      {
        "reports.sql": `create table reports (id bigint primary key, title text);
grant usage on schema app to ${reader};
grant select on reports to ${reader};
`,
      },
      { settings: inApp },
    );

    await draft(project, { name: "add reports" });
    expect(await dir.read("data-model/draft/schema-change.sql")).toContain(
      `GRANT USAGE ON SCHEMA "app" TO "${reader}"`,
    );
    await finalize(project);
    await deploy(project, { target: "dev" });
    await server.query(
      "insert into app.reports (id, title) values (1, 'Q1')",
      [],
      database,
    );

    expect(
      await asRole(database, reader, "select id, title from app.reports"),
    ).toEqual([{ id: "1", title: "Q1" }]);
    expect((await status(project, { target: "dev" })).drift).toEqual([]);

    // Removing the schema grant takes the access away again.
    await dir.write(
      "data-model/desired-schema/reports.sql",
      `create table reports (id bigint primary key, title text);
grant select on reports to ${reader};
`,
    );
    await draft(project, { name: "no schema access" });
    expect(await dir.read("data-model/draft/schema-change.sql")).toContain(
      `REVOKE ALL ON SCHEMA "app" FROM "${reader}"`,
    );
    await finalize(project);
    await deploy(project, { target: "dev" });

    expect(
      await asRole(database, reader, "select id, title from app.reports"),
    ).toMatch(/permission denied for schema app/);
    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });

  test("a SECURITY DEFINER function stops being executable by PUBLIC once the desired schema revokes it", async () => {
    const caller = roleName("caller");
    const stranger = roleName("stranger");
    await server.query(`create role ${caller} nologin`);
    await server.query(`create role ${stranger} nologin`);
    const secrets = `create table secrets (id bigint primary key, value text);
create function secret_count() returns bigint language sql stable security definer
  set search_path = public, pg_catalog
  as $$ select count(*) from secrets $$;
grant usage on schema public to ${caller};
`;
    const { project, dir, database } = await deployProject(server, {
      "secrets.sql": secrets,
    });
    await finalizeMigration(project, "add secrets");
    await deploy(project, { target: "dev" });
    expect(
      await asRole(database, stranger, "select secret_count() as n"),
    ).toEqual([{ n: "0" }]);

    await dir.write(
      "data-model/desired-schema/secrets.sql",
      `${secrets}revoke execute on function secret_count() from public;
grant execute on function secret_count() to ${caller};
`,
    );
    await draft(project, { name: "restrict secrets" });
    const schemaChange = await dir.read("data-model/draft/schema-change.sql");
    expect(schemaChange).toContain(
      'REVOKE ALL ON FUNCTION "public"."secret_count"() FROM PUBLIC',
    );
    expect(schemaChange).toContain(
      `GRANT EXECUTE ON FUNCTION "public"."secret_count"() TO "${caller}"`,
    );
    await finalize(project);
    await deploy(project, { target: "dev" });

    expect(
      await asRole(database, stranger, "select secret_count() as n"),
    ).toMatch(/permission denied for function secret_count/);
    expect(
      await asRole(database, caller, "select secret_count() as n"),
    ).toEqual([{ n: "0" }]);
    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });

  test("a schema grant made by hand on a target is drift, and deploy refuses it", async () => {
    const reader = roleName("app_reader");
    const intruder = roleName("intruder");
    await server.query(`create role ${reader} nologin`);
    await server.query(`create role ${intruder} nologin`);
    const { project, dir, database } = await deployProject(
      server,
      {
        "reports.sql": `create table reports (id bigint primary key);
grant usage on schema app to ${reader};
`,
      },
      { settings: inApp },
    );
    await finalizeMigration(project, "add reports");
    await deploy(project, { target: "dev" });
    await server.query(
      `grant usage on schema app to ${intruder}`,
      [],
      database,
    );

    const { drift } = await status(project, { target: "dev" });

    expect(drift?.map(({ object, change }) => ({ object, change }))).toEqual([
      { object: "schema app", change: "changed" },
    ]);
    expect(drift?.[0]?.differences).toContainEqual(
      expect.stringContaining(`${intruder}:USAGE/<owner>`),
    );

    await dir.write(
      "data-model/desired-schema/notes.sql",
      "create table notes (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add notes");
    await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
      DriftError,
    );
  });

  test("a role granted USAGE on the managed schema must exist on the target", async () => {
    const reader = roleName("app_reader");
    const { project, database } = await deployProject(
      server,
      {
        "reports.sql": `create table reports (id bigint primary key);
grant usage on schema app to ${reader};
`,
      },
      { settings: inApp },
    );
    await finalizeMigration(project, "add reports");
    // The rehearsals created it as a placeholder on the shared server.
    expect(
      await server.query("select 1 from pg_roles where rolname = $1", [reader]),
    ).toHaveLength(1);
    await server.query(`drop role ${reader}`);

    const refusal = await deploy(project, { target: "dev" }).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PreflightFailedError);
    expect(refusal).toMatchObject({ findings: { missingRoles: [reader] } });
    expect(
      await server.query(
        "select 1 from pg_namespace where nspname = 'app'",
        [],
        database,
      ),
    ).toEqual([]);
  });

  test("the deploy role's own privileges on a managed schema someone else owns are not drift", async () => {
    const deployer = roleName("deployer");
    const reader = roleName("app_reader");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create role ${reader} nologin`);
    await server.query(`create database ${database}`);
    // Set up by an administrator: the deploy role may create objects in app
    // and grant USAGE on it, but doesn't own it.
    await server.query(
      `create schema app; grant usage, create on schema app to ${deployer} with grant option;
       grant create on database ${database} to ${deployer}`,
      [],
      database,
    );
    const { project } = await deployProject(
      server,
      {
        "reports.sql": `create table reports (id bigint primary key);
grant usage on schema app to ${reader};
grant select on reports to ${reader};
`,
      },
      {
        database,
        settings: inApp,
        preamble: `import { postgresTarget } from "super-deploy";
const asDeployer = {
  async connect() {
    const url = new URL(await postgres.connectionString(${JSON.stringify(database)}));
    url.username = ${JSON.stringify(deployer)};
    url.password = "deployer";
    return postgresTarget({ connectionString: url.href }).connect();
  },
};`,
        adapter: "asDeployer",
      },
    );
    await finalizeMigration(project, "add reports");

    await deploy(project, { target: "dev" });

    expect((await status(project, { target: "dev" })).drift).toEqual([]);
    expect(
      await asRole(database, reader, "select id from app.reports"),
    ).toEqual([]);
  });
});
