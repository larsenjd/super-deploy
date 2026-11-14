// The extension statements a deployment's pre-flight checks a target for, at
// the SQL-analysis seam (database-free): every version a schema change
// installs or updates to, and the extensions it drops (ADR-0009, spec
// "Pre-flight").
import { describe, expect, test } from "vitest";
import {
  extensionChanges,
  parseSqlFile,
} from "../../../src/sql-analysis/index.ts";

async function changesOf(text: string) {
  const parsed = await parseSqlFile({ path: "schema-change.sql", text });
  if (!parsed.ok) {
    throw new Error(parsed.violation.message);
  }
  return extensionChanges(parsed.statements);
}

describe("extensionChanges", () => {
  test("lists each CREATE EXTENSION and ALTER EXTENSION ... UPDATE TO with its version, and each extension a DROP EXTENSION names, in order", async () => {
    expect(
      await changesOf(`ALTER EXTENSION "citext" UPDATE TO '1.8';
CREATE EXTENSION "pgcrypto" SCHEMA "public" VERSION '1.3';
CREATE TABLE t (id bigint);
DROP EXTENSION hstore, ltree;
CREATE EXTENSION IF NOT EXISTS ltree;`),
    ).toEqual([
      { name: "citext", version: "1.8", change: "update" },
      { name: "pgcrypto", version: "1.3", change: "create" },
      { name: "hstore", version: undefined, change: "drop" },
      { name: "ltree", version: undefined, change: "drop" },
      { name: "ltree", version: undefined, change: "create" },
    ]);
  });

  test("leaves out plpgsql and an UPDATE without a version", async () => {
    expect(
      await changesOf(`CREATE EXTENSION IF NOT EXISTS plpgsql;
ALTER EXTENSION citext UPDATE;
DROP EXTENSION plpgsql;`),
    ).toEqual([]);
  });
});
