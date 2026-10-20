// The override marker (`-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>`) at the
// SQL-analysis seam (database-free): which rules it overrides, where it must
// be written, and the override records reviewers see.
import { describe, expect, test } from "vitest";
import {
  analyseMigration,
  carryOverrides,
  checkRules,
  desiredSchemaAnalysis,
} from "../../../src/sql-analysis/index.ts";

const desiredPath = "data-model/desired-schema/loaders.sql";

const loader = (
  marker: string,
) => `create table staging (id bigint primary key);

${marker}
create function load_staging(source text) returns void
language plpgsql as $$
begin
  execute format('insert into staging select * from %s', source);
end
$$;
`;

describe("desired schema", () => {
  test("a marker overrides dynamic SQL in a PL/pgSQL loader and is recorded with its object", async () => {
    const file = {
      path: desiredPath,
      text: loader(
        "-- OVERRIDE SUPER-DEPLOY REFUSAL: loads tables named by the caller",
      ),
    };
    expect(await checkRules(file, "desired-schema")).toEqual([]);
    const analysis = await desiredSchemaAnalysis([file]);
    expect(analysis.overrides).toEqual([
      {
        file: desiredPath,
        line: 3,
        object: "function load_staging(text)",
        rules: ["plpgsql-dynamic-sql"],
        reason: "loads tables named by the caller",
      },
    ]);
  });
});

/** [line, rule] of every violation. */
async function broken(text: string, kind: "desired-schema" = "desired-schema") {
  return (await checkRules({ path: desiredPath, text }, kind)).map((v) => [
    v.line,
    v.rule,
  ]);
}

const marker = "-- OVERRIDE SUPER-DEPLOY REFUSAL: justified";

describe("transaction-breaking rules are never overridden", () => {
  test("COMMIT in a PL/pgSQL body still fails, and the marker is reported as unable to override it", async () => {
    const violations = await checkRules(
      {
        path: desiredPath,
        text: `${marker}
create procedure batch() language plpgsql as $$
begin
  commit;
end
$$;
`,
      },
      "desired-schema",
    );
    expect(violations.map((v) => [v.line, v.rule])).toEqual([
      [4, "plpgsql-transaction-control"],
      [1, "override-unused"],
    ]);
    expect(violations[1]?.message).toBe(
      "The override marker cannot override plpgsql-transaction-control: only risk rules (denylisted-call, plpgsql-dynamic-sql) can be overridden",
    );
  });

  test("a statement with both kinds keeps its transaction violation but overrides its risk one", async () => {
    const text = `${marker}
create function mixed() returns void language plpgsql as $$
begin
  execute 'select 1';
  commit;
end
$$;
`;
    expect(await broken(text)).toEqual([[5, "plpgsql-transaction-control"]]);
  });
});

