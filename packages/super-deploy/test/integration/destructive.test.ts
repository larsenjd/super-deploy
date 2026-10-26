// Destructive acknowledgement and lock warnings at finalize (API seam). What
// counts as destructive or a warning is covered at the SQL-analysis seam.
import {
  DestructiveNotAcknowledgedError,
  draft,
  finalize,
  loadProject,
  type Question,
  rehearse,
} from "super-deploy";
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

const schemaFile = "data-model/desired-schema/schema.sql";

const orders = `create table orders (
  id bigint primary key,
  qty integer not null,
  price numeric(10,2),
  note text
);
`;

/** A project whose first migration created `orders`, with `next` as the desired schema. */
async function projectWithOrders(next: string) {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: { [schemaFile]: orders },
  });
  const project = await loadProject({ cwd: dir.root });
  await draft(project, { name: "add orders" });
  await finalize(project);
  await dir.write(schemaFile, next);
  await draft(project, { name: "change orders" });
  return { dir, project };
}

const withoutNote = orders.replace(",\n  note text", "");
const migration2 = "data-model/migrations/00002-change-orders";

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DestructiveNotAcknowledgedError);
  return error as DestructiveNotAcknowledgedError;
}

describe("finalize with destructive statements", () => {
  test("refuses without the acknowledgement or a confirm callback, and changes nothing", async () => {
    const { dir, project } = await projectWithOrders(withoutNote);

    const error = await refusal(finalize(project));

    expect(error.code).toBe("destructive-not-acknowledged");
    expect(error.declined).toBe(false);
    expect(error.message).toMatch(
      /schema-change\.sql:\d+: ALTER TABLE public\.orders DROP COLUMN note drops the column and its data.*--acknowledge-destructive/,
    );
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(true);
    expect(dir.exists(migration2)).toBe(false);
  });

  test("asks the confirm callback, listing the statements; no changes nothing", async () => {
    const { dir, project } = await projectWithOrders(withoutNote);
    const questions: Question[] = [];

    const error = await refusal(
      finalize(project, {
        confirm: (question) => {
          questions.push(question);
          return false;
        },
      }),
    );

    expect(error.declined).toBe(true);
    expect(questions).toEqual([
      {
        kind: "acknowledge-destructive",
        command: "finalize",
        message: expect.stringMatching(/change-orders.*\?$/),
        statements: [
          expect.objectContaining({
            file: "data-model/draft/schema-change.sql",
            kind: "drop-column",
            statement: 'ALTER TABLE "public"."orders" DROP COLUMN "note"',
          }),
        ],
      },
    ]);
    expect(dir.exists(migration2)).toBe(false);
    expect(dir.exists("data-model/draft/schema-change.sql")).toBe(true);
  });

  test("finalizes when confirmed and records the acknowledgement and its statements in metadata", async () => {
    const { dir, project } = await projectWithOrders(withoutNote);

    const result = await finalize(project, { confirm: () => true });

    const metadata = JSON.parse(await dir.read(`${migration2}/metadata.json`));
    const schemaChange = await dir.read(`${migration2}/schema-change.sql`);
    const line =
      schemaChange.split("\n").findIndex((l) => l.includes("DROP COLUMN")) + 1;
    expect(metadata.destructive).toEqual({
      acknowledged: true,
      statements: [
        {
          file: "schema-change.sql",
          line,
          statement: 'ALTER TABLE "public"."orders" DROP COLUMN "note"',
          kind: "drop-column",
          message:
            "ALTER TABLE public.orders DROP COLUMN note drops the column and its data",
        },
      ],
    });
    expect(result.metadata).toEqual(metadata);
    expect(result.destructive).toEqual([
      expect.objectContaining({
        file: `${migration2}/schema-change.sql`,
        line,
      }),
    ]);
  });

  test("finalizes with acknowledgeDestructive without asking", async () => {
    const { dir, project } = await projectWithOrders(withoutNote);

    await finalize(project, {
      acknowledgeDestructive: true,
      confirm: () => {
        throw new Error("must not ask");
      },
    });

    const metadata = JSON.parse(await dir.read(`${migration2}/metadata.json`));
    expect(metadata.destructive.statements).toHaveLength(1);
  });

  test("a lossy type change needs the acknowledgement; a widening does not", async () => {
    const lossy = await projectWithOrders(
      orders.replace("price numeric(10,2)", "price integer"),
    );
    const error = await refusal(finalize(lossy.project));
    expect(error.question.statements.map((s) => s.kind)).toEqual([
      "lossy-type-change",
    ]);

    const widening = await projectWithOrders(
      orders.replace("qty integer", "qty bigint"),
    );
    const result = await finalize(widening.project, {
      confirm: () => {
        throw new Error("must not ask");
      },
    });
    expect(result.destructive).toEqual([]);
    expect(result.metadata).not.toHaveProperty("destructive");
  });
});

describe("destructive statements in scripts", () => {
  test("a DELETE in the post-migration script needs the acknowledgement and is recorded", async () => {
    const { dir, project } = await projectWithOrders(
      `${orders}create index orders_qty_idx on orders (qty);\n`,
    );
    await dir.write(
      "data-model/draft/post-migration.sql",
      "delete from orders where qty = 0;\n",
    );

    const error = await refusal(finalize(project));
    expect(error.question.statements).toEqual([
      expect.objectContaining({
        file: "data-model/draft/post-migration.sql",
        line: 1,
        kind: "delete",
      }),
    ]);

    const result = await finalize(project, { acknowledgeDestructive: true });
    expect(result.metadata.destructive?.statements).toEqual([
      expect.objectContaining({ file: "post-migration.sql", kind: "delete" }),
    ]);
  });
});

describe("lock warnings", () => {
  test("finalize and rehearse report statements that rewrite or scan an existing table", async () => {
    const { project } = await projectWithOrders(
      `${orders}create index orders_qty_idx on orders (qty);\n`,
    );

    const rehearsed = await rehearse(project);
    const result = await finalize(project);

    const expected = [
      expect.objectContaining({
        kind: "create-index",
        object: "orders",
        message: expect.stringContaining("until the deployment commits"),
      }),
    ];
    expect(rehearsed.warnings).toEqual(expected);
    expect(result.warnings).toEqual(expected);
    expect(result.warnings[0]?.file).toBe(`${migration2}/schema-change.sql`);
    expect(result.metadata).not.toHaveProperty("destructive");
  });

  test("tables created in the same migration are exempt", async () => {
    const { project } = await projectWithOrders(
      `${orders}create table items (id bigint primary key, qty int not null);
create index items_qty_idx on items (qty);
`,
    );

    expect((await finalize(project)).warnings).toEqual([]);
  });
});
