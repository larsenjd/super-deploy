// The SQL-analysis seam: pure functions over SQL text and file kind.
import { describe, expect, test } from "vitest";
import {
  analyseDesiredSchema,
  checkRules,
  orderDesiredSchema,
  SqlRuleViolationError,
} from "../../../src/sql-analysis/index.ts";

const file = (text: string, path = "data-model/desired-schema/a.sql") => ({
  path,
  text,
});

describe("desired-schema rules", () => {
  test("accept CREATE TABLE", async () => {
    const violations = await checkRules(
      file(
        "create table customers (id bigint primary key, name text not null);",
      ),
      "desired-schema",
    );

    expect(violations).toEqual([]);
  });

  test("accept empty and comment-only files", async () => {
    expect(await checkRules(file(""), "desired-schema")).toEqual([]);
    expect(
      await checkRules(file("-- nothing yet\n"), "desired-schema"),
    ).toEqual([]);
  });

  test.each([
    ["update t set a = 1", "UPDATE"],
    ["insert into t (a) values (1)", "INSERT"],
    ["drop table t", "DROP"],
    ["begin", "Transaction control"],
  ])("refuse %j", async (sql, name) => {
    const violations = await checkRules(file(`${sql};`), "desired-schema");

    expect(violations).toEqual([
      {
        file: "data-model/desired-schema/a.sql",
        line: 1,
        statement: sql,
        rule: "desired-schema-statement",
        message: `${name} is not allowed in the desired schema`,
      },
    ]);
  });

  test("report each refused statement's own line, past comments and multi-byte text", async () => {
    const violations = await checkRules(
      file(
        "create table t (a text default 'ünïcödé');\n\n-- a comment\n/* block */ drop view v;\ncreate table u (b int);\n\n  insert into t (a)\n  values ('x');\n",
      ),
      "desired-schema",
    );

    expect(violations.map((v) => [v.line, v.statement])).toEqual([
      [4, "drop view v"],
      [7, "insert into t (a)\n  values ('x')"],
    ]);
  });

  test("report a syntax error with its line", async () => {
    const violations = await checkRules(
      file("create table t (a text default 'ü');\n\ncreate tabel u (b int);\n"),
      "desired-schema",
    );

    expect(violations).toMatchObject([
      {
        line: 3,
        rule: "syntax-error",
        message: expect.stringContaining('"tabel"'),
      },
    ]);
  });
});

describe("ordering", () => {
  test("returns every statement once, with its file and line", async () => {
    const result = await orderDesiredSchema([
      file("create table b (id int);\n", "data-model/desired-schema/b.sql"),
      file(
        "create table a (id int);\n\ncreate table c (id int);\n",
        "data-model/desired-schema/a.sql",
      ),
    ]);

    expect(result.errors).toEqual([]);
    expect(
      result.statements.map((s) => [s.file, s.line, s.text]).sort(),
    ).toEqual([
      ["data-model/desired-schema/a.sql", 1, "create table a (id int)"],
      ["data-model/desired-schema/a.sql", 3, "create table c (id int)"],
      ["data-model/desired-schema/b.sql", 1, "create table b (id int)"],
    ]);
  });
});

describe("analysing the desired schema", () => {
  test("lists a file's rule violations and ordering's unnamed constraints and indexes in one pass", async () => {
    const error = await analyseDesiredSchema([
      file(
        "create type mood as enum ('happy', 'sad');\n",
        "data-model/desired-schema/types.sql",
      ),
      file(
        "create table people (\n  id bigint primary key,\n  feeling mood,\n  age int check (age >= 0)\n);\ncreate index on people (age);\n",
        "data-model/desired-schema/people.sql",
      ),
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SqlRuleViolationError);
    // The refused enum's type isn't reported again as unknown to people.
    expect(
      (error as SqlRuleViolationError).violations.map(
        ({ file, line, rule }) => [file, line, rule],
      ),
    ).toEqual([
      ["data-model/desired-schema/types.sql", 1, "unsupported-object"],
      ["data-model/desired-schema/people.sql", 4, "unnamed-constraint"],
      ["data-model/desired-schema/people.sql", 6, "unnamed-index"],
    ]);
  });
});
