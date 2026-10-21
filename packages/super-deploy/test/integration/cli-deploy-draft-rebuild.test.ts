// deploy-draft and rebuild at the CLI process seam. Both are guarded
// commands, so they are tested in a pseudo-terminal: they refuse targets that
// aren't disposable before asking, show what they are about to do, and go
// ahead only once YES is typed. Their API refusal in CI is in
// deploy-draft-rebuild.test.ts.
import { userInfo } from "node:os";
import { deploy, draft, finalize, loadProject, recovery } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../support/cli.ts";
import {
  asDeployerPreamble,
  deployConfig,
  roleName,
  targetDatabaseName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, type TestProject } from "../support/project.ts";
import { keys, spawnTerminal } from "../support/terminal.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers = (city: string) => `create table customers (
  id bigint primary key,
  name text not null,
  city text${city}
);
`;

/**
 * Migration 1 (customers, city optional) deployed to `dev`, which holds a
 * customer without a city and is disposable unless `disposable` is false.
 */
/** A project with `config` whose migration 1 (customers) is deployed to target dev. */
async function customersDeployed(config: string): Promise<TestProject> {
  const dir = await createTestProject({
    config,
    files: { "data-model/desired-schema/customers.sql": customers("") },
  });
  const project = await loadProject({ cwd: dir.root });
  try {
    await draft(project, { name: "add customers" });
    await finalize(project);
    await deploy(project, { target: "dev" });
  } finally {
    await project.close();
  }
  return dir;
}

async function deployedProject({
  disposable = true,
  adapter,
}: {
  disposable?: boolean;
  adapter?: string;
} = {}) {
  const { config, database } = deployConfig(
    server,
    adapter === undefined ? {} : { adapter },
  );
  const dir = await customersDeployed(config);
  await server.query(
    "insert into customers (id, name) values (1, 'Ada')",
    [],
    database,
  );
  if (disposable) {
    await server.query(
      "update deployment_history.settings set disposable = true",
      [],
      database,
    );
  }
  return { dir, database };
}

/** A draft making city required: its pre-migration script fills in missing cities, its seed data adds Bob. */
async function requireCityDraft(dir: TestProject) {
  await dir.write(
    "data-model/desired-schema/customers.sql",
    customers(" not null"),
  );
  const project = await loadProject({ cwd: dir.root });
  try {
    await draft(project, { name: "require city" });
  } finally {
    await project.close();
  }
  await dir.write(
    "data-model/draft/pre-migration.sql",
    "update customers set city = 'Unknown' where city is null;\n",
  );
  await dir.write(
    "data-model/draft/seed-data.sql",
    "insert into customers (id, name) values (2, 'Bob');\n",
  );
}

const unix = process.platform === "win32" ? describe.skip : describe;

unix("deploy-draft", () => {
  test("deploys the draft without its seed data once YES is typed; the target then holds the draft, which status reports and deploy refuses", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);

    const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    const shown = await terminal.waitFor(
      "Type YES to deploy draft require-city to target dev",
    );
    expect(shown).toContain(
      "deploy-draft: Deploy draft require-city to target dev",
    );
    expect(shown).toContain("Last recorded migration: 00001-add-customers");
    expect(shown).toContain("Seed data: not loaded");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Deployed draft require-city to dev on top of 00001-add-customers, without seed data",
    );
    expect(await terminal.exited).toBe(0);

    expect(
      await server.query(
        "select id, name, city from customers order by id",
        [],
        database,
      ),
    ).toEqual([{ id: "1", name: "Ada", city: "Unknown" }]);
    expect(
      await server.query(
        "select is_nullable from information_schema.columns where table_name = 'customers' and column_name = 'city'",
        [],
        database,
      ),
    ).toEqual([{ is_nullable: "NO" }]);
    // The draft is not a migration: only migration 1 is recorded.
    expect(
      await server.query(
        "select number from deployment_history.migrations",
        [],
        database,
      ),
    ).toEqual([{ number: 1 }]);
    expect(
      await server.query(
        "select command, os_user, outcome from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([
      expect.objectContaining({ command: "deploy" }),
      {
        command: "deploy-draft",
        os_user: userInfo().username,
        outcome: "succeeded",
      },
    ]);

    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.exitCode).toBe(1);
    expect(status.stdout).toContain(
      "Deploy would refuse:\n  the target holds draft require-city (deployed by attempt #2 on top of 00001-add-customers, without seed data), not a finalized migration: reset it with rebuild --to 1\nDrift: not checked (the target holds deployed draft require-city; rebuild resets it)\n",
    );
    expect(status.stdout).not.toContain("recorded history doesn't match");
    const deployed = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(deployed.exitCode).toBe(1);
    expect(deployed.stderr).toContain("the target holds draft require-city");
  });

  test("--with-seed loads the draft's seed data just before its pre-migration script", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);

    const terminal = spawnTerminal(
      ["deploy-draft", "--target", "dev", "--with-seed"],
      { cwd: dir.root },
    );
    const shown = await terminal.waitFor("Type YES");
    expect(shown).toContain("Seed data: loaded first");
    expect(shown).toContain("data-model/draft/seed-data.sql");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Deployed draft require-city to dev on top of 00001-add-customers, with seed data",
    );
    expect(await terminal.exited).toBe(0);
    expect(
      await server.query(
        "select id, name, city from customers order by id",
        [],
        database,
      ),
    ).toEqual([
      { id: "1", name: "Ada", city: "Unknown" },
      { id: "2", name: "Bob", city: "Unknown" },
    ]);
  });

  test("refuses a target that isn't disposable without asking: nothing changes", async () => {
    const { dir, database } = await deployedProject({ disposable: false });
    await requireCityDraft(dir);

    const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await terminal.waitFor(
      "Error: deploy-draft only runs on disposable targets, and target dev is not disposable",
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.screen).not.toContain("Type YES");
    expect(
      await server.query(
        "select command from deployment_history.attempts",
        [],
        database,
      ),
    ).toEqual([{ command: "deploy" }]);
  });

  test("refuses, without asking, a draft generated from an older desired schema: nothing changes", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );

    const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await terminal.waitFor(
      "Error: The desired schema has changed since draft require-city was generated: run draft again",
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.screen).not.toContain("Type YES");
    expect(
      await server.query(
        "select command from deployment_history.attempts",
        [],
        database,
      ),
    ).toEqual([{ command: "deploy" }]);
    expect(
      await server.query(
        "select is_nullable from information_schema.columns where table_name = 'customers' and column_name = 'city'",
        [],
        database,
      ),
    ).toEqual([{ is_nullable: "YES" }]);
  });

  test("refuses, without asking, a target that already holds a draft or has pending migrations", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);
    const first = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await first.waitFor("Type YES");
    first.type(`YES${keys.enter}`);
    expect(await first.exited).toBe(0);

    const again = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await again.waitFor(
      "the target holds draft require-city (deployed by attempt #2 on top of 00001-add-customers, without seed data), not a finalized migration: reset it with rebuild --to 1",
    );
    expect(await again.exited).toBe(1);
    expect(again.screen).not.toContain("Type YES");

    // mark refuses it too: the target's structure is not that of a migration.
    const marking = spawnTerminal(["mark", "--target", "dev"], {
      cwd: dir.root,
    });
    await marking.waitFor(
      "Error: Target dev holds draft require-city (deployed by attempt #2 on top of 00001-add-customers, without seed data), not a finalized migration: reset it with rebuild --to 1",
    );
    expect(await marking.exited).toBe(1);
    expect(marking.screen).not.toContain("recorded migrations don't match");

    // A real history mismatch alongside the draft keeps the mismatch wording.
    await server.query(
      "update deployment_history.migrations set content_hash = 'edited' where number = 1",
      [],
      database,
    );
    const mismatched = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.stdout).toContain(
      "Drift: not checked (the recorded history doesn't match the project's migrations)\n",
    );

    // Another target at migration 0 with migration 1 pending.
    const behind = await deployedProject();
    await server.query(
      "delete from deployment_history.migrations",
      [],
      behind.database,
    );
    await requireCityDraft(behind.dir);
    const pending = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: behind.dir.root,
    });
    await pending.waitFor(
      "Error: Target dev has pending migrations (00001-add-customers): deploy them first",
    );
    expect(await pending.exited).toBe(1);
    expect(
      await server.query(
        "select command, outcome from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([
      { command: "deploy", outcome: "succeeded" },
      { command: "deploy-draft", outcome: "succeeded" },
    ]);
  });

  test("refuses, without asking, a target where the deploy role doesn't own an object in the managed schema, until it does", async () => {
    const deployer = roleName("deployer");
    const database = targetDatabaseName();
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create database ${database} owner ${deployer}`);
    const { config } = deployConfig(server, {
      database,
      preamble: asDeployerPreamble(database, deployer),
      adapter: "asDeployer",
    });
    const dir = await customersDeployed(config);
    await server.query(
      `update deployment_history.settings set disposable = true;
       alter table customers owner to super_deploy;`,
      [],
      database,
    );
    await requireCityDraft(dir);

    const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });

    await terminal.waitFor(
      `table public.customers is owned by super_deploy, whose privileges the deploy role doesn't have (fix: ALTER TABLE public.customers OWNER TO ${deployer})`,
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.screen).not.toContain("Type YES");
    expect(
      await server.query(
        "select is_nullable from information_schema.columns where table_name = 'customers' and column_name = 'city'",
        [],
        database,
      ),
    ).toEqual([{ is_nullable: "YES" }]);

    await server.query(
      `alter table customers owner to ${deployer}`,
      [],
      database,
    );
    const again = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await again.waitFor("Type YES to deploy draft require-city to target dev");
    again.type(`YES${keys.enter}`);
    expect(await again.exited).toBe(0);
  });

  test("a failing draft rolls back entirely: the attempt failed and the target holds no draft", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);
    // Without its pre-migration script the schema change meets Ada's null city.
    await dir.write("data-model/draft/pre-migration.sql", "");
    await dir.write(
      "data-model/draft/post-migration.sql",
      "update customers set name = 'changed';\n",
    );

    const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await terminal.waitFor("Type YES");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(/Error: .*data-model\/draft\/schema-change\.sql/);
    expect(await terminal.exited).toBe(1);
    expect(
      await server.query(
        "select id, name, city from customers order by id",
        [],
        database,
      ),
    ).toEqual([{ id: "1", name: "Ada", city: null }]);
    expect(
      await server.query(
        "select command, outcome, error_file from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([
      expect.objectContaining({ command: "deploy" }),
      {
        command: "deploy-draft",
        outcome: "failed",
        error_file: "data-model/draft/schema-change.sql",
      },
    ]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).not.toContain("holds draft");
  });
});

