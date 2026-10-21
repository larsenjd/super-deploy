// Destructive statements and lock warnings at the SQL-analysis seam
// (database-free): what finalize must have acknowledged, and what it warns
// will rewrite or scan an existing table while holding its lock.
import { describe, expect, test } from "vitest";
import {
  analyseMigration,
  columnTypesOf,
  type DeployTimeKind,
  parseSqlFile,
} from "../../../src/sql-analysis/index.ts";

const paths: Record<DeployTimeKind, string> = {
  "schema-change": "data-model/draft/schema-change.sql",
  "pre-migration": "data-model/draft/pre-migration.sql",
  "post-migration": "data-model/draft/post-migration.sql",
  "seed-data": "data-model/draft/seed-data.sql",
};

/** The desired schema before the migration: column types for lossy type changes. */
const before = `create table t (
  id bigint primary key,
  name varchar(100),
  code char(4),
  price numeric(10,2),
  qty integer,
  small smallint,
  ratio real,
  big bigint,
  note text,
  at timestamp(3),
  tags varchar(20)[],
  amount public.amount
);
create table other (id integer primary key);
`;

async function analyse(
  files: readonly (readonly [DeployTimeKind, string])[],
  previous = before,
) {
  const parsed = await parseSqlFile({
    path: "data-model/migrations/00001-x/desired-schema/schema.sql",
    text: previous,
  });
  if (!parsed.ok) {
    throw new Error(parsed.violation.message);
  }
  return analyseMigration(
    files.map(([kind, text]) => ({ path: paths[kind], text, kind })),
    { columnTypes: columnTypesOf(parsed.statements) },
  );
}

/** Kinds of the destructive findings in a schema change. */
async function destructiveKinds(sql: string) {
  return (await analyse([["schema-change", sql]])).destructive.map(
    (d) => d.kind,
  );
}

describe("destructive statements", () => {
  test("DROP TABLE is destructive and records the file, line and statement", async () => {
    const analysis = await analyse([
      ["schema-change", 'create table x (id int);\nDROP TABLE "public"."t";\n'],
    ]);
    expect(analysis.destructive).toEqual([
      {
        file: paths["schema-change"],
        line: 2,
        statement: 'DROP TABLE "public"."t"',
        kind: "drop",
        message: expect.stringMatching(/^DROP TABLE public\.t /),
      },
    ]);
  });

  test("creating and altering are not destructive", async () => {
    expect(
      await destructiveKinds(`create table x (id int primary key);
alter table t add column extra jsonb;
alter table t alter column name drop default;
alter table t alter column name drop not null;
create index t_name_idx on t (name);
comment on table t is 'tee';`),
    ).toEqual([]);
  });

  test.each([
    ["drop view v", "drop"],
    ["drop materialized view mv", "drop"],
    ["drop index t_a_idx", "drop"],
    ['DROP FUNCTION "public"."f"(integer)', "drop"],
    ["drop procedure p(int)", "drop"],
    ['DROP TRIGGER "t_upper" ON "public"."t"', "drop"],
    ["drop domain positive_int", "drop"],
    ["drop type address", "drop"],
    ['ALTER TABLE "public"."t" DROP CONSTRAINT "t_qty_check"', "drop"],
    ["alter domain positive_int drop constraint positive_int_check", "drop"],
    ['ALTER TABLE "public"."t" DROP COLUMN "price"', "drop-column"],
    ['ALTER TYPE "public"."address" DROP ATTRIBUTE "zip"', "drop-column"],
  ])("%s is destructive (%s)", async (sql, kind) => {
    expect(await destructiveKinds(sql)).toEqual([kind]);
  });
});

