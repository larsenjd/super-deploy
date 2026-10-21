// API seam: Recoveries. A migration that fails on a target's real data gets a
// Recovery with replacement scripts and seed data; targets that haven't
// recorded the migration run the newest Recovery instead, and every target
// ends with the same structure.
import { chmod, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  DraftExistsError,
  deploy,
  draft,
  finalize,
  MigrationIntegrityError,
  NoRecoveryError,
  PreflightFailedError,
  RecoveryDraftError,
  RecoverySchemaChangeEditedError,
  RehearsalMismatchError,
  recovery,
  rehearse,
  SqlFileFailedError,
  status,
  UnknownMigrationError,
  unfinalize,
  ValidationFailedError,
  validate,
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type DeployConfigOptions,
  deployProject,
  finalizeMigration,
  targetDatabaseName,
} from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

const customers = `create table customers (
  id bigint primary key,
  email text
);
`;

const requiredEmail = `create table customers (
  id bigint primary key,
  email text not null
);
`;

const migration2 = "data-model/migrations/00002-require-email";

/**
 * Migration 1 (customers) deployed to `dev`, where a customer has no email;
 * migration 2 makes email required, so deploying it to `dev` fails.
 * `options` configure the project (e.g. more targets).
 */
async function failedMigration(options: DeployConfigOptions = {}) {
  const setup = await deployProject(
    server,
    { "customers.sql": customers },
    options,
  );
  await finalizeMigration(setup.project, "add customers");
  await deploy(setup.project, { target: "dev" });
  await server.query(
    "insert into customers (id, email) values (1, null)",
    [],
    setup.database,
  );
  await setup.dir.write(
    "data-model/desired-schema/customers.sql",
    requiredEmail,
  );
  await finalizeMigration(setup.project, "require email");
  await expect(deploy(setup.project, { target: "dev" })).rejects.toThrow(
    SqlFileFailedError,
  );
  return setup;
}

/** Every file under `folder`, relative to it, sorted. */
async function listFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"),
    )
    .sort();
}

/** A SQL file's lines that aren't comments or blank: its statements. */
function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("--"));
}

describe("recovery", () => {
  test("creates a Recovery draft carrying the migration's schema change unchanged", async () => {
    const { dir, project } = await failedMigration();
    const original = await dir.read(`${migration2}/schema-change.sql`);

    const result = await recovery(project, { migration: 2 });

    expect(result).toMatchObject({
      migration: 2,
      folder: "00002-require-email",
      recovery: 1,
    });
    const copy = await dir.read("data-model/draft/schema-change.sql");
    expect(statementsOf(copy)).toEqual(statementsOf(original));
    expect(copy).toContain("00002-require-email");
    expect(copy).not.toContain("run draft again");
    expect(await dir.read(`${migration2}/schema-change.sql`)).toBe(original);
    expect(JSON.parse(await dir.read("data-model/draft/draft.json"))).toEqual({
      name: "require-email",
      recoveryOf: 2,
    });
  });

  test("is refused while another draft exists, and for a migration that doesn't exist", async () => {
    const { dir, project } = await failedMigration();
    await recovery(project, { migration: 2 });

    await expect(recovery(project, { migration: 1 })).rejects.toThrow(
      DraftExistsError,
    );
    await dir.write("data-model/draft/draft.json", '{"name": "add-orders"}\n');
    await expect(recovery(project, { migration: 2 })).rejects.toThrow(
      DraftExistsError,
    );
    await rm(dir.path("data-model/draft"), { recursive: true });
    await expect(recovery(project, { migration: 3 })).rejects.toThrow(
      UnknownMigrationError,
    );
    expect(dir.exists("data-model/draft")).toBe(false);
  });
});

const backfill =
  "update customers set email = 'unknown@example.com' where email is null;\n";
/** `backfill` as replay sends it: statement by statement, without the semicolon. */
const backfillStatement = backfill.replace(/;\n$/, "");
const nullEmail = "insert into customers (id, email) values (7, null);\n";
const recovery1 = `${migration2}/recoveries/recovery-1`;

