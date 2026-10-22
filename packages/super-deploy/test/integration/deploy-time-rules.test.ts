// Deploy-time rules wired into draft, rehearse, finalize and validate (API
// seam). The rules themselves are covered at the SQL-analysis seam.
import {
  draft,
  finalize,
  loadProject,
  rehearse,
  SqlRuleViolationError,
  ValidationFailedError,
  validate,
} from "superdeploy";
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

const customers = `create table customers (
  id bigint primary key,
  name text not null
);
`;
const schemaChange = "data-model/draft/schema-change.sql";

async function project(desiredSchema = customers) {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { "data-model/desired-schema/customers.sql": desiredSchema },
  });
  return { dir, project: await loadProject({ cwd: dir.root }) };
}

async function ruleViolation(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SqlRuleViolationError);
  return error as SqlRuleViolationError;
}

/** Appends a statement to the draft's schema change, as a hand edit would. */
async function appendToSchemaChange(
  dir: Awaited<ReturnType<typeof project>>["dir"],
  sql: string,
) {
  const text = await dir.read(schemaChange);
  await dir.write(schemaChange, `${text}\n${sql}\n`);
  return text.split("\n").length + 1;
}

describe("rehearse and finalize", () => {
  test("refuse a draft whose schema change breaks a rule, naming file, line, statement and rule", async () => {
    const { dir, project: p } = await project();
    await draft(p, { name: "add customers" });
    const line = await appendToSchemaChange(
      dir,
      'VACUUM "public"."customers";',
    );

    for (const command of [rehearse, finalize]) {
      const error = await ruleViolation(command(p));
      expect(error.violations).toEqual([
        {
          file: schemaChange,
          line,
          statement: 'VACUUM "public"."customers"',
          rule: "not-in-transaction",
          message: "VACUUM cannot run inside a transaction block (ANALYZE can)",
        },
      ]);
    }
    expect(dir.exists("data-model/migrations/00001-add-customers")).toBe(false);
    expect(dir.exists(schemaChange)).toBe(true);
  });

  test("accept a schema change with identity columns, volatile defaults and checks", async () => {
    const { project: p } = await project(`create table orders (
  id bigint generated always as identity primary key,
  placed_at timestamptz not null default now(),
  reference uuid not null default gen_random_uuid(),
  total numeric(12, 2) not null constraint orders_total_positive check (total >= 0)
);
`);
    await draft(p, { name: "add orders" });

    await expect(finalize(p)).resolves.toMatchObject({ number: 1 });
  });
});

describe("validate", () => {
  test("reports rule violations in the draft and the desired schema as errors", async () => {
    const { dir, project: p } = await project();
    await draft(p, { name: "add customers" });
    const line = await appendToSchemaChange(dir, "COMMIT;");
    await dir.write("data-model/desired-schema/maintenance.sql", "\nvacuum;\n");

    const error = await validate(p).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationFailedError);
    const errors = (error as ValidationFailedError).problems.filter(
      (problem) => problem.severity === "error",
    );
    expect(errors).toEqual([
      {
        severity: "error",
        code: "sql-rule-violation",
        message:
          "data-model/desired-schema/maintenance.sql:2: VACUUM / ANALYZE is not allowed in the desired schema [desired-schema-statement]",
        path: "data-model/desired-schema/maintenance.sql",
        line: 2,
        rule: "desired-schema-statement",
      },
      {
        severity: "error",
        code: "sql-rule-violation",
        message: `${schemaChange}:${line}: COMMIT would end the deploy transaction early; super-deploy runs every pending migration in one transaction [transaction-control]`,
        path: schemaChange,
        line,
        rule: "transaction-control",
      },
    ]);
  });

  test("passes finalized migrations that follow the rules", async () => {
    const { project: p } = await project();
    await draft(p, { name: "add customers" });
    await finalize(p);

    await expect(validate(p, { strict: true })).resolves.toMatchObject({
      migrations: 1,
      problems: [],
    });
  });
});