describe("drops that lose nothing", () => {
  test.each([
    [
      "a view changed by drop and create",
      `DROP VIEW "public"."v";\nCREATE VIEW "public"."v" AS SELECT id FROM public.t;`,
    ],
    [
      "a materialized view and its index",
      `DROP MATERIALIZED VIEW "public"."mv";
CREATE MATERIALIZED VIEW "public"."mv" AS SELECT qty, count(*) AS n FROM public.t GROUP BY qty;
CREATE INDEX mv_a_idx ON public.mv USING btree (qty);`,
    ],
    [
      "an index",
      `DROP INDEX "public"."t_a_idx";\nCREATE UNIQUE INDEX t_a_idx ON public.t USING btree (qty);`,
    ],
    [
      "a function with the same arguments",
      `DROP FUNCTION "public"."h"(integer);
CREATE OR REPLACE FUNCTION public.h(x int) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ select x $$;`,
    ],
    [
      "a trigger",
      `DROP TRIGGER "t_upper" ON "public"."t";
CREATE TRIGGER t_upper BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.tf();`,
    ],
    [
      "a constraint",
      `ALTER TABLE "public"."t" DROP CONSTRAINT "t_qty_check";
ALTER TABLE "public"."t" ADD CONSTRAINT "t_qty_check" CHECK ((qty >= 0));`,
    ],
    [
      "a domain constraint",
      `ALTER DOMAIN "public"."positive_int" DROP CONSTRAINT "positive_int_check";
ALTER DOMAIN "public"."positive_int" ADD CONSTRAINT "positive_int_check" CHECK ((VALUE > 0));`,
    ],
    [
      "a domain",
      `DROP DOMAIN public.amount;\nCREATE DOMAIN public.amount AS numeric(14,2);`,
    ],
    [
      "objects this migration created earlier",
      `create table x (id int primary key, a int);
create index x_a_idx on x (a);
alter table x add constraint x_a_check check (a > 0);
alter table x drop constraint x_a_check;
drop index x_a_idx;
alter table x drop column a;
drop table x;`,
    ],
  ])("%s", async (_name, sql) => {
    expect(await destructiveKinds(sql)).toEqual([]);
  });

  test("a function created with other arguments still drops the old one", async () => {
    expect(
      await destructiveKinds(`DROP FUNCTION "public"."h"(integer);
CREATE OR REPLACE FUNCTION public.h(x integer, y integer DEFAULT 0) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ select (x + y)::bigint $$;`),
    ).toEqual(["drop"]);
  });

  test("a table or column dropped and created again has lost its data", async () => {
    expect(
      await destructiveKinds(`DROP TABLE "public"."t";
CREATE TABLE "public"."t" ("id" bigint NOT NULL);
ALTER TABLE "public"."other" DROP COLUMN "id";
ALTER TABLE "public"."other" ADD COLUMN "id" integer;`),
    ).toEqual(["drop", "drop-column"]);
  });

  test("dropping a table covers what was dropped from it first", async () => {
    const analysis = await analyse([
      [
        "schema-change",
        `ALTER TABLE "public"."t" DROP CONSTRAINT "t_other_fk";
ALTER TABLE "public"."t" DROP COLUMN "note";
ALTER TABLE "public"."other" DROP CONSTRAINT "other_t_fk";
DROP TABLE "public"."t";`,
      ],
    ]);
    expect(analysis.destructive.map((d) => d.line)).toEqual([3, 4]);
  });

  test("CASCADE is destructive even when the object is created again", async () => {
    const analysis = await analyse([
      [
        "schema-change",
        `drop view v cascade;\ncreate view v as select id from t;`,
      ],
    ]);
    expect(analysis.destructive).toEqual([
      expect.objectContaining({
        kind: "drop",
        message: expect.stringContaining("CASCADE"),
      }),
    ]);
  });

  test("a pre-migration script's table can be dropped by the schema change", async () => {
    expect(
      (
        await analyse([
          ["pre-migration", "create table staging (id int);"],
          ["schema-change", "drop table staging;"],
        ])
      ).destructive,
    ).toEqual([]);
  });
});