describe("finalizing a Recovery", () => {
  test("freezes its scripts and seed data under its migration, leaving the migration's hashes alone", async () => {
    const { dir, project } = await failedMigration();
    const before = JSON.parse(
      await dir.read("data-model/migrations/index.json"),
    );
    await recovery(project, { migration: 2 });
    await dir.write("data-model/draft/pre-migration.sql", backfill);
    await dir.write("data-model/draft/seed-data.sql", nullEmail);

    const result = await finalize(project);

    expect(result).toMatchObject({
      number: 2,
      folder: "00002-require-email",
      recovery: 1,
      path: dir.path(recovery1),
    });
    expect(await listFiles(dir.path(recovery1))).toEqual([
      "metadata.json",
      "pre-migration.sql",
      "seed-data.sql",
    ]);
    expect(await dir.read(`${recovery1}/pre-migration.sql`)).toBe(backfill);
    for (const file of await listFiles(dir.path(recovery1))) {
      const { mode } = await stat(dir.path(`${recovery1}/${file}`));
      expect({ file, writable: (mode & 0o222) !== 0 }).toEqual({
        file,
        writable: false,
      });
    }
    const index = JSON.parse(
      await dir.read("data-model/migrations/index.json"),
    );
    expect(index.migrations[0]).toEqual(before.migrations[0]);
    expect(index.migrations[1]).toEqual({
      ...before.migrations[1],
      recoveries: [
        {
          folder: "recovery-1",
          contentHash: result.contentHash,
          chainHash: result.chainHash,
        },
      ],
    });
    expect(result.chainHash).not.toBe(before.migrations[1].chainHash);
    expect(dir.exists("data-model/draft")).toBe(false);
    expect((await validate(project, { strict: true })).migrations).toBe(2);
  });

  test("rehearses with the Recovery's seed data, so its scripts must handle it", async () => {
    const { dir, project } = await failedMigration();
    await recovery(project, { migration: 2 });
    await dir.write("data-model/draft/seed-data.sql", nullEmail);

    const error = await finalize(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SqlFileFailedError);
    expect((error as SqlFileFailedError).file).toBe(
      "data-model/draft/schema-change.sql",
    );
    expect(dir.exists(`${migration2}/recoveries`)).toBe(false);
  });

  test("is refused when it would change the migration's structural result", async () => {
    const { dir, project } = await failedMigration();
    await recovery(project, { migration: 2 });
    await dir.write(
      "data-model/draft/pre-migration.sql",
      `${backfill}alter table customers add column note text;\n`,
    );

    const error = await finalize(project).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RehearsalMismatchError);
    expect((error as Error).message).toContain(
      "does not end in the same structure as migration 00002-require-email",
    );
    expect((error as RehearsalMismatchError).differences).toContainEqual(
      expect.stringMatching(
        /^catalog: from the Recovery: column: customers\.note text /,
      ),
    );
    expect(dir.exists(`${migration2}/recoveries`)).toBe(false);
  });

  test("is refused when its schema change was edited, and draft never regenerates it", async () => {
    const { dir, project } = await failedMigration();
    await recovery(project, { migration: 2 });

    await expect(draft(project)).rejects.toThrow(RecoveryDraftError);
    await expect(draft(project, { name: "other" })).rejects.toThrow(
      RecoveryDraftError,
    );
    await dir.write(
      "data-model/draft/schema-change.sql",
      "alter table customers add column note text;\n",
    );
    await expect(rehearse(project)).rejects.toThrow(
      RecoverySchemaChangeEditedError,
    );
    await expect(finalize(project)).rejects.toThrow(
      RecoverySchemaChangeEditedError,
    );

    // A verbatim copy, as Recovery drafts made by older versions hold, is still the migration's.
    await dir.write(
      "data-model/draft/schema-change.sql",
      await dir.read(`${migration2}/schema-change.sql`),
    );
    await expect(rehearse(project)).resolves.toMatchObject({ recoveryOf: 2 });
  });
});