describe("where the marker goes", () => {
  const dynamic = `create function f() returns void language plpgsql as $$
begin
  execute 'select 1';
end
$$;`;

  test.each([
    [
      "no reason",
      "-- OVERRIDE SUPER-DEPLOY REFUSAL:",
      "override-without-reason",
    ],
    [
      "a blank reason",
      "-- OVERRIDE SUPER-DEPLOY REFUSAL:   ",
      "override-without-reason",
    ],
    [
      "lower case",
      "-- override super-deploy refusal: justified",
      "override-malformed",
    ],
    [
      "no space after --",
      "--OVERRIDE SUPER-DEPLOY REFUSAL: justified",
      "override-malformed",
    ],
    [
      "a block comment",
      "/* OVERRIDE SUPER-DEPLOY REFUSAL: justified */",
      "override-malformed",
    ],
  ])("refuses a marker with %s", async (_, written, rule) => {
    expect(await broken(`${written}\n${dynamic}\n`)).toEqual([
      [1, rule],
      [4, "plpgsql-dynamic-sql"],
    ]);
  });

  test("refuses a marker separated from its statement by a blank line", async () => {
    expect(await broken(`${marker}\n\n${dynamic}\n`)).toEqual([
      [1, "override-misplaced"],
      [5, "plpgsql-dynamic-sql"],
    ]);
  });

  test("refuses a marker separated from its statement by another comment", async () => {
    expect(await broken(`${marker}\n-- loads data\n${dynamic}\n`)).toEqual([
      [1, "override-misplaced"],
      [5, "plpgsql-dynamic-sql"],
    ]);
  });

  test("refuses a marker after a statement on the same line", async () => {
    expect(
      await broken(
        `create table t (id bigint primary key); ${marker}\n${dynamic}\n`,
      ),
    ).toEqual([
      [1, "override-misplaced"],
      [4, "plpgsql-dynamic-sql"],
    ]);
  });

  test("refuses a marker inside a statement", async () => {
    expect(
      await broken(
        `create table t (\n${marker}\n  id bigint primary key\n);\n`,
      ),
    ).toEqual([[2, "override-misplaced"]]);
  });

  test("refuses a marker at the end of the file", async () => {
    expect(await broken(`${dynamic}\n${marker}\n`)).toEqual([
      [3, "plpgsql-dynamic-sql"],
      [6, "override-misplaced"],
    ]);
  });

  test("ignores marker text inside a string or a routine body", async () => {
    expect(
      await broken(`create function f() returns text language plpgsql as $$
begin
  -- OVERRIDE SUPER-DEPLOY REFUSAL: not a marker
  return '-- OVERRIDE SUPER-DEPLOY REFUSAL: nor this';
end
$$;
`),
    ).toEqual([]);
  });

  test("accepts indentation before the marker", async () => {
    expect(await broken(`  ${marker}\n${dynamic}\n`)).toEqual([]);
  });

  test("refuses a marker on a statement that breaks no rule", async () => {
    const violations = await checkRules(
      {
        path: desiredPath,
        text: `${marker}\ncreate table t (id bigint primary key);\n`,
      },
      "desired-schema",
    );
    expect(violations).toEqual([
      {
        file: desiredPath,
        line: 1,
        statement: "create table t (id bigint primary key)",
        rule: "override-unused",
        message:
          "The override marker overrides nothing: the statement breaks no rule, so remove the marker",
      },
    ]);
  });

  test("no longer accepts the old marker form, which is just a comment", async () => {
    expect(
      await broken(`-- OVERRIDE DANGEROUS COMMAND: justified\n${dynamic}\n`),
    ).toEqual([[4, "plpgsql-dynamic-sql"]]);
    expect(
      await broken(
        "-- OVERRIDE DANGEROUS COMMAND: justified\ncreate table t (id bigint primary key);\n",
      ),
    ).toEqual([]);
  });

  test("hints the new form when a refused statement follows the old form", async () => {
    const violations = await checkRules(
      {
        path: desiredPath,
        text: `  -- OVERRIDE DANGEROUS COMMAND: justified\n${dynamic}\n`,
      },
      "desired-schema",
    );
    expect(violations.map((v) => [v.line, v.rule])).toEqual([
      [4, "plpgsql-dynamic-sql"],
    ]);
    expect(violations[0]?.message).toMatch(
      /\. Hint: the override marker is now "-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>"$/,
    );
  });

  test("gives no hint for the old form when the statement is refused only for a transaction rule", async () => {
    const analysis = await analyseMigration([
      {
        path: "data-model/draft/post-migration.sql",
        kind: "post-migration",
        text: "-- OVERRIDE DANGEROUS COMMAND: justified\ncommit;\n",
      },
    ]);
    expect(analysis.violations.map((v) => v.rule)).toEqual([
      "transaction-control",
    ]);
    expect(analysis.violations[0]?.message).not.toContain("Hint");
  });

  test("gives no hint when the old form is not on the line directly before", async () => {
    const [violation] = await checkRules(
      {
        path: desiredPath,
        text: `-- OVERRIDE DANGEROUS COMMAND: justified\n\n${dynamic}\n`,
      },
      "desired-schema",
    );
    expect(violation?.rule).toBe("plpgsql-dynamic-sql");
    expect(violation?.message).not.toContain("Hint");
  });

  test("applies to one statement only", async () => {
    expect(
      await broken(`${marker}\n${dynamic}\n${dynamic.replace("f()", "g()")}\n`),
    ).toEqual([[9, "plpgsql-dynamic-sql"]]);
  });
});

describe("deploy-time scripts", () => {
  const post = "data-model/draft/post-migration.sql";

  test("a marker overrides a denylisted call in a post-migration script and is recorded", async () => {
    const analysis = await analyseMigration([
      {
        path: post,
        kind: "post-migration",
        text: `update orders set total = 0 where total is null;
-- OVERRIDE SUPER-DEPLOY REFUSAL: move the sequence past imported ids
update counters set value = setval('orders_id_seq', 1000) where name = 'orders';
`,
      },
    ]);
    expect(analysis.violations).toEqual([]);
    expect(analysis.overrides).toEqual([
      {
        file: post,
        line: 2,
        object: "UPDATE counters",
        rules: ["denylisted-call"],
        reason: "move the sequence past imported ids",
      },
    ]);
  });

  test("a marker cannot override transaction control in a script", async () => {
    const analysis = await analyseMigration([
      { path: post, kind: "post-migration", text: `${marker}\ncommit;\n` },
    ]);
    expect(analysis.violations.map((v) => [v.line, v.rule])).toEqual([
      [2, "transaction-control"],
      [1, "override-unused"],
    ]);
    expect(analysis.overrides).toEqual([]);
  });
});

