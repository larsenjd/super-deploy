// Ordering at the SQL-analysis seam (database-free): the order statements
// load in, the errors reported before anything loads, and invariance under
// file renames and statement reordering.
import { describe, expect, test } from "vitest";
import {
  alternativeOrder,
  type OrderingResult,
  orderDesiredSchema,
  parseSqlFile,
  type SqlFile,
} from "../../../src/sql-analysis/index.ts";
import { orderingFixtures } from "../../fixtures/ordering.ts";

const dir = "data-model/desired-schema";

function files(byName: Readonly<Record<string, string>>): SqlFile[] {
  return Object.entries(byName).map(([name, text]) => ({
    path: `${dir}/${name}`,
    text,
  }));
}

async function order(
  byName: Readonly<Record<string, string>>,
  options?: { managedSchema?: string },
): Promise<string[]> {
  const result = await orderDesiredSchema(files(byName), options);
  expect(result.errors).toEqual([]);
  return result.statements.map((statement) => statement.text);
}

async function errorsOf(
  byName: Readonly<Record<string, string>>,
  options?: { managedSchema?: string },
): Promise<OrderingResult["errors"]> {
  const result = await orderDesiredSchema(files(byName), options);
  expect(result.statements).toEqual([]);
  return result.errors;
}

/** Every statement in its own file, with scrambled names, in reverse order. */
async function scrambled(
  byName: Readonly<Record<string, string>>,
): Promise<SqlFile[]> {
  const texts: string[] = [];
  for (const file of files(byName).sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const parsed = await parseSqlFile(file);
    if (!parsed.ok) throw new Error(parsed.violation.message);
    texts.push(...parsed.statements.map((s) => s.text));
  }
  let seed = 7;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed.toString(36);
  };
  return texts.reverse().map((text, index) => ({
    path: `${dir}/${random()}/${index % 3 === 0 ? "z" : "a"}${random()}.sql`,
    text: `${text};\n`,
  }));
}

describe("ordering fixtures", () => {
  const accepted = orderingFixtures.filter((f) => f.errors === undefined);
  const refused = orderingFixtures.filter((f) => f.errors !== undefined);

  test.each(accepted.map((f) => [f.name, f] as const))(
    "%s",
    async (_name, fixture) => {
      const result = await orderDesiredSchema(files(fixture.files));
      expect(result.errors).toEqual([]);
      const texts = result.statements.map((s) => s.text);
      const alternative = alternativeOrder(result.statements).map(
        (s) => s.text,
      );

      expect([...alternative].sort()).toEqual([...texts].sort());
      for (const order of [texts, alternative]) {
        const position = (part: string) => {
          const found = order.filter((t) => t.includes(part));
          expect(
            found,
            `one statement contains ${JSON.stringify(part)}`,
          ).toHaveLength(1);
          return order.indexOf(found[0] as string);
        };
        for (const [earlier, later] of fixture.before ?? []) {
          expect(position(earlier), `${earlier} before ${later}`).toBeLessThan(
            position(later),
          );
        }
      }
      const renamed = await orderDesiredSchema(await scrambled(fixture.files));
      expect(renamed.errors).toEqual([]);
      expect(renamed.statements.map((s) => s.text)).toEqual(texts);
    },
  );

  test.each(refused.map((f) => [f.name, f] as const))(
    "%s",
    async (_name, fixture) => {
      const errors = await errorsOf(fixture.files);

      expect(errors.map((e) => [e.file, e.line, e.rule])).toEqual(
        (fixture.errors ?? []).map((e) => [`${dir}/${e.file}`, e.line, e.rule]),
      );
      for (const [index, expected] of (fixture.errors ?? []).entries()) {
        for (const part of expected.message ?? []) {
          expect(errors[index]?.message).toContain(part);
        }
      }
    },
  );
});

