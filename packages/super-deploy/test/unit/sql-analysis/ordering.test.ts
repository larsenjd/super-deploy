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
});