describe("column type changes", () => {
  const change = (column: string, type: string, using = "") =>
    `ALTER TABLE "public"."t" ALTER COLUMN "${column}" TYPE ${type}${using === "" ? "" : ` USING ${using}`}`;

  test.each([
    ["qty", "bigint", '"qty"::bigint'],
    ["small", "integer", ""],
    ["small", "real", ""],
    ["qty", "double precision", ""],
    ["ratio", "double precision", ""],
    ["qty", "numeric", ""],
    ["qty", "numeric(12,0)", ""],
    ["big", "numeric(19)", ""],
    ["price", "numeric(12,2)", '"price"::numeric(12,2)'],
    ["price", "numeric(11,3)", ""],
    ["price", "numeric", ""],
    ["name", "character varying(200)", '"name"::character varying(200)'],
    ["name", "varchar", ""],
    ["name", "text", ""],
    ["note", "varchar", ""],
    ["code", "char(10)", ""],
    ["at", "timestamp(6)", ""],
    ["at", "timestamp", ""],
    ["tags", "varchar(40)[]", ""],
    ["tags", "text[]", ""],
    ["amount", "public.amount", ""],
  ])("%s to %s is a widening, not destructive", async (column, type, using) => {
    expect(await destructiveKinds(change(column, type, using))).toEqual([]);
  });

  test.each([
    ["qty", "smallint"],
    ["big", "integer"],
    ["big", "double precision"],
    ["qty", "real"],
    ["qty", "numeric(5)"],
    ["ratio", "integer"],
    ["price", "integer"],
    ["price", "numeric(10,3)"],
    ["name", "varchar(50)"],
    ["note", "varchar(50)"],
    ["code", "text"],
    ["code", "char(2)"],
    ["at", "timestamp(0)"],
    ["at", "timestamptz"],
    ["tags", "varchar(10)[]"],
    ["tags", "text"],
    ["note", "public.amount"],
    ["amount", "numeric"],
    ["id", "uuid"],
  ])("%s to %s can lose data", async (column, type) => {
    const analysis = await analyse([["schema-change", change(column, type)]]);
    expect(analysis.destructive).toEqual([
      expect.objectContaining({
        kind: "lossy-type-change",
        message: expect.stringContaining("can lose data"),
      }),
    ]);
  });

  test("a USING expression that computes new values can lose data", async () => {
    expect(
      await destructiveKinds(change("qty", "bigint", "qty * 100")),
    ).toEqual(["lossy-type-change"]);
  });

  test("a column whose current type is unknown counts as lossy", async () => {
    expect(await destructiveKinds(change("unknown", "bigint"))).toEqual([
      "lossy-type-change",
    ]);
  });

  test("the migration's own earlier changes give the current type", async () => {
    expect(
      (
        await analyse([
          [
            "pre-migration",
            `alter table t alter column qty type bigint;
alter table t add column extra smallint;
alter table t rename column name to title;`,
          ],
          [
            "schema-change",
            `alter table t alter column qty type numeric;
alter table t alter column extra type integer;
alter table t alter column title type text;`,
          ],
        ])
      ).destructive,
    ).toEqual([]);
  });

  test("a column of a table this migration created can change type freely", async () => {
    expect(
      await destructiveKinds(`create table x (a numeric(10,2));
alter table x alter column a type integer;`),
    ).toEqual([]);
  });
});

