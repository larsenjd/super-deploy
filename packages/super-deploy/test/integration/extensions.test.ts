// API seam: supported extensions (ADR-0009) declared in the desired schema,
// rehearsed and deployed at the version they pin.
import {
  deploy,
  draft,
  finalize,
  RehearsalExtensionVersionError,
  SqlRuleViolationError,
  status,
  ValidationFailedError,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deployProject } from "../support/deploy.ts";
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

    expect(await extensionsIn(database)).toEqual([
      { name: "citext", version: "1.8", schema: "public", owner: "deployer" },
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

describe("a rehearsal", () => {
  test("fails when its server can't install the pinned version, naming what it offers", async () => {
    const { project } = await deployProject(
      server,
      { "users.sql": users },
      {
        settings: `extensions: { citext: ["1.8"] },`,
        // A rehearsal server whose citext stops at 1.7.
        rehearsal: `{
  async createDatabase(request) {
    const database = await postgres.rehearsal.createDatabase(request);
    return {
      name: database.name,
      drop: () => database.drop(),
      async connect() {
        const session = await database.connect();
        return {
          execute: (sql) => session.execute(sql),
          serverVersion: () => session.serverVersion(),
          close: () => session.close(),
          async query(sql, values) {
            const result = await session.query(sql, values);
            return sql.includes("pg_available_extension_versions")
              ? { rows: result.rows.filter((row) => row.version !== "1.8") }
              : result;
          },
        };
      },
    };
  },
}`,
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
      message:
        "The rehearsal server can't install citext 1.8: it offers citext 1.4, 1.5, 1.6, 1.7. A rehearsal installs exactly the version the desired schema pins, so use a rehearsal server that offers citext 1.8",
    });
  });
});