/**
 * Migration 1 deployed to a disposable `dev` holding Ada without a city;
 * migration 2 (require city) finalized but deployed only if `deployed`; and
 * a Recovery draft of migration 2 whose pre-migration script fills in
 * 'Recovered' and whose seed data adds Cy.
 */
async function recoveryDraftProject({ deployed }: { deployed: boolean }) {
  const { dir, database } = await deployedProject();
  await requireCityDraft(dir);
  await dir.write("data-model/draft/seed-data.sql", "");
  const project = await loadProject({ cwd: dir.root });
  try {
    await finalize(project);
    if (deployed) {
      await deploy(project, { target: "dev" });
    }
    await recovery(project, { migration: 2 });
  } finally {
    await project.close();
  }
  await dir.write(
    "data-model/draft/pre-migration.sql",
    "update customers set city = 'Recovered' where city is null;\n",
  );
  await dir.write(
    "data-model/draft/seed-data.sql",
    "insert into customers (id, name) values (3, 'Cy');\n",
  );
  return { dir, database };
}

unix("deploy-draft of a Recovery draft", () => {
  test("tries the Recovery of migration N on a target at N-1: its seed data (if asked), its scripts around N's schema change; recorded as a deployed draft", async () => {
    const { dir, database } = await recoveryDraftProject({ deployed: false });
    // Like its rehearsal, a Recovery draft ignores the desired schema.
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );

    const terminal = spawnTerminal(
      ["deploy-draft", "--target", "dev", "--with-seed"],
      { cwd: dir.root },
    );
    const shown = await terminal.waitFor("Type YES");
    expect(shown).toContain(
      "deploy-draft: Deploy the Recovery draft of migration 00002-require-city to target dev",
    );
    expect(shown).toContain("on top of 00001-add-customers");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Deployed the Recovery draft of migration 00002-require-city to dev on top of 00001-add-customers, with seed data",
    );
    expect(await terminal.exited).toBe(0);

    expect(
      await server.query(
        "select id, name, city from customers order by id",
        [],
        database,
      ),
    ).toEqual([
      { id: "1", name: "Ada", city: "Recovered" },
      { id: "3", name: "Cy", city: "Recovered" },
    ]);
    expect(
      await server.query(
        "select is_nullable from information_schema.columns where table_name = 'customers' and column_name = 'city'",
        [],
        database,
      ),
    ).toEqual([{ is_nullable: "NO" }]);
    // Not recorded as migration 2 or its Recovery: a deployed draft.
    expect(
      await server.query(
        "select number, recovery from deployment_history.migrations",
        [],
        database,
      ),
    ).toEqual([{ number: 1, recovery: null }]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).toContain(
      "the target holds draft require-city (deployed by attempt #2 on top of 00001-add-customers, with seed data), not a finalized migration: reset it with rebuild --to 1",
    );
  });

  test("refuses, without asking, a target whose last recorded migration isn't N-1", async () => {
    const { dir, database } = await recoveryDraftProject({ deployed: true });

    const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await terminal.waitFor(
      "Error: The Recovery draft of migration 00002-require-city runs on top of 00001-add-customers, but target dev is at 00002-require-city: run rebuild --to 1 first",
    );
    expect(await terminal.exited).toBe(1);
    expect(terminal.screen).not.toContain("Type YES");
    expect(
      await server.query(
        "select command from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([{ command: "deploy" }, { command: "deploy" }]);
  });
});