describe("narrowing type changes", () => {
  const previous = `create table customers (
  display_name text,
  title varchar(100),
  code varchar(10),
  short varchar(5),
  flags bit(4),
  cost numeric(6,2)
);
`;
  /** A type change as pg-delta generates it: always `USING col::newtype`. */
  const generated = (column: string, type: string) =>
    `ALTER TABLE "public"."customers" ALTER COLUMN "${column}" TYPE ${type} USING "${column}"::${type};`;
  const destructive = async (sql: string) =>
    (await analyse([["schema-change", sql]], previous)).destructive;

  test.each([
    [
      "display_name",
      "character varying(5)",
      "customers.display_name narrows from text to varchar(5): values longer than 5 characters are cut to 5 on every target, without an error",
    ],
    [
      "title",
      "character varying(10)",
      "customers.title narrows from varchar(100) to varchar(10): values longer than 10 characters are cut to 10 on every target, without an error",
    ],
    [
      "code",
      "character(3)",
      "customers.code narrows from varchar(10) to char(3): values longer than 3 characters are cut to 3 on every target, without an error",
    ],
    [
      "flags",
      "bit(2)",
      "customers.flags narrows from bit(4) to bit(2): values longer than 2 bits are cut to 2 on every target, without an error",
    ],
    [
      "cost",
      "numeric(5,1)",
      "customers.cost narrows from numeric(6,2) to numeric(5,1): values are rounded to 1 decimal place on every target, without an error",
    ],
    [
      "cost",
      "numeric(4,1)",
      "customers.cost narrows from numeric(6,2) to numeric(4,1): values are rounded to 1 decimal place on every target, without an error, and values too large for numeric(4,1) make the deployment fail",
    ],
  ])("%s to %s is a narrowing", async (column, type, message) => {
    expect(await destructive(generated(column, type))).toEqual([
      expect.objectContaining({ kind: "lossy-type-change", message }),
    ]);
  });

  test("a type change whose cast fails rather than shortens keeps the plain loss reason", async () => {
    expect(await destructive(generated("display_name", "integer"))).toEqual([
      expect.objectContaining({
        kind: "lossy-type-change",
        message: expect.stringContaining(
          "can lose data: not every text value fits int4 unchanged",
        ),
      }),
    ]);
  });

  test("without USING, an over-long string is refused rather than cut, but a numeric is still rounded", async () => {
    const plain = (column: string, type: string) =>
      `ALTER TABLE "public"."customers" ALTER COLUMN "${column}" TYPE ${type};`;
    expect(
      await destructive(plain("display_name", "character varying(5)")),
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(
          "can lose data: not every text value fits varchar(5) unchanged",
        ),
      }),
    ]);
    expect(await destructive(plain("cost", "numeric(6,0)"))).toEqual([
      expect.objectContaining({
        message:
          "customers.cost narrows from numeric(6,2) to numeric(6,0): values are rounded to whole numbers on every target, without an error",
      }),
    ]);
  });

  test("a widening is no narrowing, and not destructive", async () => {
    expect(
      await destructive(generated("short", "character varying(10)")),
    ).toEqual([]);
  });
});

describe("columns pg-delta replaces to change them (QA 103)", () => {
  const previous = `create table customers (id bigint primary key, nickname text, note text);
create table a (
  id bigint primary key,
  price numeric(10,2) not null,
  qty integer not null,
  total numeric generated always as (price * qty) stored
);
`;
  const messages = async (sql: string) =>
    (await analyse([["schema-change", sql]], previous)).destructive.map(
      ({ kind, line, message }) => ({ kind, line, message }),
    );

  test("a collation change names the replaced column and the in-place statement keeping its values", async () => {
    expect(
      await messages(`DROP INDEX "public"."customers_nick_idx";
ALTER TABLE "public"."customers" DROP COLUMN "nickname";
ALTER TABLE "public"."customers" ADD COLUMN "nickname" text COLLATE pg_catalog."C";
CREATE INDEX customers_nick_idx ON public.customers USING btree (nickname);
`),
    ).toEqual([
      {
        kind: "drop-column",
        line: 2,
        message:
          'public.customers.nickname is dropped and re-added to change its collation: its values are lost. To keep them, change it in place in the pre-migration script: ALTER TABLE "public"."customers" ALTER COLUMN "nickname" TYPE text COLLATE pg_catalog."C"',
      },
    ]);
  });

  test('a collation change back to the default names COLLATE "default"', async () => {
    const [found] =
      await messages(`ALTER TABLE "public"."customers" DROP COLUMN "note";
ALTER TABLE "public"."customers" ADD COLUMN "note" text;
`);
    expect(found?.message).toContain(
      'ALTER TABLE "public"."customers" ALTER COLUMN "note" TYPE text COLLATE "default"',
    );
  });

  test("a generation expression change names the replaced column and SET EXPRESSION", async () => {
    expect(
      await messages(`ALTER TABLE "public"."a" DROP COLUMN "total";
ALTER TABLE "public"."a" ADD COLUMN "total" numeric GENERATED ALWAYS AS (((price * (qty)::numeric) * 1.2)) STORED;
`),
    ).toEqual([
      {
        kind: "drop-column",
        line: 1,
        message:
          'public.a.total is dropped and re-added to change its generation expression: its values are computed again, but it moves to the end of the table and finalize needs the drop acknowledged. To avoid both, change it in place in the pre-migration script: ALTER TABLE "public"."a" ALTER COLUMN "total" SET EXPRESSION AS (((price * (qty)::numeric) * 1.2))',
      },
    ]);
  });

  test("a generated column made plain names DROP EXPRESSION, which keeps its values", async () => {
    expect(
      await messages(`ALTER TABLE "public"."a" DROP COLUMN "total";
ALTER TABLE "public"."a" ADD COLUMN "total" numeric;
`),
    ).toEqual([
      {
        kind: "drop-column",
        line: 1,
        message:
          'public.a.total is dropped and re-added to stop generating it: its values are lost. To keep them, change it in place in the pre-migration script: ALTER TABLE "public"."a" ALTER COLUMN "total" DROP EXPRESSION',
      },
    ]);
  });

  test("a plain column made generated keeps the plain message: nothing changes it in place", async () => {
    expect(
      await messages(`ALTER TABLE "public"."customers" DROP COLUMN "note";
ALTER TABLE "public"."customers" ADD COLUMN "note" text GENERATED ALWAYS AS (nickname) STORED;
`),
    ).toEqual([
      {
        kind: "drop-column",
        line: 1,
        message:
          "ALTER TABLE public.customers DROP COLUMN note drops the column and its data",
      },
    ]);
  });

  test("dropping one column and adding another, or the same name with another type, keeps the plain message", async () => {
    expect(
      await messages(`ALTER TABLE "public"."customers" DROP COLUMN "note";
ALTER TABLE "public"."customers" ADD COLUMN "memo" text;
ALTER TABLE "public"."customers" DROP COLUMN "nickname";
ALTER TABLE "public"."customers" ADD COLUMN "nickname" integer;
`),
    ).toEqual([
      {
        kind: "drop-column",
        line: 1,
        message:
          "ALTER TABLE public.customers DROP COLUMN note drops the column and its data",
      },
      {
        kind: "drop-column",
        line: 3,
        message:
          "ALTER TABLE public.customers DROP COLUMN nickname drops the column and its data",
      },
    ]);
  });
});

