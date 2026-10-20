// CLI seam for `init --adopt <target>`: it runs in the project found from the
// working directory, prints what it wrote, and lists what V1 doesn't support
// on stderr when it refuses.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { deployConfig } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

async function projectAdopting(sql: string) {
  const prod = await server.createDatabase(sql);
  return createTestProject({
    config: deployConfig(server, {
      otherTargets: `prod: { adapter: postgres.target(${JSON.stringify(prod)}) },`,
    }).config,
  });
}

describe("init --adopt", () => {
  test("adopts the target from a subdirectory of the project", async () => {
    const dir = await projectAdopting(
      "create table customers (id bigint primary key, name text not null);",
    );
    await dir.write("data-model/desired-schema/.gitkeep", "");

    const result = await runCli(["init", "--adopt", "prod"], {
      cwd: dir.path("data-model"),
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout:
        "Wrote desired-schema/tables.sql\nAdopted target prod: migration 00001-adopt in migrations/00001-adopt, recorded on it as marked (attempt #1)\n",
      stderr: "",
    });
    const status = await runCli(["status", "--target", "prod"], {
      cwd: dir.root,
    });
    expect(status.stdout).toContain(
      "Target prod: 1 migration recorded, 0 pending\n",
    );
  });

  test("refuses with the full list on stderr (exit 1)", async () => {
    const dir = await projectAdopting(
      "create type mood as enum ('sad'); create sequence counter;",
    );

    const result = await runCli(["init", "--adopt", "prod"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "Target prod has 2 things V1 doesn't support:",
        '  CREATE SEQUENCE "public"."counter" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE …',
        "    unsupported-object: Standalone sequences are not supported in V1: use an identity column (`bigint generated always as identity`)",
        `  CREATE TYPE "public"."mood" AS ENUM ('sad')`,
        "    unsupported-object: Enums are not supported in V1: use a lookup table with a foreign key, or a CHECK constraint",
        `Error: Cannot adopt target prod: its managed schema has 2 things V1 doesn't support: CREATE SEQUENCE "public"."counter" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE …; CREATE TYPE "public"."mood" AS ENUM ('sad'). Nothing was written; change the target first, then adopt again`,
        "",
      ].join("\n"),
    );
    expect(dir.exists("data-model/desired-schema")).toBe(false);
  });

  test("an unknown target is a usage error (exit 2)", async () => {
    const dir = await projectAdopting("");

    const result = await runCli(["init", "--adopt", "nope"], {
      cwd: dir.root,
    });

    expect(result).toEqual({
      exitCode: 2,
      stdout: "",
      stderr:
        'Error: Unknown target "nope" for --adopt; super-deploy.config.ts has dev, prod\n',
    });
  });
});