/** Recovery 1 of migration 2: backfills missing emails, with seed data that needs it. */
async function finalizeRecovery(
  setup: Awaited<ReturnType<typeof failedMigration>>,
) {
  await recovery(setup.project, { migration: 2 });
  await setup.dir.write("data-model/draft/pre-migration.sql", backfill);
  await setup.dir.write("data-model/draft/seed-data.sql", nullEmail);
  return finalize(setup.project);
}

/**
 * A rehearsal adapter that logs every SQL batch its throwaway databases run
 * in `globalThis.rehearsalSql` (when it is an array).
 */
const loggingRehearsal = `{
  async createDatabase(request) {
    const database = await postgres.rehearsal.createDatabase(request);
    return {
      ...database,
      name: database.name,
      drop: () => database.drop(),
      async connect() {
        const session = await database.connect();
        return {
          ...session,
          execute(sql) {
            globalThis.rehearsalSql?.push(sql);
            return session.execute(sql);
          },
          query: (sql, values) => session.query(sql, values),
          serverVersion: () => session.serverVersion(),
          close: () => session.close(),
        };
      },
    };
  },
  close: () => postgres.rehearsal.close(),
}`;

/** The SQL batches the rehearsal adapter ran during `run`. */
async function rehearsalSqlOf(run: () => Promise<unknown>): Promise<string[]> {
  const log: string[] = [];
  Object.assign(globalThis, { rehearsalSql: log });
  try {
    await run();
  } finally {
    Object.assign(globalThis, { rehearsalSql: undefined });
  }
  return log;
}