describe("deleting data", () => {
  test.each([
    ["delete from t where qty = 0", ["delete"]],
    ["delete from public.t", ["delete"]],
    ["truncate t, other", ["truncate", "truncate"]],
    [
      "merge into t using other on other.id = t.id when matched then delete",
      ["delete"],
    ],
    [
      "merge into t using other on other.id = t.id when matched then update set qty = 1",
      [],
    ],
    ["update t set qty = 0", []],
    ["insert into t (id) values (1)", []],
  ])("%s", async (sql, kinds) => {
    const analysis = await analyse([["post-migration", sql]]);
    expect(analysis.destructive.map((d) => d.kind)).toEqual(kinds);
    expect(analysis.violations).toEqual([]);
  });

  test("deleting from the migration's own temporary or new tables loses nothing", async () => {
    const analysis = await analyse([
      [
        "pre-migration",
        `create temp table staging (id int) on commit drop;
create table fresh (id int);
insert into staging (id) select id from t;
delete from staging where id < 0;`,
      ],
      [
        "post-migration",
        `delete from pg_temp.staging;
truncate staging;
delete from fresh;
truncate fresh;`,
      ],
    ]);
    expect(analysis.violations).toEqual([]);
    expect(analysis.destructive).toEqual([]);
  });

  test("the message names the table", async () => {
    const analysis = await analyse([["post-migration", "truncate t"]]);
    expect(analysis.destructive[0]?.message).toBe(
      "TRUNCATE t deletes every row in t",
    );
  });
});

