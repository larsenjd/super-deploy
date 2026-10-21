// Objects deploy-time SQL drops and creates again, at the SQL-analysis seam
// (database-free): the ones whose hand-made privileges on a target a
// deployment would lose (QA 184).
import { describe, expect, test } from "vitest";
import { recreatedObjects } from "../../../src/sql-analysis/index.ts";

/** A unit `label` holding one schema-change file with `text`. */
function unit(label: string, text: string) {
  return {
    label,
    files: [{ path: `data-model/migrations/${label}/schema-change.sql`, text }],
  };
}

describe("recreatedObjects", () => {
  test("names each object dropped and created again by its DROP, schema-qualified, once", async () => {
    expect(
      await recreatedObjects(
        [
          unit(
            "00002-wider-total",
            `DROP VIEW "app"."order_totals";
DROP FUNCTION "app"."order_count"(bigint, text[]);
ALTER TABLE "app"."orders" ALTER COLUMN total TYPE numeric(12,2);
CREATE VIEW "app"."order_totals" AS SELECT 1;
CREATE OR REPLACE FUNCTION "app"."order_count"(cid bigint) RETURNS bigint LANGUAGE sql AS $$ select 1::bigint $$;
DROP VIEW "app"."order_totals";
CREATE VIEW "app"."order_totals" AS SELECT 2;`,
          ),
        ],
        "app",
      ),
    ).toEqual([
      {
        family: "relation",
        identity: '"app"."order_totals"',
        droppedBy: "00002-wider-total",
        createdBy: "00002-wider-total",
      },
      {
        family: "routine",
        identity: '"app"."order_count"("pg_catalog"."int8", "text"[])',
        droppedBy: "00002-wider-total",
        createdBy: "00002-wider-total",
      },
    ]);
  });

  test("a routine is recreated whatever its new arguments, and one dropped without its argument types is named without them", async () => {
    expect(
      await recreatedObjects(
        [
          unit(
            "00002-retype",
            `drop function order_count(int);
create function order_count(text) returns int language sql as $$ select 1 $$;
drop function customer_count;
create function customer_count(since bigint) returns int language sql as $$ select 1 $$;`,
          ),
        ],
        "app",
      ),
    ).toEqual([
      {
        family: "routine",
        identity: '"app"."order_count"("pg_catalog"."int4")',
        droppedBy: "00002-retype",
        createdBy: "00002-retype",
      },
      {
        family: "routine",
        identity: '"app"."customer_count"',
        droppedBy: "00002-retype",
        createdBy: "00002-retype",
      },
    ]);
  });

  test("an object dropped in one unit and created in a later one names both; a drop nothing creates again, another schema's objects and objects without privileges are left out", async () => {
    expect(
      await recreatedObjects(
        [
          unit(
            "00002-drop",
            `drop table customers;
drop domain email;
drop view old_report;
drop table other.things;
drop index customers_name;`,
          ),
          unit(
            "00003-create",
            `create table customers (id bigint);
create table other.things (id bigint);
create index customers_name on customers (id);
create domain email as text;`,
          ),
        ],
        "app",
      ),
    ).toEqual([
      {
        family: "relation",
        identity: '"app"."customers"',
        droppedBy: "00002-drop",
        createdBy: "00003-create",
      },
      {
        family: "type",
        identity: '"app"."email"',
        droppedBy: "00002-drop",
        createdBy: "00003-create",
      },
    ]);
  });

  test("an object created before it is dropped isn't recreated", async () => {
    expect(
      await recreatedObjects(
        [unit("00002-swap", "create view v as select 1;\ndrop view v;")],
        "app",
      ),
    ).toEqual([]);
  });
});
