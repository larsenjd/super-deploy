// CLI seam for `init --adopt <target>`: it runs in the project found from the
// working directory, prints what it wrote, and lists what V1 doesn't support
// on stderr when it refuses. In a terminal it asks for override reasons.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import { deployConfig } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";
import { keys, spawnTerminal } from "../support/terminal.ts";

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

  test("without a terminal refuses functions that need an override marker, saying a terminal would ask", async () => {
    const dir = await projectAdopting(loader);

    const result = await runCli(["init", "--adopt", "prod"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "    plpgsql-dynamic-sql: EXECUTE (dynamic SQL) is not allowed",
    );
    expect(result.stderr).toContain(
      "In a terminal, adoption asks for an override reason for each object that breaks only risk rules, and writes its override marker\n",
    );
    expect(dir.exists("data-model/desired-schema")).toBe(false);
  });
});

const loader = `
create table staging (id bigint primary key);
create function load_staging(source text) returns void language plpgsql
  as $$ begin execute format('insert into staging select * from %I', source); end $$;
`;

describe.skipIf(process.platform === "win32")(
  "init --adopt at a terminal",
  () => {
    test("lists the functions that need an override marker, asks a reason for each and writes the markers", async () => {
      const dir = await projectAdopting(loader);
      const terminal = spawnTerminal(["init", "--adopt", "prod"], {
        cwd: dir.root,
      });

      const listed = await terminal.waitFor(
        "Reason to override plpgsql-dynamic-sql for function load_staging(text)?",
      );
      expect(listed).toContain(
        "Target prod has 1 object that needs an override marker:",
      );
      expect(listed).toMatch(
        /function load_staging\(text\)\s+plpgsql-dynamic-sql: EXECUTE \(dynamic SQL\)/,
      );
      terminal.type("loads tables named by the caller");
      terminal.type(keys.enter);

      await terminal.waitFor(
        "override: data-model/migrations/00001-adopt/schema-change.sql:",
      );
      await terminal.waitFor(
        "function load_staging(text) [plpgsql-dynamic-sql]: loads tables named by the caller",
      );
      expect(await terminal.exited).toBe(0);
      expect(await dir.read("data-model/desired-schema/routines.sql")).toMatch(
        /\n-- OVERRIDE SUPER-DEPLOY REFUSAL: loads tables named by the caller\nCREATE FUNCTION public\.load_staging/,
      );
      const validated = await runCli(["validate"], { cwd: dir.root });
      expect(validated.stdout).toContain(
        "override: data-model/desired-schema/routines.sql:",
      );
    });

    test("while anything else is refused, says which functions it will ask a reason for once that is fixed", async () => {
      const dir = await projectAdopting(
        `${loader} create type mood as enum ('sad');`,
      );
      const terminal = spawnTerminal(["init", "--adopt", "prod"], {
        cwd: dir.root,
      });

      await terminal.waitFor("Nothing was written");
      expect(await terminal.exited).toBe(1);
      const screen = terminal.screen.replace(/\s+/g, " ");
      expect(screen).toContain(
        "Target prod has 1 thing V1 doesn't support: CREATE TYPE",
      );
      expect(screen).toContain(
        "Once nothing else is refused, adoption will ask an override reason for 1 object that breaks only risk rules: function load_staging(text)",
      );
      expect(screen).not.toContain("Reason to override");
      expect(dir.exists("data-model/desired-schema")).toBe(false);
    });

    test("an empty reason cancels the adoption, writing nothing", async () => {
      const dir = await projectAdopting(loader);
      const terminal = spawnTerminal(["init", "--adopt", "prod"], {
        cwd: dir.root,
      });

      await terminal.waitFor("for function load_staging(text)?");
      terminal.type(keys.enter);

      await terminal.waitFor(
        "Error: Adoption of target prod cancelled: no override reason given for function load_staging(text). Nothing was written",
      );
      expect(await terminal.exited).toBe(1);
      expect(dir.exists("data-model/desired-schema")).toBe(false);
      expect(dir.exists("data-model/migrations")).toBe(false);
    });
  },
);