describe("lock warnings", () => {
  async function warningKinds(kind: DeployTimeKind, sql: string) {
    return (await analyse([[kind, sql]])).warnings.map((w) => w.kind);
  }

  test("a warning records the file, line, statement and table", async () => {
    const analysis = await analyse([
      [
        "schema-change",
        'create table x (id int);\nALTER TABLE "public"."t" ALTER COLUMN "qty" SET NOT NULL;',
      ],
    ]);
    expect(analysis.warnings).toEqual([
      {
        file: paths["schema-change"],
        line: 2,
        statement: 'ALTER TABLE "public"."t" ALTER COLUMN "qty" SET NOT NULL',
        kind: "set-not-null",
        object: "t",
        message: expect.stringMatching(
          /^ALTER TABLE public\.t ALTER COLUMN qty SET NOT NULL scans every row of t, .*until the deployment commits/,
        ),
      },
    ]);
  });

  test.each([
    ['ALTER TABLE "public"."t" ALTER COLUMN "qty" TYPE bigint', "type-change"],
    [
      "alter table t add column u uuid default gen_random_uuid()",
      "volatile-default",
    ],
    [
      "alter table t add column at2 timestamptz default clock_timestamp()",
      "volatile-default",
    ],
    [
      "alter table t add column r float8 not null default random()",
      "volatile-default",
    ],
    [
      "alter table t add column v int default public.next_value()",
      "volatile-default",
    ],
    [
      "alter table t add column n bigint generated always as identity",
      "computed-column",
    ],
    [
      "alter table t add column g int generated always as (qty * 2) stored",
      "computed-column",
    ],
    [
      "alter table t alter column g set expression as (qty * 3)",
      "computed-column",
    ],
    ["alter table t alter column qty set not null", "set-not-null"],
    [
      "alter table t add constraint t_qty_check check (qty > 0)",
      "constraint-validation",
    ],
    [
      "alter table t add constraint t_other_fk foreign key (qty) references other (id)",
      "constraint-validation",
    ],
    [
      "alter table t add constraint t_qty_key unique (qty)",
      "constraint-validation",
    ],
    [
      "alter table t add constraint t_qty_nn not null qty",
      "constraint-validation",
    ],
    ["alter table t validate constraint t_qty_check", "constraint-validation"],
    ["alter table t add column c int check (c > 0)", "constraint-validation"],
    [
      "alter table t add column o int references other (id)",
      "constraint-validation",
    ],
    [
      "alter domain amount add constraint amount_check check (value > 0)",
      "constraint-validation",
    ],
    ["alter domain amount set not null", "constraint-validation"],
    ["create index t_qty_idx on t (qty)", "create-index"],
    [
      "create unique index t_name_idx on public.t (lower(name))",
      "create-index",
    ],
  ])("%s warns (%s)", async (sql, kind) => {
    expect(await warningKinds("schema-change", sql)).toEqual([kind]);
  });

  test("TRUNCATE warns about every existing table it empties", async () => {
    expect(await warningKinds("post-migration", "truncate t, other")).toEqual([
      "truncate",
      "truncate",
    ]);
  });

  test.each([
    "alter table t add column extra jsonb",
    "alter table t add column qty2 int not null default 1",
    "alter table t add column at2 timestamptz default now()",
    "alter table t add column s text default 'x' || 'y'",
    "alter table t alter column qty set default random()",
    "alter table t alter column qty drop not null",
    "alter table t add constraint t_qty_check check (qty > 0) not valid",
    "alter table t add constraint t_other_fk foreign key (qty) references other (id) not valid",
    "alter table t drop column note",
    "alter domain amount add constraint amount_check check (value > 0) not valid",
    "drop index t_qty_idx",
    "create view v as select id from t",
  ])("%s does not warn", async (sql) => {
    expect(await warningKinds("schema-change", sql)).toEqual([]);
  });

  test("volatile functions in data changes do not warn", async () => {
    expect(
      await warningKinds(
        "post-migration",
        "update t set note = gen_random_uuid()::text, at = clock_timestamp() where random() < 2",
      ),
    ).toEqual([]);
  });

  test("tables, materialized views and domains created in the same migration are exempt", async () => {
    const analysis = await analyse([
      [
        "pre-migration",
        `create table fresh (id int, qty int);
alter table fresh add column u uuid default gen_random_uuid();
create temp table staging (id int) on commit drop;`,
      ],
      [
        "schema-change",
        `alter table fresh alter column qty type bigint;
alter table fresh alter column qty set not null;
alter table fresh add constraint fresh_pkey primary key (id);
create index fresh_qty_idx on fresh (qty);
create materialized view mv as select qty from t;
create index mv_qty_idx on mv (qty);
create domain d as int;
alter domain d add constraint d_check check (value > 0);`,
      ],
      ["post-migration", "truncate fresh, staging;"],
    ]);
    expect(analysis.violations).toEqual([]);
    expect(analysis.warnings).toEqual([]);
  });
});
