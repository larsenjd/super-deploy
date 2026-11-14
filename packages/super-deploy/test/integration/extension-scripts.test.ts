// API seam: pre- and post-migration scripts and seed data with supported
// extensions (ADR-0009). Scripts may call the functions of an extension the
// config lists; no script or seed data may create, alter or drop one.
import { createHash } from "node:crypto";
import {
  deploy,
  draft,
  finalize,
  loadProject,
  SqlRuleViolationError,
  ValidationFailedError,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, expect, test } from "vitest";
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

const users = `create table users (
  id bigint constraint users_pkey primary key,
  email text not null
);
`;

const hashedUsers = `create extension pgcrypto version '1.4';

create table users (
  id bigint constraint users_pkey primary key,
  email text not null,
  email_hash text
);
`;

const backfill =
  "update users set email_hash = encode(digest(email, 'sha256'), 'hex');\n";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

test("a post-migration script backfills a column with a supported extension's function", async () => {
  const { dir, project, database } = await deployProject(
    server,
    { "users.sql": users },
    { settings: `extensions: { pgcrypto: ["1.4"] },` },
  );
  await finalizeMigration(project, "add users");
  await deploy(project, { target: "dev" });
  await asDeployRole(
    server,
    database,
    "insert into users (id, email) values (1, 'ada@example.com'), (2, 'grace@example.com')",
  );

  await dir.write("data-model/desired-schema/users.sql", hashedUsers);
  await draft(project, { name: "hash emails" });
  await dir.write(
    "data-model/draft/seed-data.sql",
    "insert into users (id, email) values (1, 'seed@example.com');\n",
  );
  await dir.write("data-model/draft/post-migration.sql", backfill);
  await finalize(project);
  await deploy(project, { target: "dev" });

  expect(
    await server.query(
      "select id, email_hash from users order by id",
      [],
      database,
    ),
  ).toEqual([
    { id: "1", email_hash: sha256("ada@example.com") },
    { id: "2", email_hash: sha256("grace@example.com") },
  ]);
});

test("a finalized migration's script still validates after its extension leaves the config", async () => {
  const { dir, project } = await deployProject(
    server,
    { "users.sql": hashedUsers },
    { settings: `extensions: { pgcrypto: ["1.4"] },` },
  );
  await draft(project, { name: "add users" });
  await dir.write("data-model/draft/post-migration.sql", backfill);
  await finalize(project);

  await dir.write(
    "super-deploy.config.ts",
    (await dir.read("super-deploy.config.ts")).replace(
      `extensions: { pgcrypto: ["1.4"] },`,
      "",
    ),
  );
  await dir.write("data-model/desired-schema/users.sql", users);
  const tightened = await loadProject({ cwd: dir.root, reload: true });

  const outcome = await validate(tightened, {}).catch(
    (error: unknown) => error,
  );
  const problems =
    outcome instanceof ValidationFailedError ? outcome.problems : [];
  expect(problems.filter(({ code }) => code === "sql-rule-violation")).toEqual(
    [],
  );
});

test("draft refuses scripts calling an unlisted extension's function or a routine, and extension statements", async () => {
  const { dir, project } = await deployProject(
    server,
    {
      "users.sql": `${hashedUsers}
create function normalise(email text) returns text
  language sql immutable return lower(email);
`,
    },
    { settings: `extensions: { pgcrypto: ["1.4"] },` },
  );
  await draft(project, { name: "add users" });
  await dir.write(
    "data-model/draft/pre-migration.sql",
    "create extension if not exists plpgsql;\n",
  );
  await dir.write(
    "data-model/draft/post-migration.sql",
    `update users set email = normalise(email);
update users set email_hash = similarity(email, 'x')::text;
`,
  );

  const error = await draft(project, { name: "add users" }).catch(
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(SqlRuleViolationError);
  expect(
    (error as SqlRuleViolationError).violations.map(
      ({ file, rule, message }) => ({ file, rule, message }),
    ),
  ).toEqual([
    {
      file: "data-model/draft/pre-migration.sql",
      rule: "deploy-time-statement",
      message:
        "CREATE EXTENSION is not allowed in a pre-migration script: extensions belong in the desired schema, and only a schema change creates, updates or drops one",
    },
    {
      file: "data-model/draft/post-migration.sql",
      rule: "user-function-call",
      message:
        "normalise() is not a built-in pg_catalog function or a function of an extension the config lists; deploy-time SQL may not call user-defined functions",
    },
    {
      file: "data-model/draft/post-migration.sql",
      rule: "user-function-call",
      message:
        "similarity() is not a built-in pg_catalog function or a function of an extension the config lists; deploy-time SQL may not call user-defined functions",
    },
  ]);
});
