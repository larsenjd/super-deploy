// API seam: a draft's seed data in draft, rehearse and finalize, and never
// anywhere else.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  deploy,
  draft,
  finalize,
  rehearse,
  SqlFileFailedError,
  SqlRuleViolationError,
  ValidationFailedError,
  validate,
} from "superdeploy";
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

const customers = (city: string) => `create table customers (
  id bigint primary key,
  name text not null,
  city text${city}
);
`;

/** Migration 1: an empty customers table whose city may be null. */
async function withCustomers() {
  const setup = await deployProject(server, { "customers.sql": customers("") });
  await draft(setup.project, { name: "add customers" });
  await finalize(setup.project);
  return setup;
}

/** Production's problem: a customer without a city. */
const cityless = "insert into customers (id, name) values (1, 'Ada');\n";

describe("seed data", () => {
  test("rehearse and finalize load the draft's seed data just before its pre-migration script", async () => {
    const { dir, project } = await withCustomers();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers(" not null"),
    );
    await draft(project, { name: "require city" });
    await dir.write("data-model/draft/seed-data.sql", cityless);

    // The seeded customer has no city, so the schema change fails.
    for (const action of [rehearse, finalize]) {
      const failure = action(project);
      await expect(failure).rejects.toBeInstanceOf(SqlFileFailedError);
      await expect(failure).rejects.toMatchObject({
        file: "data-model/draft/schema-change.sql",
        postgresMessage: expect.stringContaining('column "city"'),
      });
    }

    // The pre-migration script sees the seed data and handles it.
    await dir.write(
      "data-model/draft/pre-migration.sql",
      "update customers set city = 'Unknown' where city is null;\n",
    );
    await expect(rehearse(project)).resolves.toMatchObject({
      name: "require-city",
    });
    const finalized = await finalize(project);

    // Frozen with the migration as an audit record.
    const frozen = join(finalized.path, "seed-data.sql");
    expect(await readFile(frozen, "utf8")).toBe(cityless);
    expect((await stat(frozen)).mode & 0o222).toBe(0);
  });

  test("draft counts the seed data in what the scripts must cover, after the pre-migration script ran on it", async () => {
    const { dir, project } = await withCustomers();
    await dir.write(
      "data-model/desired-schema/customers.sql",
      customers(" not null"),
    );
    await draft(project, { name: "require city" });
    await dir.write(
      "data-model/draft/seed-data.sql",
      `${cityless}insert into customers (id, name, city) values (2, 'Grace', 'Arlington');\ninsert into customers (id, name) values (3, 'Edsger');\n`,
    );

    const seeded = await draft(project);
    expect(
      seeded.toCover.map(({ kind, column, rows }) => ({ kind, column, rows })),
    ).toEqual([{ kind: "set-not-null", column: "city", rows: 2 }]);

    await dir.write(
      "data-model/draft/pre-migration.sql",
      "update customers set city = 'Unknown' where id = 1;\n",
    );
    const covered = await draft(project);
    expect(covered.toCover.map(({ rows }) => rows)).toEqual([1]);
  });

  test("finalized migrations' seed data is never loaded again: not in later drafts' rehearsals, deployment rehearsals or deployments", async () => {
    const { dir, project, database } = await withCustomers();
    // Migration 2 is rehearsed with a cityless customer...
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers("").replace(/\n\);\n$/, "")},\n  email text\n);\n`,
    );
    await draft(project, { name: "add email" });
    await dir.write("data-model/draft/seed-data.sql", cityless);
    await finalize(project);
    // ...which would break migration 3 if it were ever loaded again.
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers(" not null").replace(/\n\);\n$/, "")},\n  email text\n);\n`,
    );

    const drafted = await draft(project, { name: "require city" });

    expect(drafted.toCover.map(({ rows }) => rows)).toEqual([0]);
    await expect(rehearse(project)).resolves.toMatchObject({
      migrationsReplayed: 2,
    });
    await finalize(project);
    const deployed = await deploy(project, { target: "dev" });
    expect(deployed.deployed).toHaveLength(3);
    expect(
      await server.query("select id from customers", [], database),
    ).toEqual([]);
  });

  test("seed data may contain only INSERTs with a column list: draft, rehearse and validate refuse anything else", async () => {
    const { dir, project } = await withCustomers();
    await draft(project, { name: "tidy cities" });
    await dir.write(
      "data-model/draft/seed-data.sql",
      "insert into customers values (1, 'Ada', null);\nupdate customers set city = 'London';\n",
    );
    const seedData = "data-model/draft/seed-data.sql";
    const expected = [
      { file: seedData, line: 1, rule: "insert-without-columns" },
      { file: seedData, line: 2, rule: "deploy-time-statement" },
    ];

    for (const action of [() => draft(project), () => rehearse(project)]) {
      const failure = action();
      await expect(failure).rejects.toBeInstanceOf(SqlRuleViolationError);
      await expect(failure).rejects.toMatchObject({ violations: expected });
    }
    const error = await validate(project).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(
      (error as ValidationFailedError).problems
        .filter(({ code }) => code === "sql-rule-violation")
        .map(({ path, line, rule }) => ({ file: path, line, rule })),
    ).toEqual(expected);
  });
});
