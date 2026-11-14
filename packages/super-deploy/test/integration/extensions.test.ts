// API seam: supported extensions (ADR-0009) declared in the desired schema,
// rehearsed and deployed at the version they pin.
import {
  deploy,
  draft,
  ExtensionDowngradeError,
  finalize,
  type Project,
  RehearsalExtensionVersionError,
  RehearsalMismatchError,
  SqlRuleViolationError,
  status,
  ValidationFailedError,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  asDeployRole,
  deployProject,
  finalizeMigration,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const users = `create extension citext version '1.8';

create table users (
  id bigint constraint users_pkey primary key,
  email citext not null
);
`;

/** A schema change's statements, without its header comment. */
function statementsOf(schemaChange: string): string[] {
  return schemaChange
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block !== "" && !block.startsWith("--"));
}

/** Each extension in `database`: its version, schema and owner. */
async function extensionsIn(database: string) {
  return server.query(
    `select e.extname as name, e.extversion as version, n.nspname as schema, r.rolname as owner
         from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
         join pg_roles r on r.oid = e.extowner
        where e.extname <> 'plpgsql'
        order by e.extname`,
    [],
    database,
  );
}

/** `database` holds exactly `extensions`, and `status` reports no drift on it. */
async function expectDeployedWithoutDrift(
  project: Project,
  database: string,
  extensions: Awaited<ReturnType<typeof extensionsIn>>,
) {
  expect(await extensionsIn(database)).toEqual(extensions);
  expect((await status(project, { target: "dev" })).drift).toEqual([]);
}

describe("a supported extension", () => {
  test("goes through draft, finalize and deploy at its pinned version, owned by the deploy role", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "users.sql": users },
      { settings: `extensions: { citext: ["1.8"] },` },
    );

    await draft(project, { name: "add users" });
    expect(await dir.read("data-model/draft/schema-change.sql")).toMatch(
      /^CREATE EXTENSION "citext" SCHEMA "public" VERSION '1\.8';$/m,
    );
    await finalize(project);
    await deploy(project, { target: "dev" });

    await expectDeployedWithoutDrift(project, database, [
      { name: "citext", version: "1.8", schema: "public", owner: "deployer" },
    ]);
  });
});

describe("changing an extension's version", () => {
  test("raising it drafts UPDATE TO first in the schema change, and deploys without drift", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "users.sql": users.replace("'1.8'", "'1.6'") },
      { settings: `extensions: { citext: ["1.6", "1.8"] },` },
    );
    await finalizeMigration(project, "add users");
    await deploy(project, { target: "dev" });

    await dir.write(
      "data-model/desired-schema/users.sql",
      users.replace("not null", "not null,\n  nickname citext"),
    );
    await draft(project, { name: "update citext" });
    const schemaChange = await dir.read("data-model/draft/schema-change.sql");
    expect(statementsOf(schemaChange)).toEqual([
      `ALTER EXTENSION "citext" UPDATE TO '1.8';`,
      expect.stringMatching(/^ALTER TABLE .* ADD COLUMN "nickname"/),
    ]);
    await finalize(project);
    await deploy(project, { target: "dev" });

    await expectDeployedWithoutDrift(project, database, [
      { name: "citext", version: "1.8", schema: "public", owner: "deployer" },
    ]);
  });

  test("by hand on a target is drift naming the version", async () => {
    const { project, database } = await deployProject(
      server,
      { "users.sql": users.replace("'1.8'", "'1.6'") },
      { settings: `extensions: { citext: ["1.6"] },` },
    );
    await finalizeMigration(project, "add users");
    await deploy(project, { target: "dev" });
    await asDeployRole(
      server,
      database,
      "alter extension citext update to '1.8'",
    );

    expect((await status(project, { target: "dev" })).drift).toEqual([
      {
        object: "extension citext",
        change: "changed",
        differences: [
          {
            side: "target",
            line: "extension: citext schema=public version=1.8",
          },
          {
            side: "expected",
            line: "extension: citext schema=public version=1.6",
          },
        ],
      },
    ]);
  });

  test("lowering it is refused at draft, since PostgreSQL has no downgrade scripts", async () => {
    const { dir, project } = await deployProject(
      server,
      { "users.sql": users },
      { settings: `extensions: { citext: ["1.6", "1.8"] },` },
    );
    await finalizeMigration(project, "add users");

    await dir.write(
      "data-model/desired-schema/users.sql",
      users.replace("'1.8'", "'1.6'"),
    );
    const error = await draft(project, { name: "lower citext" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ExtensionDowngradeError);
    expect(error).toMatchObject({
      code: "extension-downgrade",
      extension: "citext",
      from: "1.8",
      to: "1.6",
      message:
        "The desired schema lowers citext from 1.8 to 1.6, which PostgreSQL can't do: it has no downgrade scripts. Keep VERSION '1.8' or a higher one",
    });
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(false);
  });
  test("in a hand-edited schema change is a rehearsal mismatch naming both versions", async () => {
    const { dir, project } = await deployProject(
      server,
      { "users.sql": users.replace("'1.8'", "'1.7'") },
      { settings: `extensions: { citext: ["1.7", "1.8"] },` },
    );
    await draft(project, { name: "add users" });
    const schemaChange = await dir.read("data-model/draft/schema-change.sql");
    await dir.write(
      "data-model/draft/schema-change.sql",
      schemaChange.replace("VERSION '1.7'", "VERSION '1.8'"),
    );

    const error = await finalize(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    const differences = (error as RehearsalMismatchError).differences;
    expect(differences).toContainEqual(
      expect.stringMatching(/citext .*version=1\.8/),
    );
    expect(differences).toContainEqual(
      expect.stringMatching(/citext .*version=1\.7/),
    );
  });
});

