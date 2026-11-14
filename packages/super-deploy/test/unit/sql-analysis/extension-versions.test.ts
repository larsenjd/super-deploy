// The extension statements a deployment's pre-flight checks a target for, at
// the SQL-analysis seam (database-free): every version a schema change
// installs or updates to (ADR-0009, spec "Pre-flight").
import { describe, expect, test } from "vitest";
import {
  extensionVersionStatements,
  parseSqlFile,
} from "../../../src/sql-analysis/index.ts";

async function statementsOf(text: string) {
  const parsed = await parseSqlFile({ path: "schema-change.sql", text });
  if (!parsed.ok) {
    throw new Error(parsed.violation.message);
  }
  return extensionVersionStatements(parsed.statements);
}

describe("extensionVersionStatements", () => {
  test("lists each CREATE EXTENSION and ALTER EXTENSION ... UPDATE TO with its version, in order", async () => {
    expect(
      await statementsOf(`ALTER EXTENSION "citext" UPDATE TO '1.8';
CREATE EXTENSION "pgcrypto" SCHEMA "public" VERSION '1.3';
CREATE TABLE t (id bigint);
CREATE EXTENSION IF NOT EXISTS ltree;`),
    ).toEqual([
      { name: "citext", version: "1.8", creates: false },
      { name: "pgcrypto", version: "1.3", creates: true },
      { name: "ltree", version: undefined, creates: true },
    ]);
  });

  test("leaves out plpgsql and an UPDATE without a version", async () => {
    expect(
      await statementsOf(`CREATE EXTENSION IF NOT EXISTS plpgsql;
ALTER EXTENSION citext UPDATE;
DROP EXTENSION hstore;`),
    ).toEqual([]);
  });
});