describe("deploying with Recoveries", () => {
  test("a target that hasn't recorded the migration runs its newest Recovery, and records it", async () => {
    const setup = await failedMigration();
    const finalized = await finalizeRecovery(setup);

    const result = await deploy(setup.project, { target: "dev" });

    expect(result.deployed.map(({ folder }) => folder)).toEqual([
      "00002-require-email",
    ]);
    expect(
      await server.query("select id, email from customers", [], setup.database),
    ).toEqual([{ id: "1", email: "unknown@example.com" }]);
    const report = await status(setup.project, { target: "dev" });
    expect(report.recorded.map((r) => [r.number, r.recovery])).toEqual([
      [1, undefined],
      [2, 1],
    ]);
    expect(report.recorded[1]?.recoveryChainHash).toBe(finalized.chainHash);
    expect(report.drift).toEqual([]);
    // The seed data never reaches a target.
    expect(
      await server.query(
        "select count(*)::int as n from customers where id = 7",
        [],
        setup.database,
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("status and deploy report the Recovery a pending migration runs", async () => {
    const setup = await failedMigration();
    await finalizeRecovery(setup);
    const viaRecovery1 = {
      number: 2,
      name: "require-email",
      folder: "00002-require-email",
      recovery: 1,
    };

    const before = await status(setup.project, { target: "dev" });
    const result = await deploy(setup.project, { target: "dev" });

    expect(before.pending).toStrictEqual([viaRecovery1]);
    expect(result.deployed).toStrictEqual([viaRecovery1]);
  });

  test("the drift replica replays each target's recorded variant", async () => {
    const qa = targetDatabaseName();
    const setup = await failedMigration({
      otherTargets: `qa: { adapter: postgres.target(${JSON.stringify(qa)}) },`,
      rehearsal: loggingRehearsal,
    });
    // qa had no problem data: it ran migration 2's original.
    await deploy(setup.project, { target: "qa" });
    await finalizeRecovery(setup);
    await deploy(setup.project, { target: "dev" });

    const devReplica = await rehearsalSqlOf(() =>
      status(setup.project, { target: "dev" }),
    );
    const qaReplica = await rehearsalSqlOf(() =>
      status(setup.project, { target: "qa" }),
    );

    expect(devReplica).toContain(backfillStatement);
    expect(qaReplica).not.toContain(backfillStatement);
    expect(qaReplica.some((sql) => sql.includes("SET NOT NULL"))).toBe(true);
    // deploy's replica of qa (up to date) replays its recorded original too.
    const later = await rehearsalSqlOf(() =>
      deploy(setup.project, { target: "qa" }),
    );
    expect(later).not.toContain(backfillStatement);
  });
});

describe("unfinalize with Recoveries", () => {
  test("moves the newest migration's newest Recovery back into a Recovery draft, and finalizing again reproduces it", async () => {
    const setup = await failedMigration();
    const { dir, project } = setup;
    const before = await dir.read("data-model/migrations/index.json");
    await finalizeRecovery(setup);
    const withRecovery = await dir.read("data-model/migrations/index.json");

    const result = await unfinalize(project);

    expect(result).toMatchObject({
      number: 2,
      folder: "00002-require-email",
      recovery: 1,
      restored: [],
      deleted: [],
    });
    expect(await dir.read("data-model/migrations/index.json")).toBe(before);
    expect(dir.exists(`${migration2}/recoveries`)).toBe(false);
    expect(dir.exists(`${migration2}/schema-change.sql`)).toBe(true);
    expect(await listFiles(dir.path("data-model/draft"))).toEqual([
      "draft.json",
      "pre-migration.sql",
      "schema-change.sql",
      "seed-data.sql",
    ]);
    expect(JSON.parse(await dir.read("data-model/draft/draft.json"))).toEqual({
      name: "require-email",
      recoveryOf: 2,
    });
    expect(await dir.read("data-model/draft/pre-migration.sql")).toBe(backfill);
    expect(await dir.read("data-model/draft/schema-change.sql")).not.toContain(
      "run draft again",
    );

    await finalize(project);
    expect(await dir.read("data-model/migrations/index.json")).toBe(
      withRecovery,
    );
  });

  test("recoveryOf picks an older migration's newest Recovery; a migration without one is refused", async () => {
    const setup = await failedMigration();
    const { dir, project } = setup;
    await finalizeRecovery(setup);
    await dir.write(
      "data-model/desired-schema/orders.sql",
      "create table orders (id bigint primary key);\n",
    );
    await finalizeMigration(project, "add orders");

    await expect(unfinalize(project, { recoveryOf: 1 })).rejects.toThrow(
      NoRecoveryError,
    );
    const result = await unfinalize(project, { recoveryOf: 2 });

    expect(result).toMatchObject({ number: 2, recovery: 1 });
    expect(dir.exists(`${migration2}/recoveries`)).toBe(false);
    expect(dir.exists("data-model/migrations/00003-add-orders")).toBe(true);
    expect(dir.exists("data-model/desired-schema/orders.sql")).toBe(true);
  });
});

describe("the deploy pre-flight", () => {
  test("refuses a target that records a Recovery the project doesn't have, or has differently", async () => {
    const setup = await failedMigration();
    const { dir, project } = setup;
    await finalizeRecovery(setup);
    await deploy(project, { target: "dev" });
    await unfinalize(project);

    let report = await status(project, { target: "dev" });
    expect(report.preflight.historyMismatches).toEqual([
      {
        number: 2,
        reason: "recovery",
        message:
          "the target records migration 00002-require-email with Recovery 1, which the repo doesn't have: restore 00002-require-email/recoveries/recovery-1 (and index.json) from version control (a Recovery a target has run must never change, so put new changes in a new Recovery)",
      },
    ]);
    expect(report.drift).toBeUndefined();
    await expect(deploy(project, { target: "dev" })).rejects.toThrow(
      PreflightFailedError,
    );

    await dir.write(
      "data-model/draft/pre-migration.sql",
      `-- a different Recovery 1\n${backfill}`,
    );
    await finalize(project);
    report = await status(project, { target: "dev" });
    expect(report.preflight.historyMismatches).toMatchObject([
      { number: 2, reason: "recovery" },
    ]);
    expect(report.preflight.historyMismatches[0]?.message).toMatch(
      /^the target records migration 00002-require-email Recovery 1 with chain hash [0-9a-f]{64}, but the repo's is [0-9a-f]{64}: restore 00002-require-email\/recoveries\/recovery-1 \(and index\.json\) from version control \(a Recovery a target has run must never change, so put new changes in a new Recovery\)$/,
    );
  });
});

describe("validate", () => {
  test("checks Recoveries' hashes and restores their read-only state", async () => {
    const setup = await failedMigration();
    const { dir, project } = setup;
    await finalizeRecovery(setup);
    const script = dir.path(`${recovery1}/pre-migration.sql`);
    await chmod(script, 0o644);

    const report = await validate(project, { strict: true });

    expect(report).toMatchObject({ migrations: 2, recoveries: 1 });
    expect(report.readOnlyRestored).toEqual([`${recovery1}/pre-migration.sql`]);
    expect((await stat(script)).mode & 0o222).toBe(0);

    // Line endings alone don't count; any other edit does.
    await chmod(script, 0o644);
    await writeFile(script, backfill.replaceAll("\n", "\r\n"));
    await validate(project, { strict: true });
    await chmod(script, 0o644);
    await writeFile(script, `${backfill}-- edited\n`);
    const error = await validate(project).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect((error as ValidationFailedError).problems).toEqual([
      {
        severity: "error",
        code: "content-hash-mismatch",
        message: `${recovery1} was changed after it was finalized (its content hash does not match data-model/migrations/index.json)`,
        path: recovery1,
      },
    ]);
    await expect(deploy(project, { target: "dev" })).rejects.toThrow(
      MigrationIntegrityError,
    );
  });

  test("reports Recovery folders that finalize didn't create", async () => {
    const setup = await failedMigration();
    const { dir, project } = setup;
    await finalizeRecovery(setup);
    await dir.write(
      `${migration2}/recoveries/recovery-2/pre-migration.sql`,
      backfill,
    );
    await dir.write(
      `${migration2}/recoveries/.finalizing-recovery-3/x.sql`,
      "",
    );

    const error = await validate(project).catch((e: unknown) => e);

    expect(
      (error as ValidationFailedError).problems.map(({ code, path }) => ({
        code,
        path,
      })),
    ).toEqual([
      {
        code: "invalid-folder-name",
        path: `${migration2}/recoveries/.finalizing-recovery-3`,
      },
      {
        code: "migration-unindexed",
        path: `${migration2}/recoveries/recovery-2`,
      },
    ]);
  });

  test("applies the rules to Recoveries and Recovery drafts, and lists their overrides", async () => {
    const setup = await failedMigration();
    const { dir, project } = setup;
    await recovery(project, { migration: 2 });
    await dir.write(
      "data-model/draft/pre-migration.sql",
      `-- OVERRIDE SUPER-DEPLOY REFUSAL: one recovery at a time
update customers set email = 'unknown@example.com' where email is null and pg_try_advisory_lock(42);
`,
    );
    const override = {
      line: 1,
      object: "UPDATE customers",
      rules: ["denylisted-call"],
      reason: "one recovery at a time",
    };

    // A Recovery draft is unfinished work, not an undrafted desired schema.
    const drafted = await validate(project);
    expect(
      drafted.problems.map(({ code, message }) => ({ code, message })),
    ).toEqual([
      {
        code: "unfinalized-draft",
        message:
          "Draft require-email (a Recovery of migration 00002-require-email) is not finalized yet",
      },
    ]);
    expect(drafted.overrides).toEqual([
      { file: "data-model/draft/pre-migration.sql", ...override },
    ]);

    await finalize(project);
    expect((await validate(project, { strict: true })).overrides).toEqual([
      { file: `${recovery1}/pre-migration.sql`, ...override },
    ]);

    await recovery(project, { migration: 2 });
    await dir.write("data-model/draft/post-migration.sql", "select 1;\n");
    await dir.write(
      "data-model/draft/schema-change.sql",
      "alter table customers add column note text;\n",
    );
    const error = await validate(project).catch((e: unknown) => e);
    expect(
      (error as ValidationFailedError).problems
        .filter((p) => p.severity === "error")
        .map(({ code, path }) => ({ code, path })),
    ).toEqual([
      {
        code: "recovery-schema-change-edited",
        path: "data-model/draft/schema-change.sql",
      },
      {
        code: "sql-rule-violation",
        path: "data-model/draft/post-migration.sql",
      },
    ]);
  });
});