describe("removing an extension", () => {
  test("drafts the drop of each column using it, then DROP EXTENSION without CASCADE, and deploys without drift", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "users.sql": users },
      { settings: `extensions: { citext: ["1.8"] },` },
    );
    await finalizeMigration(project, "add users");
    await deploy(project, { target: "dev" });

    await dir.write(
      "data-model/desired-schema/users.sql",
      `create table users (
  id bigint constraint users_pkey primary key
);
`,
    );
    await draft(project, { name: "remove citext" });
    expect(
      statementsOf(await dir.read("data-model/draft/schema-change.sql")),
    ).toEqual([
      'ALTER TABLE "public"."users" DROP COLUMN "email";',
      'DROP EXTENSION "citext";',
    ]);
    await finalize(project, { acknowledgeDestructive: true });
    await deploy(project, { target: "dev" });

    await expectDeployedWithoutDrift(project, database, []);
  });

  test("while a column still uses its type fails as an unknown reference", async () => {
    const { dir, project } = await deployProject(
      server,
      { "users.sql": users },
      { settings: `extensions: { citext: ["1.8"] },` },
    );
    await finalizeMigration(project, "add users");

    await dir.write(
      "data-model/desired-schema/users.sql",
      users.replace("create extension citext version '1.8';\n", ""),
    );
    const error = await draft(project, { name: "remove citext" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    expect(
      (error as SqlRuleViolationError).violations.map(({ rule, message }) => ({
        rule,
        message,
      })),
    ).toEqual([
      { rule: "unknown-reference", message: expect.stringContaining("citext") },
    ]);
  });

  test("provides the operator class of an index, in every load order", async () => {
    // Draft and finalize load the desired schema in two orders and refuse a
    // difference (the order-independence check), so the index needs its
    // edge to pg_trgm in both.
    const { project, database } = await deployProject(
      server,
      {
        "docs.sql": `create extension pg_trgm version '1.6';

create table docs (
  id bigint constraint docs_pkey primary key,
  title text not null
);

create index docs_title_trgm on docs using gin (title gin_trgm_ops);
`,
      },
      { settings: `extensions: { pg_trgm: ["1.6"] },` },
    );

    await draft(project, { name: "add docs" });
    await finalize(project);
    await deploy(project, { target: "dev" });

    expect(
      await server.query(
        "select indexdef from pg_indexes where indexname = 'docs_title_trgm'",
        [],
        database,
      ),
    ).toEqual([
      {
        indexdef:
          "CREATE INDEX docs_title_trgm ON public.docs USING gin (title gin_trgm_ops)",
      },
    ]);
    expect((await status(project, { target: "dev" })).drift).toEqual([]);
  });
});