/**
 * Migrations 1 (customers, finalized with seed data) and 2 (orders) deployed
 * to a disposable `dev`, which then gets data and objects added by hand.
 */
async function twoMigrations() {
  const { dir, database } = await deployedProject();
  const project = await loadProject({ cwd: dir.root });
  try {
    // Migration 1 was finalized without seed data; give migration 2 some, so
    // a rebuild that loaded seed data would show it.
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key, customer_id bigint not null constraint orders_customer_fkey references customers (id));\n",
    );
    await draft(project, { name: "add orders" });
    await dir.write(
      "data-model/draft/seed-data.sql",
      "insert into customers (id, name) values (7, 'Seeded');\n",
    );
    await finalize(project);
    await deploy(project, { target: "dev" });
  } finally {
    await project.close();
  }
  await server
    .query(`create role rebuild_reader nologin`, [], database)
    .catch(() => {});
  for (const sql of [
    "insert into orders (id, customer_id) values (10, 1)",
    "create table scratch (id int)",
    "create view ada as select * from customers where id = 1",
    "create domain positive as int check (value > 0)",
    "create type mood as enum ('happy', 'sad')",
    "create function twice(x int) returns int language sql return x * 2",
    "create sequence counter",
    // Privileges are target setup (ADR-0006): rebuild leaves them alone.
    "grant usage on schema public to rebuild_reader",
    "revoke usage on schema public from public",
    "alter default privileges in schema public grant execute on functions to rebuild_reader",
    "comment on schema public is 'kept by rebuild'",
  ]) {
    await server.query(sql, [], database);
  }
  return { dir, database };
}

