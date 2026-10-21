// CLI seam for deploy and status: output streams and exit codes.
import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import {
  asDeployerPreamble,
  asSuperuser,
  deployConfig,
  roleName,
  targetDatabaseName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const superuserWarning =
  "warning: The deploy role \"super_deploy\" on target dev is a superuser: deploy with a role that isn't, so deploy-time SQL can't reach beyond the database\n";

async function finalizedProject(settings?: string) {
  const dir = await createTestProject({
    config: deployConfig(server, settings === undefined ? {} : { settings })
      .config,
    files: {
      "data-model/desired-schema/customers.sql":
        "create table customers (id bigint primary key, name text not null);\n",
    },
  });
  for (const args of [["draft", "--name", "add customers"], ["finalize"]]) {
    expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
  }
  return dir;
}

describe("deploy and status", () => {
  test("status shows what is pending and that drift was checked, deploy applies it, and status then shows each attempt, a deploy of nothing as such", async () => {
    const dir = await finalizedProject();

    const before = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(before).toMatchObject({
      exitCode: 0,
      stdout:
        "Target dev: 0 migrations recorded, 1 pending\nDrift: none\nPending:\n  00001-add-customers\n",
      stderr: "",
    });

    const deployed = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(deployed).toMatchObject({
      exitCode: 0,
      stdout: "Deployed 1 migration to dev: 00001-add-customers\n",
      stderr: "",
    });

    const again = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(again.stdout).toBe("Target dev is up to date: nothing to deploy\n");

    const after = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(after.exitCode).toBe(0);
    const user = userInfo().username;
    expect(after.stdout).toMatch(
      new RegExp(
        `^Target dev: 1 migration recorded, 0 pending\nDrift: none\nRecent attempts:\n  #2 deploy succeeded, nothing to deploy, by ${user} at \\S+Z\n  #1 deploy succeeded migration 1 by ${user} at \\S+Z\n$`,
      ),
    );
  });

  test("a target that logs in as a superuser gets a warning on stderr from status and deploy, which still deploys", async () => {
    const database = targetDatabaseName();
    await server.query(`create database ${database}`);
    const dir = await createTestProject({
      config: deployConfig(server, {
        database,
        adapter: asSuperuser(database),
      }).config,
      files: {
        "data-model/desired-schema/customers.sql":
          "create table customers (id bigint primary key, name text not null);\n",
      },
    });
    for (const args of [["draft", "--name", "add customers"], ["finalize"]]) {
      expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
    }

    expect(
      await runCli(["status", "--target", "dev"], { cwd: dir.root }),
    ).toMatchObject({ exitCode: 0, stderr: superuserWarning });
    expect(
      await runCli(["deploy", "--target", "dev"], { cwd: dir.root }),
    ).toMatchObject({
      exitCode: 0,
      stdout: "Deployed 1 migration to dev: 00001-add-customers\n",
      stderr: superuserWarning,
    });
  });

  test("status lists what a deployment would refuse and exits 1, and deploy then fails with exit code 1", async () => {
    const { config, database } = deployConfig(server, {
      settings: 'managedSchema: "app",',
    });
    await server.query(`create database ${database}`);
    await server.query("create schema app", [], database);
    const dir = await createTestProject({
      config,
      files: {
        "data-model/desired-schema/customers.sql":
          "create table customers (id bigint primary key, name text not null);\n",
      },
    });
    for (const args of [["draft", "--name", "add customers"], ["finalize"]]) {
      expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
    }
    const refusal =
      "schema app is owned by super_deploy, whose privileges the deploy role doesn't have (fix: ALTER SCHEMA app OWNER TO deployer)";
    const preflightFailed = `Error: Target dev failed the deploy pre-flight checks: ${refusal}\n`;

    const report = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(report).toMatchObject({
      exitCode: 1,
      stdout: `Target dev: 0 migrations recorded, 1 pending\nDeploy would refuse:\n  ${refusal}\nDrift: none\nPending:\n  00001-add-customers\n`,
      stderr: preflightFailed,
    });

    const refused = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(refused).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: preflightFailed,
    });
  });

  test("status lists a history mismatch, with its way out, under what a deployment would refuse, leaves drift unchecked and exits 1", async () => {
    const dir = await finalizedProject();
    for (const args of [
      ["deploy", "--target", "dev"],
      ["unfinalize", "--acknowledge-overwrite"],
      ["discard-draft", "--acknowledge-overwrite"],
    ]) {
      expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
    }

    const report = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(report.exitCode).toBe(1);
    expect(report.stdout).toContain(
      "Deploy would refuse:\n  the target records migration 00001-add-customers, which the repo doesn't have: restore 00001-add-customers (and index.json) from version control (a migration a target has recorded must never change, so put new changes in a new migration)\nDrift: not checked (the recorded history doesn't match the project's migrations)\n",
    );
    expect(report.stderr).toContain(
      "Error: Target dev failed the deploy pre-flight checks: the target records migration 00001-add-customers",
    );
  });

  test("status lists a history schema the deploy role can't create as a refusal and exits 1", async () => {
    const deployer = roleName("deployer");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create database ${database}`);
    await server.query(
      `create schema app authorization ${deployer}`,
      [],
      database,
    );
    const dir = await createTestProject({
      config: deployConfig(server, {
        database,
        preamble: asDeployerPreamble(database, deployer),
        adapter: "asDeployer",
        settings: 'managedSchema: "app",',
      }).config,
    });

    const report = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });

    expect(report.exitCode).toBe(1);
    expect(report.stdout).toContain(
      `Deploy would refuse:\n  the deploy role ${deployer} needs CREATE on database ${database} to create the history schema "deployment_history" (fix: GRANT CREATE ON DATABASE ${database} TO ${deployer})\n`,
    );
  });

  test("status lists the drifted objects, saying which side each line is on, and exits 1; deploy refuses with exit code 1", async () => {
    const { config, database } = deployConfig(server);
    const dir = await createTestProject({
      config,
      files: {
        "data-model/desired-schema/customers.sql":
          "create table customers (id bigint primary key, name text not null);\ncreate index customers_name_idx on customers (name);\n",
      },
    });
    for (const args of [
      ["draft", "--name", "add customers"],
      ["finalize"],
      ["deploy", "--target", "dev"],
    ]) {
      expect((await runCli(args, { cwd: dir.root })).exitCode).toBe(0);
    }
    await server.query(
      `drop index customers_name_idx;
       alter table customers alter column name type varchar(100);
       alter table customers add column note text;`,
      [],
      database,
    );

    const report = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(report.exitCode).toBe(1);
    expect(report.stdout).toMatch(
      new RegExp(
        [
          "^Target dev: 1 migration recorded, 0 pending",
          "Drift \\(the target differs from its recorded migrations\\):",
          " {2}column name of table public\\.customers:",
          " {4}on the target: column: customers\\.name character varying\\(100\\) notnull=true .*",
          " {4}expected by migrations: column: customers\\.name text notnull=true .*",
          " {2}column note of table public\\.customers:",
          " {4}only on the target: column: customers\\.note text notnull=false .*",
          " {2}index public\\.customers_name_idx:",
          " {4}missing from the target: index: CREATE INDEX customers_name_idx ON public\\.customers .*",
          "Recent attempts:\n",
        ].join("\n"),
      ),
    );
    const drifted =
      "Error: Target dev has drifted from its recorded migrations: column name of table public.customers (changed), column note of table public.customers (only on the target), index public.customers_name_idx (missing from the target). Deployments refuse until it matches them again";
    // status has just listed the differences: it doesn't point to itself.
    expect(report.stderr).toBe(`${drifted}\n`);

    const refused = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(refused).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: `${drifted} (status --target dev lists the differences)\n`,
    });

    // The refused deploy had nothing pending; its attempt still reads as failed.
    const afterRefusal = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(afterRefusal.stdout).toMatch(
      new RegExp(
        `\nRecent attempts:\n  #2 deploy failed by ${userInfo().username} at \\S+Z: Target dev has drifted`,
      ),
    );
  });

  test("status --help says when it exits 1", async () => {
    const dir = await createTestProject();

    const result = await runCli(["status", "--help"], { cwd: dir.root });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "exit 1 on drift, on drift not checked or when deploy would refuse",
    );
  });

  test("an unknown or missing --target is a usage error", async () => {
    const dir = await finalizedProject();

    const unknown = await runCli(["deploy", "--target", "prod"], {
      cwd: dir.root,
    });
    expect(unknown).toMatchObject({ exitCode: 2, stdout: "" });
    expect(unknown.stderr).toContain('Unknown target "prod"');

    const missing = await runCli(["status"], { cwd: dir.root });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain("Missing required option --target");
  });

  test("a target without a connection string fails with exit code 1, naming the target", async () => {
    const dir = await createTestProject({
      config: deployConfig(server, {
        preamble: 'import { postgresTarget } from "super-deploy";',
        otherTargets:
          "qa: { adapter: postgresTarget({ connectionString: process.env.SUPER_DEPLOY_TEST_UNSET_URL as string }) },",
      }).config,
    });
    const result = await runCli(["status", "--target", "qa"], {
      cwd: dir.root,
    });

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toMatch(
      /^Error: Target qa has no connection string \(connectionString is undefined\)/,
    );
  });
});