describe("the desired-schema rules for extensions", () => {
  test("validate gives the same refusals as draft", async () => {
    const { project } = await deployProject(
      server,
      {
        "extensions.sql": `create extension citext;
create extension earthdistance version '1.2';
create extension ltree version '1.3';
create extension citext version '1.7';
create extension citext schema other version '1.8' cascade;
comment on extension citext is 'x';
`,
      },
      { settings: `extensions: { citext: ["1.8"] },` },
    );

    const refused = await draft(project, { name: "extensions" }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SqlRuleViolationError);
    const violations = (refused as SqlRuleViolationError).violations;
    expect(violations.map(({ rule }) => rule)).toEqual([
      "extension-without-version",
      "unsupported-extension",
      "extension-not-listed",
      "extension-version-not-listed",
      "extension-outside-managed-schema",
      "extension-cascade",
      "extension-comment",
    ]);

    const failed = await validate(project, {}).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ValidationFailedError);
    expect(
      (failed as ValidationFailedError).problems
        .filter(({ code }) => code === "sql-rule-violation")
        .map(({ path, line, rule, message }) => ({
          path,
          line,
          rule,
          found: message.includes(
            violations.find((v) => v.line === line && v.rule === rule)
              ?.message ?? "?",
          ),
        })),
    ).toEqual(
      violations.map(({ file, line, rule }) => ({
        path: file,
        line,
        rule,
        found: true,
      })),
    );
  });
});

/**
 * A rehearsal adapter whose server's citext stops at 1.7 while `lacking`, a
 * JavaScript condition, holds: its pg_available_extension_versions leaves
 * 1.8 out, and installing 1.8 fails as PostgreSQL fails it.
 */
function rehearsalLackingCitext18(lacking: string): string {
  return `{
  async createDatabase(request) {
    const database = await postgres.rehearsal.createDatabase(request);
    return {
      name: database.name,
      drop: () => database.drop(),
      async connect() {
        const session = await database.connect();
        return {
          execute: (sql) =>
            (${lacking}) && /citext.*'1\\.8'/is.test(sql)
              ? Promise.reject(new Error('extension "citext" has no installation script nor update path for version "1.8"'))
              : session.execute(sql),
          serverVersion: () => session.serverVersion(),
          close: () => session.close(),
          async query(sql, values) {
            const result = await session.query(sql, values);
            return (${lacking}) && sql.includes("pg_available_extension_versions")
              ? { rows: result.rows.filter((row) => row.version !== "1.8") }
              : result;
          },
        };
      },
    };
  },
}`;
}

describe("a rehearsal", () => {
  test("fails when its server can't install the pinned version, naming what it offers", async () => {
    const { project } = await deployProject(
      server,
      { "users.sql": users },
      {
        settings: `extensions: { citext: ["1.8"] },`,
        rehearsal: rehearsalLackingCitext18("true"),
      },
    );

    const error = await draft(project, { name: "add users" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RehearsalExtensionVersionError);
    expect(error).toMatchObject({
      code: "rehearsal-extension-version-unavailable",
      extension: "citext",
      version: "1.8",
      available: ["1.4", "1.5", "1.6", "1.7"],
    });
    expect((error as Error).message).toContain(
      "can't install citext 1.8: it offers citext 1.4, 1.5, 1.6, 1.7",
    );
  });

  test("of a deployment fails before replaying a migration whose version its server can't install, naming the migration", async () => {
    const { project, database } = await deployProject(
      server,
      { "users.sql": users },
      {
        settings: `extensions: { citext: ["1.8"] },`,
        rehearsal: rehearsalLackingCitext18("globalThis.lackCitext18"),
      },
    );
    await finalizeMigration(project, "add users");
    const lacking = globalThis as { lackCitext18?: boolean };
    lacking.lackCitext18 = true;
    try {
      const error = await deploy(project, { target: "dev" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(RehearsalExtensionVersionError);
      expect(error).toMatchObject({
        extension: "citext",
        version: "1.8",
        unit: "00001-add-users",
        available: ["1.4", "1.5", "1.6", "1.7"],
      });
      expect(await extensionsIn(database)).toEqual([]);
    } finally {
      delete lacking.lackCitext18;
    }
  });
});
