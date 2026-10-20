// CLI seam for draft's report of what the scripts still need to cover.
import { afterAll, beforeAll, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

test("draft prints what the scripts still need to cover as warnings on stderr and exits 0", async () => {
  const dir = await createTestProject({
    config: embeddedConfig(server),
    files: {
      "data-model/desired-schema/customers.sql":
        "create table customers (id bigint primary key, email text);\n",
    },
  });
  expect(
    (await runCli(["draft", "--name", "add customers"], { cwd: dir.root }))
      .exitCode,
  ).toBe(0);
  expect((await runCli(["finalize"], { cwd: dir.root })).exitCode).toBe(0);
  await dir.write(
    "data-model/desired-schema/customers.sql",
    "create table customers (id bigint primary key);\n",
  );

  const result = await runCli(["draft", "--name", "drop email"], {
    cwd: dir.root,
  });

  expect(result).toMatchObject({
    exitCode: 0,
    stdout:
      "Created draft drop-email: 1 statement in data-model/draft/schema-change.sql\n",
    stderr:
      "warning: Column customers.email is dropped with its data (no non-null values in the rehearsal data): rename it, or copy what you need, in the pre-migration script\n",
  });
});