const schemaSetup = `select n.nspowner::regrole::text as owner, n.nspacl::text as acl,
    obj_description(n.oid, 'pg_namespace') as comment,
    (select array_agg(d.defaclacl::text) from pg_default_acl d where d.defaclnamespace = n.oid) as defaults
  from pg_namespace n where n.nspname = 'public'`;

const publicObjects = `select kind, name from (
    select 'relation' as kind, relname::text as name from pg_class where relnamespace = 'public'::regnamespace and relkind <> 'i'
    union all select 'routine', proname::text from pg_proc where pronamespace = 'public'::regnamespace
    union all select 'type', typname::text from pg_type t where typnamespace = 'public'::regnamespace and typrelid = 0 and typelem = 0
  ) o order by kind, name`;

unix("rebuild", () => {
  test("wipes the managed schema and replays migrations up to N without seed data, keeping the schema's owner, comment, grants and default privileges and the attempt log", async () => {
    const { dir, database } = await twoMigrations();
    const [setup] = await server.query<{ acl: string }>(
      schemaSetup,
      [],
      database,
    );
    expect(setup?.acl).toBe(
      "{pg_database_owner=UC/pg_database_owner,rebuild_reader=U/pg_database_owner}",
    );

    const terminal = spawnTerminal(
      ["rebuild", "--target", "dev", "--to", "1"],
      {
        cwd: dir.root,
      },
    );
    const shown = await terminal.waitFor(
      "Type YES to wipe target dev and replay migration 1",
    );
    expect(shown).toContain("rebuild: Wipe target dev and replay migration 1");
    expect(shown).toContain("Last recorded migration: 00002-add-orders");
    expect(shown).toContain(
      "Drops everything in schema public, the recorded migrations, then deploys in one transaction:",
    );
    expect(shown).toContain("Seed data is never loaded");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("Rebuilt dev with 1 migration: 00001-add-customers");
    expect(await terminal.exited).toBe(0);

    expect(await server.query(publicObjects, [], database)).toEqual([
      { kind: "relation", name: "customers" },
    ]);
    expect(
      await server.query(
        "select count(*)::int as count from customers",
        [],
        database,
      ),
    ).toEqual([{ count: 0 }]);
    expect(await server.query(schemaSetup, [], database)).toEqual([setup]);
    expect(
      await server.query(
        "select m.number, m.recorded_how, a.command from deployment_history.migrations m join deployment_history.attempts a on a.id = m.attempt_id",
        [],
        database,
      ),
    ).toEqual([{ number: 1, recorded_how: "deployed", command: "rebuild" }]);
    expect(
      await server.query(
        "select command, outcome, from_migration, to_migration, os_user from deployment_history.attempts order by id",
        [],
        database,
      ),
    ).toEqual([
      expect.objectContaining({ command: "deploy" }),
      expect.objectContaining({ command: "deploy" }),
      {
        command: "rebuild",
        outcome: "succeeded",
        from_migration: 1,
        to_migration: 1,
        os_user: userInfo().username,
      },
    ]);
    expect(
      await server.query(
        "select disposable from deployment_history.settings",
        [],
        database,
      ),
    ).toEqual([{ disposable: true }]);

    // An ordinary deployment carries on from migration 1.
    const deployed = await runCli(["deploy", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(deployed.stdout).toBe(
      "Deployed 1 migration to dev: 00002-add-orders\n",
    );
  });

  test("replays and records each migration's newest variant: Recovery 1 of migration 2, without its seed data", async () => {
    const { dir, database } = await recoveryDraftProject({ deployed: true });
    await dir.write(
      "data-model/draft/post-migration.sql",
      "insert into customers (id, name, city) values (9, 'Recovered', 'Here');\n",
    );
    const project = await loadProject({ cwd: dir.root });
    try {
      await finalize(project);
    } finally {
      await project.close();
    }

    const terminal = spawnTerminal(
      ["rebuild", "--target", "dev", "--to", "2"],
      { cwd: dir.root },
    );
    await terminal.waitFor("Type YES");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Rebuilt dev with 2 migrations: 00001-add-customers, 00002-require-city",
    );
    expect(await terminal.exited).toBe(0);

    // Recovery 1's post-migration script ran; its seed data (Cy) did not load.
    expect(
      await server.query(
        "select id, name, city from customers order by id",
        [],
        database,
      ),
    ).toEqual([{ id: "9", name: "Recovered", city: "Here" }]);
    expect(
      await server.query(
        "select number, recovery, recovery_chain_hash is not null as chained from deployment_history.migrations order by number",
        [],
        database,
      ),
    ).toEqual([
      { number: 1, recovery: null, chained: false },
      { number: 2, recovery: 1, chained: true },
    ]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.stdout).not.toContain("Deploy would refuse");
  });

  test("resets a target holding a deployed draft, so it deploys again", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);
    const deploying = spawnTerminal(["deploy-draft", "--target", "dev"], {
      cwd: dir.root,
    });
    await deploying.waitFor("Type YES");
    deploying.type(`YES${keys.enter}`);
    expect(await deploying.exited).toBe(0);

    const terminal = spawnTerminal(
      ["rebuild", "--target", "dev", "--to", "1"],
      {
        cwd: dir.root,
      },
    );
    const shown = await terminal.waitFor("Type YES");
    expect(shown).toContain("Deployed draft: require-city (attempt #2)");
    expect(shown).toContain(
      "Drops everything in schema public, the recorded migrations, deployed draft require-city, then deploys",
    );
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("Rebuilt dev with 1 migration");
    expect(await terminal.exited).toBe(0);

    expect(
      await server.query(
        "select is_nullable from information_schema.columns where table_name = 'customers' and column_name = 'city'",
        [],
        database,
      ),
    ).toEqual([{ is_nullable: "YES" }]);
    const status = await runCli(["status", "--target", "dev"], {
      cwd: dir.root,
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain("Deploy would refuse");
  });

  test("rolls back when the managed schema holds something it cannot drop, naming it", async () => {
    const { dir, database } = await twoMigrations();
    // A function in public that belongs to an extension living elsewhere:
    // only that extension could drop it.
    await server.query(
      "alter extension plpgsql add function twice(int)",
      [],
      database,
    );

    const terminal = spawnTerminal(
      ["rebuild", "--target", "dev", "--to", "1"],
      {
        cwd: dir.root,
      },
    );
    await terminal.waitFor("Type YES");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Error: Could not wipe schema public on target dev: it still holds function twice(integer); drop them by hand, then run rebuild again (nothing changed)",
    );
    expect(await terminal.exited).toBe(1);
    expect(
      await server.query(
        "select count(*)::int as count from orders",
        [],
        database,
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await server.query(
        "select number from deployment_history.migrations order by number",
        [],
        database,
      ),
    ).toEqual([{ number: 1 }, { number: 2 }]);
    await server.query(
      "alter extension plpgsql drop function twice(int)",
      [],
      database,
    );
  });

  test("leaves the grants the schema's owner made on it", async () => {
    const [owner, deployer, reader] = ["owner", "deployer", "reader"].map(
      (role) => roleName(`rebuild_${role}`),
    ) as [string, string, string];
    const database = targetDatabaseName();
    await server.query(`create role ${owner} nologin`);
    await server.query(`create role ${deployer} login password 'deployer'`);
    await server.query(`create role ${reader} nologin`);
    await server.query(`create database ${database}`);
    // An administrator's setup: app belongs to its owner, and the deploy
    // role is a member of the owner.
    await server.query(`grant ${owner} to ${deployer}`);
    await server.query(
      `create schema app authorization ${owner};
       grant create on database ${database} to ${deployer}`,
      [],
      database,
    );
    const { config } = deployConfig(server, {
      database,
      settings: 'managedSchema: "app",',
      preamble: asDeployerPreamble(database, deployer),
      adapter: "asDeployer",
    });
    const dir = await customersDeployed(config);
    for (const sql of [
      "insert into app.customers (id, name) values (1, 'Ada')",
      "update deployment_history.settings set disposable = true",
      // Later the owner gives a reader USAGE itself (a superuser grants as
      // the owner).
      `grant usage on schema app to ${reader}`,
    ]) {
      await server.query(sql, [], database);
    }

    const terminal = spawnTerminal(
      ["rebuild", "--target", "dev", "--to", "1"],
      { cwd: dir.root },
    );
    await terminal.waitFor("Type YES");
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("Rebuilt dev with 1 migration");
    expect(await terminal.exited).toBe(0);
    expect(
      await server.query("select id, name from app.customers", [], database),
    ).toEqual([]);
    expect(
      await server.query(
        "select has_schema_privilege($1, 'app', 'USAGE') as usage",
        [reader],
        database,
      ),
    ).toEqual([{ usage: true }]);
  });

  test("refuses, without asking, a target that isn't disposable or a migration the repo doesn't have", async () => {
    const notDisposable = await deployedProject({ disposable: false });
    const refused = spawnTerminal(["rebuild", "--target", "dev", "--to", "1"], {
      cwd: notDisposable.dir.root,
    });
    await refused.waitFor(
      "Error: rebuild only runs on disposable targets, and target dev is not disposable",
    );
    expect(await refused.exited).toBe(1);

    const { dir, database } = await deployedProject();
    const unknown = spawnTerminal(["rebuild", "--target", "dev", "--to", "5"], {
      cwd: dir.root,
    });
    await unknown.waitFor(
      "Error: There is no finalized migration 5 (the newest is 1)",
    );
    expect(await unknown.exited).toBe(1);
    expect(unknown.screen).not.toContain("Type YES");
    expect(
      await server.query(
        "select count(*)::int as count from customers",
        [],
        database,
      ),
    ).toEqual([{ count: 1 }]);
  });
});

/**
 * A \`dev\` adapter that, when the CLI runs with TEST_LOSE_COMMIT=before or
 * after, loses the connection at the deploy transaction's COMMIT (after
 * sending it, or instead of sending it).
 */
const losingAdapter = `{
  async connect() {
    const session = await real.connect();
    let deploying = false;
    let lost = false;
    return {
      ...session,
      async execute(sql) {
        if (lost) throw new Error("Client has encountered a connection error and is not queryable");
        deploying ||= sql.includes("lock_timeout");
        const lose = process.env.TEST_LOSE_COMMIT;
        if (deploying && sql === "COMMIT" && lose) {
          if (lose === "after") await session.execute(sql);
          lost = true;
          await session.close();
          throw new Error("Connection terminated unexpectedly");
        }
        return session.execute(sql);
      },
      async close() {
        if (!lost) await session.close();
      },
    };
  },
}`;

unix("deploy-draft's lost COMMIT", () => {
  test.each([
    ["after", "succeeded", "settled as succeeded: its draft is recorded", true],
    ["before", "failed", "settled as failed: its draft is not recorded", false],
  ] as const)(
    "lost %s sending it: unknown, then settled by the next status from whether the draft is recorded",
    async (when, outcome, settled, holds) => {
      const { dir, database } = await deployedProject({
        adapter: losingAdapter,
      });
      await requireCityDraft(dir);

      const terminal = spawnTerminal(["deploy-draft", "--target", "dev"], {
        cwd: dir.root,
        env: { TEST_LOSE_COMMIT: when },
      });
      await terminal.waitFor("Type YES");
      terminal.type(`YES${keys.enter}`);
      await terminal.waitFor("it is unknown whether attempt #2 landed");
      expect(await terminal.exited).toBe(1);

      const status = await runCli(["status", "--target", "dev"], {
        cwd: dir.root,
      });
      expect(status.stdout.includes("holds draft require-city")).toBe(holds);
      const [, attempt] = await server.query<{
        outcome: string;
        error: string;
      }>(
        "select outcome, error from deployment_history.attempts order by id",
        [],
        database,
      );
      expect(attempt?.outcome).toBe(outcome);
      expect(attempt?.error).toContain(settled);
    },
  );
});

unix("from the menu", () => {
  test("deploy-draft asks for the target and whether to load seed data, default no", async () => {
    const { dir, database } = await deployedProject();
    await requireCityDraft(dir);
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    await terminal.chooseMenuItem("deploy-draft");
    await terminal.waitFor("The target to use");
    terminal.type(keys.enter);
    await terminal.waitFor("Load the draft's seed data first");
    terminal.type(keys.enter);
    await terminal.waitFor("Seed data: not loaded");
    await terminal.waitFor(
      "Type YES to deploy draft require-city to target dev",
    );
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor("without seed data");

    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
    expect(
      await server.query(
        "select name from customers order by id",
        [],
        database,
      ),
    ).toEqual([{ name: "Ada" }]);
  });

  test("rebuild offers the migrations newest first", async () => {
    const { dir } = await twoMigrations();
    const terminal = spawnTerminal([], { cwd: dir.root });

    await terminal.waitFor("quit");
    await terminal.chooseMenuItem("rebuild");
    await terminal.waitFor("The target to use");
    terminal.type(keys.enter);
    await terminal.waitFor("The last migration to replay");
    terminal.type(keys.enter);
    await terminal.waitFor(
      "Type YES to wipe target dev and replay migrations 1-2",
    );
    terminal.type(`YES${keys.enter}`);
    await terminal.waitFor(
      "Rebuilt dev with 2 migrations: 00001-add-customers, 00002-add-orders",
    );
    await terminal.waitFor("quit");
    terminal.type(keys.escape);
    expect(await terminal.exited).toBe(0);
  });
});