describe("ordering", () => {
  test("creates a referenced table first, whatever the file names", async () => {
    const texts = await order({
      "a_orders.sql":
        "create table orders (id int primary key, customer_id int constraint orders_customer_fk references customers (id))",
      "b_customers.sql": "create table customers (id int primary key)",
    });

    expect(texts).toEqual([
      "create table customers (id int primary key)",
      "create table orders (id int primary key, customer_id int constraint orders_customer_fk references customers (id))",
    ]);
  });

  test("breaks ties by kind, then identity, never by file name", async () => {
    const texts = await order({
      "z.sql":
        "create table alpha (id int);\ncreate view beta as select 1 as one;\n",
      "a.sql":
        "create table gamma (id int);\ncreate function delta() returns int language sql immutable return 1;\ncomment on table alpha is 'a';\n",
    });

    expect(texts).toEqual([
      "create table alpha (id int)",
      "create table gamma (id int)",
      "create function delta() returns int language sql immutable return 1",
      "create view beta as select 1 as one",
      "comment on table alpha is 'a'",
    ]);
  });

  test("resolves names qualified with the managed schema, and only there", async () => {
    const texts = await order(
      {
        "a.sql": "create view v as select id from app.customers;\n",
        "b.sql": "create table customers (id int primary key);\n",
      },
      { managedSchema: "app" },
    );
    expect(texts[0]).toBe("create table customers (id int primary key)");

    expect(
      await errorsOf(
        { "a.sql": "create view v as select app.now() as t;\n" },
        { managedSchema: "app" },
      ),
    ).toMatchObject([
      {
        rule: "unknown-reference",
        message: expect.stringContaining("function app.now"),
      },
    ]);
  });

  test("leaves references to other schemas to the rules", async () => {
    expect(
      await order({
        "a.sql":
          "create view v as select table_name from information_schema.tables;\n",
      }),
    ).toHaveLength(1);
  });
});

describe("IF NOT EXISTS and OR REPLACE", () => {
  // Each statement in its own file, named against the dependency order.
  const rerunnable = {
    "a.sql":
      "create or replace trigger t_touch before insert on t for each row execute function touch()",
    "b.sql": "create materialized view if not exists mv as select b from v",
    "c.sql": "create or replace view v as select plus_one(a) as b from t",
    "d.sql":
      "create or replace procedure add_row(x int) language sql as $$ insert into t (id, a) values (x, x) $$",
    "e.sql":
      "create or replace function plus_one(x int) returns int language sql immutable return x + 1",
    "f.sql":
      "create or replace function touch() returns trigger language plpgsql as $$ begin return new; end $$",
    "g.sql": "create index if not exists t_a_idx on t (a)",
    "h.sql":
      "create table if not exists t (id int constraint t_pkey primary key, a int)",
  };
  const plain = (sql: string) =>
    sql.replace(/ (if not exists|or replace)/g, "");

  test("orders each form like the same statement without the clause", async () => {
    const withClauses = await order(rerunnable);
    const without = await order(
      Object.fromEntries(
        Object.entries(rerunnable).map(([name, sql]) => [name, plain(sql)]),
      ),
    );

    expect(withClauses.map(plain)).toEqual(without);
  });

  const table = "create table t (id int, a int);\n";
  const tf =
    "create function tf() returns trigger language plpgsql as $$ begin return new; end $$;\n";
  // [form, setup, two different definitions of one object, the object]
  test.each([
    [
      "create table if not exists",
      "",
      "create table t (id int)",
      "create table t (id bigint)",
      "Relation t",
    ],
    [
      "create index if not exists",
      table,
      "create index t_a_idx on t (a)",
      "create index t_a_idx on t (id, a)",
      "Relation t_a_idx",
    ],
    [
      "create materialized view if not exists",
      "",
      "create materialized view mv as select 1 as a",
      "create materialized view mv as select 2 as a",
      "Relation mv",
    ],
    [
      "create or replace view",
      "",
      "create view v as select 1 as a",
      "create view v as select 2 as a",
      "Relation v",
    ],
    [
      "create or replace function",
      "",
      "create function f(x int) returns int language sql immutable return x",
      "create function f(x int) returns int language sql immutable return x + 1",
      "Routine f(int4)",
    ],
    [
      "create or replace procedure",
      "",
      "create procedure p(x int) language sql as $$ select x $$",
      "create procedure p(x int) language sql as $$ select x + 1 $$",
      "Routine p(int4)",
    ],
    [
      "create or replace trigger",
      table + tf,
      "create trigger tr before insert on t for each row execute function tf()",
      "create trigger tr before update on t for each row execute function tf()",
      "Trigger t.tr",
    ],
  ])(
    "%s defining an object twice is a duplicate-object, whichever statements carry the clause",
    async (form, setup, one, two, object) => {
      const withClause = (sql: string) => sql.replace(plain(form), form);
      expect(withClause(one)).toMatch(new RegExp(`^${form} `));
      expect(withClause(two)).toMatch(new RegExp(`^${form} `));
      for (const [first, second] of [
        [withClause(one), two],
        [one, withClause(two)],
        [withClause(one), withClause(two)],
      ]) {
        const errors = await errorsOf({
          "a.sql": `${setup}${first};\n`,
          "b.sql": `${second};\n`,
        });
        expect(errors, `${first}; ${second}`).toMatchObject([
          {
            file: `${dir}/b.sql`,
            rule: "duplicate-object",
            message: expect.stringContaining(
              `${object} is created more than once`,
            ),
          },
        ]);
      }
    },
  );
});
