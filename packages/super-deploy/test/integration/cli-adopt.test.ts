// CLI seam for `init --adopt <target>`: it runs in the project found from the
// working directory, prints what it wrote, and lists what V1 doesn't support
// on stderr when it refuses. In a terminal it asks for override reasons.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import {
  asDeployerPreamble,
  asSuperuser,
  deployConfig,
  roleName,
} from "../support/deploy.ts";
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

async function projectAdopting(sql: string, settings = "") {
  const prod = await server.createDatabase(sql);
  return createTestProject({
    config: deployConfig(server, {
      otherTargets: `prod: { adapter: ${asSuperuser(prod)} },`,
      settings,
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

  test("says how many grants and policies it left on the target as they are", async () => {
    const dir = await projectAdopting(`
      create role cli_adopt_reader nologin;
      create table customers (id bigint primary key, name text not null);
      grant select on customers to cli_adopt_reader;
      create policy customers_read on customers for select to cli_adopt_reader using (true);
    `);

    const result = await runCli(["init", "--adopt", "prod"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Left 1 grant and 1 policy on target prod as they are: privileges and row-level security are set up outside super-deploy\n",
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
        "  sequence public.counter",
        "    unsupported-object: Standalone sequences are not supported in V1: use an identity column (`bigint generated always as identity`)",
        "  type public.mood",
        "    unsupported-object: Enums are not supported in V1: use a lookup table with a foreign key, or a CHECK constraint",
        "Error: Cannot adopt target prod: its managed schema has 2 things V1 doesn't support, listed above. Nothing was written; change the target first, then adopt again",
        "",
      ].join("\n"),
    );
    expect(dir.exists("data-model/desired-schema")).toBe(false);
  });

  test("refuses a target without the managed schema in one line (exit 1)", async () => {
    const dir = await projectAdopting(
      "create schema app; create table app.t (id bigint primary key);",
      'managedSchema: "ap",',
    );

    const result = await runCli(["init", "--adopt", "prod"], {
      cwd: dir.root,
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        'Error: Cannot adopt target prod: its managed schema "ap" does not exist (check managedSchema in super-deploy.config.ts). Nothing was written\n',
    });
  });

  test("lists each object the deploy role doesn't own, then the fixes as a script that, run as a superuser, lets adoption through (exit 1)", async () => {
    const deployer = roleName("cli_adopt_deployer");
    const admin = roleName("cli_adopt_admin");
    const prod = await server.createDatabase(`
      create role ${deployer} login password 'deployer';
      create role ${admin} nologin;
      do $$ begin execute format('grant connect, create on database %I to ${deployer}, ${admin}', current_database()); end $$;
      create schema app authorization ${deployer};
      grant usage, create on schema app to ${admin};
      set role ${admin};
      create table app.widgets (id bigint generated always as identity primary key, name text not null);
      create view app.widget_names as select name from app.widgets;
      create function app.widget_named(wanted text, since bigint) returns bigint language sql stable
        as $$ select count(*) from app.widgets where name = wanted and id > since $$;
    `);
    const dir = await createTestProject({
      config: deployConfig(server, {
        settings: 'managedSchema: "app",',
        preamble: asDeployerPreamble(prod, deployer),
        otherTargets: "prod: { adapter: asDeployer },",
      }).config,
    });

    const result = await runCli(["init", "--adopt", "prod"], {
      cwd: dir.root,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      [
        "The deploy role on target prod doesn't own 3 objects in the managed schema:",
        `  function app.widget_named(wanted text, since bigint) (owned by ${admin})`,
        `  table app.widgets (owned by ${admin})`,
        `  view app.widget_names (owned by ${admin})`,
        "To fix, run as a superuser or as each object's owner:",
        `  ALTER FUNCTION app.widget_named(wanted text, since bigint) OWNER TO ${deployer};`,
        `  ALTER TABLE app.widgets OWNER TO ${deployer};`,
        `  ALTER VIEW app.widget_names OWNER TO ${deployer};`,
        "Error: Cannot adopt target prod: the deploy role doesn't own 3 objects in the managed schema, listed above. Nothing was written; run the fixes as a superuser, then adopt again",
        "",
      ].join("\n"),
    );

    const script = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("  ALTER "))
      .join("\n");
    await server.query(script, [], prod);
    expect(
      await runCli(["init", "--adopt", "prod"], { cwd: dir.root }),
    ).toMatchObject({ exitCode: 0 });
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
    expect(result.stderr).toMatch(
      /\nError: Cannot adopt target prod: its managed schema has 1 thing V1 doesn't support, listed above\. Nothing was written; run adoption in a terminal to give an override reason for each object that breaks only risk rules\n$/,
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
        "Target prod has 1 thing V1 doesn't support: type public.mood",
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
