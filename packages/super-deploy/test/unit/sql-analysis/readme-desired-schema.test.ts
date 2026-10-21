// The template README's "What the desired schema supports" section against
// the desired-schema rules (SQL-analysis seam): each object kind it lists as
// refused is refused, with the rule the README names. A rule that starts
// refusing something new needs a row here and a line in the README.
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  analyseDesiredSchema,
  SqlRuleViolationError,
} from "../../../src/sql-analysis/index.ts";

const readmePath = new URL("../../../../template/README.md", import.meta.url);
const heading = "## What the desired schema supports";

/** The section's text, with line breaks folded so phrases match across them. */
async function section(): Promise<string> {
  const readme = await readFile(readmePath, "utf8");
  const start = readme.indexOf(`\n${heading}\n`);
  expect(start, `README has no "${heading}" section`).toBeGreaterThan(-1);
  const end = readme.indexOf("\n## ", start + heading.length + 1);
  return readme
    .slice(start, end === -1 ? undefined : end)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** The rule ids the desired schema refuses `sql` with (empty if accepted). */
async function refusals(sql: string): Promise<string[]> {
  try {
    await analyseDesiredSchema([
      { path: "data-model/desired-schema/probe.sql", text: `${sql};\n` },
    ]);
    return [];
  } catch (error) {
    if (!(error instanceof SqlRuleViolationError)) {
      throw error;
    }
    return error.violations.map((violation) => violation.rule);
  }
}

describe("the README lists what the desired schema refuses", () => {
  test.each([
    // [README phrase, statement, rule]
    [
      "enums",
      "create type mood as enum ('happy', 'sad')",
      "unsupported-object",
    ],
    ["standalone sequences", "create sequence s", "unsupported-object"],
    [
      "`serial`",
      "create table t (id serial constraint t_pkey primary key)",
      "unsupported-object",
    ],
    ["`pgcrypto`", "create extension pgcrypto", "unsupported-object"],
    [
      "name every index and constraint",
      "create table t (a int check (a > 0))",
      "unnamed-constraint",
    ],
  ])("%s", async (phrase, sql, rule) => {
    expect(await refusals(sql)).toEqual([rule]);
    expect(await section()).toContain(phrase.toLowerCase());
  });

  // Every other kind `unsupported-object` refuses.
  test.each([
    [
      "partitioned tables",
      "create table m (id int, at date) partition by range (at)",
    ],
    [
      "`partition of`",
      "create table m_2026 partition of m for values from ('2026-01-01') to ('2027-01-01')",
    ],
    ["`bigserial`", "create table t (id bigserial)"],
    ["`smallserial`", "create table t (id smallserial)"],
    ["`serial8`", "create table t (id serial8)"],
    [
      "rules (`create rule`)",
      "create rule r as on insert to t do instead nothing",
    ],
    [
      "event triggers",
      "create event trigger e on ddl_command_start execute function f()",
    ],
    ["foreign tables", "create foreign table ft (a int) server s"],
    ["foreign data wrappers", "create foreign data wrapper w"],
    ["servers", "create server s foreign data wrapper w"],
    ["user mappings", "create user mapping for current_user server s"],
    ["publications", "create publication p for table t"],
    [
      "subscriptions",
      "create subscription s connection 'host=x' publication p",
    ],
    ["custom casts", "create cast (text as int) with function f(text)"],
    [
      "operators",
      "create operator === (leftarg = int, rightarg = int, function = int4eq)",
    ],
    [
      "operator classes",
      "create operator class c for type int using btree as operator 1 <",
    ],
    ["operator families", "create operator family f using btree"],
    ["aggregates", "create aggregate a (int) (sfunc = int4pl, stype = int)"],
    ["collations", "create collation c (provider = icu, locale = 'und')"],
    [
      "conversions",
      "create conversion c for 'LATIN1' to 'UTF8' from iso8859_1_to_utf8",
    ],
    [
      "transforms",
      "create transform for int language sql (from sql with function f(internal))",
    ],
    ["access methods", "create access method m type table handler h"],
    [
      "text-search configurations",
      "create text search configuration c (copy = english)",
    ],
    ["dictionaries", "create text search dictionary d (template = simple)"],
    [
      "parsers",
      "create text search parser p (start = s, gettoken = g, end = e, lextypes = l)",
    ],
    ["templates", "create text search template t (lexize = l)"],
    ["range types", "create type r as range (subtype = int)"],
    ["base types", "create type b"],
    [
      "procedural languages",
      "create language plperl handler plperl_call_handler",
    ],
    [
      "functions in any language but `sql` and `plpgsql`",
      "create function f() returns int language c as 'lib', 'f'",
    ],
    ["`create statistics`", "create statistics st on a, b from t"],
    ["no `create schema`", "create schema s"],
    ["table inheritance (`inherits`)", "create table t (a int) inherits (u)"],
    ["typed tables (`create table ... of type`)", "create table t of address"],
    ["temporary tables", "create temporary table t (a int)"],
    ["temporary views", "create temporary view v as select 1 as a"],
    [
      "`not enforced` constraints",
      "create table t (a int constraint t_a_check check (a > 0) not enforced)",
    ],
    [
      "constraint triggers",
      "create constraint trigger c after insert on t for each row execute function f()",
    ],
    [
      "virtual generated columns",
      "create table t (a int, b int generated always as (a * 2))",
    ],
    [
      "`window`",
      "create function f(int) returns int language sql window as $$ select 1 $$",
    ],
    [
      "`support`",
      "create function f(int) returns int language sql support s as $$ select 1 $$",
    ],
    [
      "view options other than",
      "create view v with (fillfactor = 10) as select 1 as a",
    ],
    ["unlogged tables", "create unlogged table t (a int)"],
    ["tablespaces", "create table t (a int) tablespace ts"],
    [
      "table and materialized view storage parameters",
      "create table t (a int) with (fillfactor = 70)",
    ],
    [
      "table and materialized view storage parameters",
      "create materialized view mv with (fillfactor = 70) as select 1 as a",
    ],
    [
      "table access methods (`using heap`)",
      "create table t (a int) using heap",
    ],
    ["column `storage`", "create table t (a text storage external)"],
    ["`compression` settings", "create table t (a text compression lz4)"],
    ["grants", "grant select on t to someone"],
    ["roles", "create role r"],
    ["ownership", "alter table t owner to r"],
    ["policies", "create policy p on t using (true)"],
    ["row-level security", "alter table t enable row level security"],
    [
      "`security definer`",
      "create function f() returns int language sql security definer as $$ select 1 $$",
    ],
  ])("%s", async (phrase, sql) => {
    expect(await refusals(sql)).toContain("unsupported-object");
    expect(await section()).toContain(phrase.toLowerCase());
  });
});