describe("routine bodies in deploy-time SQL", () => {
  const loaderFunction = `create function app.load_staging(source text) returns void
language plpgsql as $$
begin
  execute format('insert into app.staging select * from %s', source);
end
$$;`;

  test.each(["schema-change", "pre-migration"] as const)(
    "dynamic SQL in a routine body in a %s needs a marker",
    async (kind) => {
      const path = `data-model/draft/${kind}.sql`;
      const unmarked = await analyseMigration(
        [{ path, kind, text: `${loaderFunction}\n` }],
        { managedSchema: "app" },
      );
      expect(unmarked.violations.map((v) => [v.line, v.rule])).toEqual([
        [4, "plpgsql-dynamic-sql"],
      ]);
      const marked = await analyseMigration(
        [{ path, kind, text: `${marker}\n${loaderFunction}\n` }],
        { managedSchema: "app" },
      );
      expect(marked.violations).toEqual([]);
      expect(marked.overrides).toEqual([
        {
          file: path,
          line: 1,
          object: "function load_staging(text)",
          rules: ["plpgsql-dynamic-sql"],
          reason: "justified",
        },
      ]);
    },
  );

  test("COMMIT in a routine body created by a pre-migration script is refused", async () => {
    const analysis = await analyseMigration([
      {
        path: "data-model/draft/pre-migration.sql",
        kind: "pre-migration",
        text: `create procedure batch() language plpgsql as $$
begin
  commit;
end
$$;
`,
      },
    ]);
    expect(analysis.violations.map((v) => [v.line, v.rule])).toEqual([
      [3, "plpgsql-transaction-control"],
    ]);
  });

  test("a PL/pgSQL body may reference declared external schemas", async () => {
    const text = `create function count_legacy() returns bigint language plpgsql as $$
begin
  return (select count(*) from legacy.orders);
end
$$;
`;
    const path = "data-model/draft/schema-change.sql";
    const kind = "schema-change" as const;
    expect(
      (await analyseMigration([{ path, kind, text }])).violations.map(
        (v) => v.rule,
      ),
    ).toEqual(["undeclared-schema"]);
    expect(
      (
        await analyseMigration([{ path, kind, text }], {
          externalSchemas: ["legacy"],
        })
      ).violations,
    ).toEqual([]);
  });
});

describe("regenerated schema changes", () => {
  test("carry the desired schema's marker to the generated statement for the same object", async () => {
    const desired = await desiredSchemaAnalysis(
      [
        {
          path: desiredPath,
          text: loader(
            "-- OVERRIDE SUPER-DEPLOY REFUSAL: loads tables named by the caller",
          ).replaceAll(/\bstaging\b/g, "app.staging"),
        },
      ],
      { managedSchema: "app" },
    );
    const generated = [
      "CREATE TABLE app.staging (id bigint NOT NULL)",
      `CREATE OR REPLACE FUNCTION app.load_staging(source text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  execute format('insert into app.staging select * from %s', source);
end
$function$`,
      "COMMENT ON FUNCTION app.load_staging(text) IS 'Loads staging'",
    ];
    const carried = await carryOverrides(generated, desired.overrides, {
      managedSchema: "app",
    });
    expect(carried).toEqual([
      generated[0],
      `-- OVERRIDE SUPER-DEPLOY REFUSAL: loads tables named by the caller\n${generated[1]}`,
      generated[2],
    ]);
    const path = "data-model/draft/schema-change.sql";
    const text = `${carried.map((sql) => `${sql};`).join("\n\n")}\n`;
    const analysis = await analyseMigration(
      [{ path, kind: "schema-change", text }],
      { managedSchema: "app" },
    );
    expect(analysis.violations).toEqual([]);
    expect(analysis.overrides).toEqual([
      {
        file: path,
        line: 3,
        object: "function load_staging(text)",
        rules: ["plpgsql-dynamic-sql"],
        reason: "loads tables named by the caller",
      },
    ]);
  });

  test("leave a generated statement without a matching override unmarked, so its violation stands", async () => {
    const generated = [
      `CREATE FUNCTION app.other() RETURNS void LANGUAGE plpgsql AS $$ begin execute 'select 1'; end $$`,
    ];
    const overrides = [
      {
        file: desiredPath,
        line: 1,
        object: "function load_staging(text)",
        rules: ["plpgsql-dynamic-sql"],
        reason: "x",
      },
    ];
    expect(
      await carryOverrides(generated, overrides, { managedSchema: "app" }),
    ).toEqual(generated);
  });
});
