// Deploy-time rules at the SQL-analysis seam (database-free): generated
// schema changes, pre- and post-migration scripts and seed data.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyseMigration,
  checkRules,
  type DeployTimeKind,
  identityColumnsOf,
  parseSqlFile,
  ruleCatalogue,
  ruleDefinition,
} from "../../../src/sql-analysis/index.ts";

const paths: Record<DeployTimeKind, string> = {
  "schema-change": "data-model/draft/schema-change.sql",
  "pre-migration": "data-model/draft/pre-migration.sql",
  "post-migration": "data-model/draft/post-migration.sql",
  "seed-data": "data-model/draft/seed-data.sql",
};

const allKinds = Object.keys(paths) as DeployTimeKind[];

async function check(
  kind: DeployTimeKind,
  sql: string,
  managedSchema?: string,
) {
  return checkRules(
    { path: paths[kind], text: sql },
    kind,
    managedSchema === undefined ? {} : { managedSchema },
  );
}

/** The rule ids a statement breaks, deduplicated. */
async function rulesBroken(kind: DeployTimeKind, sql: string) {
  return [...new Set((await check(kind, sql)).map((v) => v.rule))];
}

describe("generated schema changes", () => {
  const corpus = join(
    import.meta.dirname,
    "fixtures",
    "pg-delta-schema-changes",
  );

  test("accept every schema change pg-delta generated in the differ prototype", async () => {
    const files = (await readdir(corpus)).filter((name) =>
      name.endsWith(".sql"),
    );
    expect(files.length).toBeGreaterThan(80);
    for (const name of files) {
      const text = await readFile(join(corpus, name), "utf8");
      expect({ name, violations: await check("schema-change", text) }).toEqual({
        name,
        violations: [],
      });
    }
  });
});

describe("privileges, roles, ownership, row-level security and SECURITY DEFINER", () => {
  // Set up on targets outside super-deploy (ADR-0006), in every kind of file.
  const refused = [
    ["GRANT", "grant select on t to reader", /^GRANT is not supported/],
    [
      "GRANT on the managed schema",
      "grant usage on schema public to reader",
      /^GRANT is not supported/,
    ],
    [
      "REVOKE",
      "revoke execute on function f() from public",
      /^REVOKE is not supported/,
    ],
    [
      "CREATE POLICY",
      "create policy p on t using (true)",
      /^CREATE POLICY is not supported/,
    ],
    [
      "ALTER POLICY",
      "alter policy p on t using (false)",
      /^ALTER POLICY is not supported/,
    ],
    ["DROP POLICY", "drop policy p on t", /^DROP POLICY is not supported/],
    [
      "ENABLE ROW LEVEL SECURITY",
      "alter table t enable row level security",
      /^ALTER TABLE \.\.\. ENABLE ROW LEVEL SECURITY is not supported/,
    ],
    [
      "FORCE ROW LEVEL SECURITY",
      "alter table t force row level security",
      /^ALTER TABLE \.\.\. FORCE ROW LEVEL SECURITY is not supported/,
    ],
    [
      "DISABLE ROW LEVEL SECURITY",
      "alter table t disable row level security",
      /^ALTER TABLE \.\.\. DISABLE ROW LEVEL SECURITY is not supported/,
    ],
    [
      "SECURITY DEFINER function",
      "create function f() returns int language sql security definer return 1",
      /^SECURITY DEFINER is not supported/,
    ],
    [
      "ALTER FUNCTION ... SECURITY DEFINER",
      "alter function f() security definer",
      /^SECURITY DEFINER is not supported/,
    ],
    ["CREATE ROLE", "create role r", /^CREATE ROLE is not supported/],
    ["ALTER ROLE", "alter role r nologin", /^ALTER ROLE is not supported/],
    [
      "ALTER ROLE ... SET",
      "alter role r set search_path = app",
      /^ALTER ROLE \.\.\. SET is not supported/,
    ],
    [
      "ALTER ROLE ... RENAME",
      "alter role r rename to q",
      /^ALTER ROLE \.\.\. RENAME is not supported/,
    ],
    ["DROP ROLE", "drop role r", /^DROP ROLE is not supported/],
    ["role membership", "grant a to b", /^GRANT role is not supported/],
    [
      "OWNER TO",
      "alter function f() owner to r",
      /^ALTER \.\.\. OWNER TO is not supported/,
    ],
    [
      "ALTER TABLE ... OWNER TO",
      "alter table t owner to r",
      /^ALTER TABLE \.\.\. OWNER TO is not supported/,
    ],
    [
      "ALTER DEFAULT PRIVILEGES",
      "alter default privileges grant select on tables to reader",
      /^ALTER DEFAULT PRIVILEGES is not supported/,
    ],
    [
      "REASSIGN OWNED",
      "reassign owned by a to b",
      /^REASSIGN OWNED is not supported/,
    ],
    ["DROP OWNED", "drop owned by a", /^DROP OWNED is not supported/],
  ] as const;

  test.each(
    allKinds.flatMap((kind) =>
      refused.map(
        ([name, sql, message]) => [kind, name, sql, message] as const,
      ),
    ),
  )("%s refuses %s", async (kind, _name, sql, message) => {
    const found = await check(kind, `${sql};`);
    expect(found).toEqual([
      expect.objectContaining({
        rule: "unsupported-object",
        message: expect.stringMatching(message),
      }),
    ]);
    expect(found[0]?.message).toMatch(/set up on targets outside super-deploy/);
  });

  test("an override marker can't bypass them", async () => {
    const found = await check(
      "post-migration",
      "-- OVERRIDE SUPER-DEPLOY REFUSAL: the app needs it\ngrant select on t to reader;",
    );
    expect(found.map(({ rule }) => rule)).toContain("unsupported-object");
  });

  test("COMMENT keeps its rule: allowed in a schema change only", async () => {
    const sql = "comment on policy p on t is 'x';";
    expect(await check("schema-change", sql)).toEqual([]);
    expect(await rulesBroken("post-migration", sql)).toEqual([
      "deploy-time-statement",
    ]);
  });
});

describe("transaction control, CALL and DO", () => {
  test.each([
    ["begin", "transaction-control"],
    ["start transaction", "transaction-control"],
    ["commit", "transaction-control"],
    ["end", "transaction-control"],
    ["commit and chain", "transaction-control"],
    ["rollback", "transaction-control"],
    ["abort", "transaction-control"],
    ["savepoint s", "transaction-control"],
    ["release savepoint s", "transaction-control"],
    ["rollback to savepoint s", "transaction-control"],
    ["prepare transaction 'x'", "transaction-control"],
    ["commit prepared 'x'", "transaction-control"],
    ["rollback prepared 'x'", "transaction-control"],
    ["set transaction isolation level serializable", "transaction-control"],
    [
      "set session characteristics as transaction read only",
      "transaction-control",
    ],
    ["call do_work()", "call-statement"],
    ["do $$ begin perform 1; end $$", "do-statement"],
  ])("refuse %j in every kind of file", async (sql, rule) => {
    for (const kind of allKinds) {
      expect({ kind, rules: await rulesBroken(kind, sql) }).toEqual({
        kind,
        rules: [rule],
      });
    }
  });

  test("report file, line, statement and rule", async () => {
    const violations = await check(
      "post-migration",
      "update customers set name = 'x';\n\n-- done\ncommit;\n",
    );

    expect(violations).toEqual([
      {
        file: "data-model/draft/post-migration.sql",
        line: 4,
        statement: "commit",
        rule: "transaction-control",
        message:
          "COMMIT would end the deploy transaction early; super-deploy runs every pending migration in one transaction",
      },
    ]);
  });
});

describe("a migration's files", () => {
  test("are checked in order, each against its own kind", async () => {
    const analysis = await analyseMigration([
      { path: paths["pre-migration"], kind: "pre-migration", text: "begin;" },
      {
        path: paths["schema-change"],
        kind: "schema-change",
        text: "create table t (a int);",
      },
      {
        path: paths["post-migration"],
        kind: "post-migration",
        text: "rollback;",
      },
    ]);

    expect(analysis.violations.map((v) => [v.file, v.rule])).toEqual([
      [paths["pre-migration"], "transaction-control"],
      [paths["post-migration"], "transaction-control"],
    ]);
  });
});

// One refused fixture for every hazard the spec refuses, and one allowed
// fixture for every form it allows, keyed by the section numbers of
// .scratch/super-deploy/research/transactional-hazards.md. Each fixture is
// checked in a pre-migration script (the most permissive script kind)
// unless it names another kind. Hazards that are operational notes with no
// SQL form (2.12, 2.26, 5.5, 5.6, 5.12-5.15, 6.11, 7.15, 8.5, 8.10, 8.11,
// 8.16) have no fixture.
type Expected = string | readonly string[];
interface Fixture {
  readonly hazard: string;
  readonly sql: string;
  readonly kind?: DeployTimeKind;
  /** Rule ids the statement breaks, or "allowed". */
  readonly expected: Expected;
}

const refused = (
  hazard: string,
  sql: string,
  expected: Expected,
  kind?: DeployTimeKind,
): Fixture =>
  kind === undefined
    ? { hazard, sql, expected }
    : { hazard, sql, expected, kind };
const allowed = (hazard: string, sql: string, kind?: DeployTimeKind): Fixture =>
  refused(hazard, sql, "allowed", kind);

/** A denylisted call, placed where a statement may call functions. */
const call = (expression: string) =>
  `update t set note = (${expression})::text`;

const hazardFixtures: readonly Fixture[] = [
  // §1 Statements that cannot run inside a transaction block
  refused(
    "1.1",
    "create index concurrently t_a_idx on t (a)",
    "not-in-transaction",
  ),
  refused(
    "1.1",
    "create index concurrently t_a_idx on t (a)",
    "not-in-transaction",
    "schema-change",
  ),
  refused("1.2", "reindex table concurrently t", "not-in-transaction"),
  refused("1.3", "reindex schema app", "not-in-transaction"),
  refused("1.3", "reindex database app", "not-in-transaction"),
  refused("1.3", "reindex system app", "not-in-transaction"),
  refused("1.4", "reindex table t", "deploy-time-statement"),
  refused("1.4", "reindex index t_a_idx", "deploy-time-statement"),
  refused("1.5", "drop index concurrently t_a_idx", "not-in-transaction"),
  refused(
    "1.6",
    "alter table t detach partition t_2024 concurrently",
    "not-in-transaction",
  ),
  refused(
    "1.7",
    "alter table t detach partition t_2024 finalize",
    "not-in-transaction",
  ),
  refused("1.8", "vacuum t", "not-in-transaction"),
  refused("1.8", "vacuum full t", "not-in-transaction"),
  refused("1.8", "vacuum (analyze) t", "not-in-transaction"),
  allowed("1.8", "analyze t"),
  allowed("1.8", "analyze t", "post-migration"),
  refused("1.9", "cluster", "not-in-transaction"),
  refused("1.9", "cluster t using t_pkey", "deploy-time-statement"),
  refused("1.10", "create database other", "not-in-transaction"),
  refused("1.10", "drop database other", "not-in-transaction"),
  refused(
    "1.11",
    "alter database app set tablespace fast",
    "not-in-transaction",
  ),
  refused(
    "1.11",
    "alter database app set work_mem = '64MB'",
    "escapes-transaction",
  ),
  refused(
    "1.11",
    "alter database app refresh collation version",
    "escapes-transaction",
  ),
  refused(
    "1.12",
    "create tablespace fast location '/mnt/fast'",
    "not-in-transaction",
  ),
  refused("1.12", "drop tablespace fast", "not-in-transaction"),
  refused("1.13", "alter system set work_mem = '64MB'", "not-in-transaction"),
  refused("1.14", "discard all", "not-in-transaction"),
  refused("1.15", "commit prepared 'deploy'", "transaction-control"),
  refused("1.15", "rollback prepared 'deploy'", "transaction-control"),
  refused(
    "1.16",
    "create subscription s connection 'host=x' publication p",
    "not-in-transaction",
  ),
  refused(
    "1.17",
    "alter subscription s refresh publication",
    "not-in-transaction",
  ),
  refused(
    "1.17",
    "alter subscription s set (two_phase = false)",
    "not-in-transaction",
  ),
  refused("1.18", "drop subscription s", "not-in-transaction"),
  refused("1.19", "call do_work()", "call-statement"),
  refused(
    "1.20",
    call("pg_create_logical_replication_slot('s', 'pgoutput')"),
    "denylisted-call",
  ),
  refused("1.21", "BASE_BACKUP", "syntax-error"),
  refused("1.22", "alter type mood add value 'meh'", "unsupported-object"),
  refused(
    "1.23",
    "set transaction isolation level serializable",
    "transaction-control",
  ),
  refused(
    "1.23",
    "set transaction snapshot '00000003-0000001B-1'",
    "transaction-control",
  ),
  refused("1.23", "set transaction read write", "transaction-control"),
  refused("1.24", "savepoint before_backfill", "transaction-control"),
  allowed("1.24", "lock table t in share row exclusive mode"),
  allowed("1.24", "lock table t", "post-migration"),

  // §2 Effects that escape the transaction
  allowed(
    "2.1",
    "insert into orders (code) values (nextval('order_codes'))",
    "post-migration",
  ),
  refused("2.1", "alter table t add column code serial", "unsupported-object"),
  refused(
    "2.1",
    "alter table t add column code bigserial",
    "unsupported-object",
  ),
  refused("2.2", call("setval('t_id_seq', 1)"), "denylisted-call"),
  allowed("2.3", "alter sequence t_id_seq restart with 100"),
  allowed("2.3", "truncate t restart identity", "post-migration"),
  refused("2.4", call("pg_advisory_lock(1)"), "denylisted-call"),
  refused("2.4", call("pg_advisory_lock_shared(1)"), "denylisted-call"),
  refused("2.4", call("pg_try_advisory_lock(1)"), "denylisted-call"),
  refused("2.4", call("pg_advisory_unlock(1)"), "denylisted-call"),
  refused("2.4", call("pg_advisory_unlock_all()"), "denylisted-call"),
  allowed("2.4", call("pg_advisory_xact_lock(1)"), "post-migration"),
  allowed("2.4", call("pg_try_advisory_xact_lock(1)"), "post-migration"),
  refused("2.5", "set search_path = app", "escapes-transaction"),
  refused("2.5", "set local search_path = app", "escapes-transaction"),
  refused("2.5", "set session work_mem = '1GB'", "escapes-transaction"),
  refused("2.5", "reset all", "escapes-transaction"),
  refused("2.5", "reset search_path", "escapes-transaction"),
  refused("2.5", "set role admin", "escapes-transaction"),
  refused("2.5", "set session authorization admin", "escapes-transaction"),
  refused(
    "2.5",
    call("set_config('search_path', 'app', false)"),
    "denylisted-call",
  ),
  refused(
    "2.5",
    call("set_config('search_path', 'app', true)"),
    "denylisted-call",
  ),
  refused(
    "2.5",
    call("set_config('lock_timeout', '0', is_local => true)"),
    "denylisted-call",
  ),
  refused(
    "2.6",
    "set session_replication_role = replica",
    "escapes-transaction",
  ),
  refused("2.7", "notify orders_changed", "escapes-transaction"),
  refused("2.7", call("pg_notify('orders_changed', 'x')"), "denylisted-call"),
  refused("2.8", "listen orders_changed", "escapes-transaction"),
  refused("2.8", "unlisten *", "escapes-transaction"),
  refused(
    "2.9",
    call("dblink_exec('host=x', 'delete from t')"),
    "denylisted-call",
  ),
  refused(
    "2.10",
    "create foreign table f (a int) server s",
    "unsupported-object",
  ),
  refused(
    "2.10",
    "create server s foreign data wrapper postgres_fdw",
    "unsupported-object",
  ),
  refused("2.10", "create foreign data wrapper w", "unsupported-object"),
  refused(
    "2.10",
    "create user mapping for current_user server s",
    "unsupported-object",
  ),
  refused(
    "2.10",
    "import foreign schema remote from server s into app",
    "unsupported-object",
  ),
  refused("2.11", "copy t (a) to '/tmp/t.csv'", "escapes-transaction"),
  refused("2.11", "copy t (a) to program 'cat'", "escapes-transaction"),
  refused("2.11", "copy t (a) from program 'cat'", "escapes-transaction"),
  refused("2.11", "copy t (a) from stdin", "escapes-transaction"),
  refused(
    "2.13",
    "copy t (a) from '/tmp/t.csv' with (freeze)",
    "escapes-transaction",
  ),
  refused("2.14", call("lo_import('/etc/passwd')"), "denylisted-call"),
  refused("2.14", call("lo_export(1, '/tmp/x')"), "denylisted-call"),
  refused("2.14", call("lo_unlink(1)"), "denylisted-call"),
  refused("2.15", call("pg_terminate_backend(1)"), "denylisted-call"),
  refused("2.15", call("pg_cancel_backend(1)"), "denylisted-call"),
  refused("2.15", call("pg_reload_conf()"), "denylisted-call"),
  refused("2.15", call("pg_rotate_logfile()"), "denylisted-call"),
  refused("2.15", call("pg_switch_wal()"), "denylisted-call"),
  refused("2.15", call("pg_create_restore_point('x')"), "denylisted-call"),
  refused("2.15", call("pg_log_backend_memory_contexts(1)"), "denylisted-call"),
  refused("2.15", call("pg_promote()"), "denylisted-call"),
  refused("2.15", call("pg_wal_replay_pause()"), "denylisted-call"),
  refused("2.15", call("pg_wal_replay_resume()"), "denylisted-call"),
  refused("2.15", call("pg_stat_reset()"), "denylisted-call"),
  refused("2.15", call("pg_stat_reset_shared('io')"), "denylisted-call"),
  refused("2.15", call("pg_backup_start('x')"), "denylisted-call"),
  refused("2.15", call("pg_backup_stop()"), "denylisted-call"),
  refused(
    "2.16",
    call("pg_create_physical_replication_slot('s')"),
    "denylisted-call",
  ),
  refused("2.16", call("pg_drop_replication_slot('s')"), "denylisted-call"),
  refused(
    "2.16",
    call("pg_copy_logical_replication_slot('s', 't')"),
    "denylisted-call",
  ),
  refused(
    "2.16",
    call("pg_replication_slot_advance('s', '0/0')"),
    "denylisted-call",
  ),
  refused(
    "2.17",
    call("pg_logical_emit_message(false, 'p', 'x')"),
    "denylisted-call",
  ),
  refused("2.18", call("pg_replication_origin_create('o')"), "denylisted-call"),
  refused(
    "2.18",
    call("pg_replication_origin_session_setup('o')"),
    "denylisted-call",
  ),
  refused(
    "2.19",
    "create temp table staging (a int)",
    "temp-table-without-on-commit-drop",
  ),
  refused(
    "2.19",
    "create temp table staging (a int) on commit delete rows",
    "temp-table-without-on-commit-drop",
  ),
  refused(
    "2.19",
    "create temp table staging (a int) on commit preserve rows",
    "temp-table-without-on-commit-drop",
  ),
  refused(
    "2.19",
    "create table pg_temp.staging (a int)",
    "temp-table-without-on-commit-drop",
  ),
  refused(
    "2.19",
    "create temp table staging as select a from t",
    "temp-table-without-on-commit-drop",
  ),
  refused(
    "2.19",
    "create temp view staging as select a from t",
    "temp-table-without-on-commit-drop",
  ),
  refused("2.19", "create temp sequence staging_seq", "unsupported-object"),
  allowed("2.19", "create temp table staging (a int) on commit drop"),
  allowed(
    "2.19",
    "create temp table staging (a int) on commit drop",
    "post-migration",
  ),
  allowed(
    "2.19",
    "create temporary table staging on commit drop as select a from t",
    "post-migration",
  ),
  allowed("2.19", "create table pg_temp.staging (a int) on commit drop"),
  allowed(
    "2.19",
    "create temp table pg_temp.staging on commit drop as select a from t",
    "post-migration",
  ),
  refused(
    "2.20",
    "declare c cursor with hold for select a from t",
    "escapes-transaction",
  ),
  refused("2.20", "fetch next from c", "escapes-transaction"),
  refused("2.20", "close c", "escapes-transaction"),
  refused("2.21", "prepare p as select a from t", "escapes-transaction"),
  refused("2.21", "execute p", "escapes-transaction"),
  refused("2.21", "deallocate p", "escapes-transaction"),
  refused("2.22", "load 'auto_explain'", "escapes-transaction"),
  refused("2.23", "checkpoint", "escapes-transaction"),
  refused(
    "2.24",
    "create function f() returns int language plpython3u as 'return 1'",
    "unsupported-object",
  ),
  refused("2.24", "create language plperlu", "unsupported-object"),
  refused("2.24", "create extension pg_cron", "unsupported-object"),
  allowed("2.24", "create extension if not exists plpgsql"),
  refused("2.25", "create role reporting", "unsupported-object"),
  refused("2.25", "alter role reporting nologin", "unsupported-object"),
  refused(
    "2.25",
    "alter role reporting set work_mem = '1GB'",
    "unsupported-object",
  ),
  refused("2.25", "drop role reporting", "unsupported-object"),
  refused("2.25", "grant reporting to app_user", "unsupported-object"),
  refused("2.25", "reassign owned by a to b", "unsupported-object"),
  refused("2.25", "drop owned by a", "unsupported-object"),

  // §3 Same-transaction "create/alter then use" hazards
  refused("3.1", "alter type mood add value 'meh'", "unsupported-object"),
  refused(
    "3.2",
    "create type mood as enum ('happy', 'sad')",
    "unsupported-object",
  ),
  refused("3.3", "set constraints all deferred", "escapes-transaction"),
  refused("3.4", "declare c cursor for select a from t", "escapes-transaction"),
  refused("3.5", "set constraints all immediate", "escapes-transaction"),
  allowed(
    "3.6",
    "alter table t add constraint t_a_positive check (a > 0) not valid",
  ),
  allowed("3.6", "alter table t validate constraint t_a_positive"),
  refused(
    "3.7",
    "copy t (a) from '/tmp/t.csv' with (freeze)",
    "escapes-transaction",
  ),
  allowed(
    "3.8",
    "create function f(x int) returns int language sql as 'select x + 1'",
  ),
  allowed("3.8", "create function g(x int) returns int return x + 1"),
  allowed(
    "3.9",
    "update orders set total = 0 where total is null",
    "post-migration",
  ),
  allowed("3.10", "alter table t add column address address_type"),
  allowed("3.11", "create table fresh (id bigint primary key, a int)"),
  allowed("3.12", "create index t_a_idx on t (a)"),

  // §4 Transaction control inside scripts and routines
  refused("4.1", "begin", "transaction-control"),
  refused("4.1", "start transaction", "transaction-control"),
  refused("4.2", "commit", "transaction-control"),
  refused("4.2", "end", "transaction-control"),
  refused("4.2", "commit and chain", "transaction-control"),
  refused("4.3", "rollback", "transaction-control"),
  refused("4.3", "abort", "transaction-control"),
  refused("4.4", "prepare transaction 'deploy'", "transaction-control"),
  refused("4.5", "savepoint s", "transaction-control"),
  refused("4.5", "release savepoint s", "transaction-control"),
  refused("4.5", "rollback to savepoint s", "transaction-control"),
  refused("4.6", "call do_work()", "call-statement"),
  refused("4.7", "do $$ begin commit; end $$", "do-statement"),
  allowed(
    "4.8",
    "create function touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$",
  ),
  refused("4.9", "do $$ begin execute 'vacuum t'; end $$", "do-statement"),
  refused(
    "4.10",
    "do $$ begin update t set a = 1; exception when others then null; end $$",
    "do-statement",
  ),
  refused(
    "4.11",
    "set session characteristics as transaction read only",
    "transaction-control",
  ),
  refused("4.12", "\\i other.sql", "syntax-error"),

  // §5 Lock and long-transaction hazards: allowed (finalize warns, ticket 11),
  // except changing the timeouts super-deploy sets.
  allowed("5.1", "drop table old_orders"),
  allowed("5.1", "truncate old_orders", "post-migration"),
  allowed("5.1", "refresh materialized view order_totals", "post-migration"),
  allowed("5.1", "alter table t drop column legacy"),
  allowed("5.2", "create index t_b_idx on t (b)"),
  allowed(
    "5.2",
    "alter table orders add constraint orders_customer_fk foreign key (customer_id) references customers (id)",
  ),
  allowed(
    "5.2",
    "create trigger t_touch before update on t for each row execute function touch()",
  ),
  allowed("5.3", "alter table t alter column a type bigint"),
  allowed(
    "5.3",
    "alter table t add column created_at timestamptz not null default clock_timestamp()",
  ),
  allowed(
    "5.3",
    "alter table t add column id2 bigint generated always as identity",
  ),
  allowed(
    "5.3",
    "alter table t add column total numeric generated always as (a * 2) stored",
  ),
  allowed("5.4", "alter table t alter column a set not null"),
  allowed("5.4", "alter table t add constraint t_b_unique unique (b)"),
  refused("5.7", "set lock_timeout = 0", "escapes-transaction"),
  refused("5.8", "set statement_timeout = 0", "escapes-transaction"),
  refused(
    "5.9",
    "set idle_in_transaction_session_timeout = 0",
    "escapes-transaction",
  ),
  refused("5.10", "set transaction_timeout = 0", "escapes-transaction"),
  refused("5.11", "savepoint s", "transaction-control"),

  // §6 Non-determinism: data need not be deterministic (Q41), so volatile
  // built-ins are allowed; settings and environment-level objects are not.
  allowed("6.1", "update t set updated_at = now()", "post-migration"),
  allowed("6.1", "update t set updated_on = current_date", "post-migration"),
  allowed(
    "6.2",
    "update t set updated_at = clock_timestamp()",
    "post-migration",
  ),
  allowed(
    "6.3",
    "update t set token = gen_random_uuid(), weight = random()",
    "post-migration",
  ),
  allowed(
    "6.4",
    "update t set changed_by = current_user, db = current_database()",
    "post-migration",
  ),
  refused(
    "6.5",
    "alter default privileges grant select on tables to reporting",
    "unsupported-object",
  ),
  refused("6.5", "alter table t owner to reporting", "unsupported-object"),
  refused("6.5", "alter function f() owner to reporting", "unsupported-object"),
  allowed(
    "6.6",
    "delete from t where id in (select id from t limit 10)",
    "post-migration",
  ),
  allowed(
    "6.7",
    "update t set a = u.a from u where u.id = t.id",
    "post-migration",
  ),
  refused("6.8", "set search_path = public", "escapes-transaction"),
  refused("6.9", "set timezone = 'Europe/Oslo'", "escapes-transaction"),
  refused("6.9", "set datestyle = 'SQL, DMY'", "escapes-transaction"),
  refused("6.9", "set check_function_bodies = off", "escapes-transaction"),
  refused(
    "6.10",
    "create collation german (provider = icu, locale = 'de')",
    "unsupported-object",
  ),
  allowed(
    "6.12",
    "delete from t where ctid in (select ctid from t where a is null)",
    "post-migration",
  ),
  refused(
    "6.13",
    "create event trigger audit on ddl_command_start execute function audit()",
    "unsupported-object",
  ),
  refused("6.14", "create extension pgcrypto", "unsupported-object"),

  // §7 Column-order dependence
  refused(
    "7.1",
    "insert into t values (1, 'x')",
    "insert-without-columns",
    "post-migration",
  ),
  refused(
    "7.1",
    "insert into t select a, b from u",
    "insert-without-columns",
    "post-migration",
  ),
  refused(
    "7.1",
    "insert into t values (1, 'x')",
    "insert-without-columns",
    "seed-data",
  ),
  allowed("7.1", "insert into t default values", "post-migration"),
  allowed("7.1", "insert into t (a, b) values (1, 'x')", "seed-data"),
  refused(
    "7.2",
    "insert into t2 select * from t1",
    ["insert-without-columns", "select-star"],
    "post-migration",
  ),
  refused(
    "7.2",
    "insert into t2 overriding user value select * from t1",
    ["insert-without-columns", "select-star"],
    "post-migration",
  ),
  refused(
    "7.3",
    "merge into t using u on t.id = u.id when not matched then insert values (u.id, u.a)",
    "insert-without-columns",
    "post-migration",
  ),
  allowed(
    "7.3",
    "merge into t using u on t.id = u.id when matched then update set a = u.a when not matched then insert (id, a) values (u.id, u.a)",
    "post-migration",
  ),
  refused("7.4", "create view v as select * from t", "select-star"),
  refused("7.4", "create view v as select t.* from t", "select-star"),
  refused(
    "7.4",
    "create materialized view m as select * from t",
    "select-star",
  ),
  refused(
    "7.5",
    "create temp table staging on commit drop as select * from t",
    "select-star",
    "post-migration",
  ),
  refused(
    "7.5",
    "select * into staging from t",
    "deploy-time-statement",
    "post-migration",
  ),
  refused(
    "7.5",
    "create table copy_of_t as select * from t",
    "deploy-time-statement",
  ),
  refused(
    "7.6",
    "update t set a = 1 returning *",
    "select-star",
    "post-migration",
  ),
  refused(
    "7.6",
    "delete from t where a = 1 returning t.*",
    "select-star",
    "post-migration",
  ),
  refused(
    "7.6",
    "insert into t (a) values (1) returning *",
    "select-star",
    "seed-data",
  ),
  refused(
    "7.7",
    "insert into s (a) select a from t order by 1",
    "ordinal-reference",
    "post-migration",
  ),
  refused(
    "7.7",
    "insert into s (a, n) select a, count(*) from t group by 1",
    "ordinal-reference",
    "post-migration",
  ),
  refused(
    "7.7",
    "insert into s (a, n) select a, count(*) from t group by rollup (1)",
    "ordinal-reference",
    "post-migration",
  ),
  refused(
    "7.7",
    "insert into s (a) select distinct on (1) a from t",
    "ordinal-reference",
    "post-migration",
  ),
  allowed(
    "7.7",
    "insert into s (a, n) select a, count(*) from t group by a order by a",
    "post-migration",
  ),
  allowed(
    "7.7",
    "insert into s (a, r) select a, row_number() over (order by a) from t",
    "post-migration",
  ),
  refused("7.8", "copy t from stdin", "escapes-transaction", "seed-data"),
  refused(
    "7.9",
    "insert into s (j) select row_to_json(t) from t",
    "whole-row-reference",
    "post-migration",
  ),
  refused(
    "7.9",
    "update t set note = t::text",
    "whole-row-reference",
    "post-migration",
  ),
  refused(
    "7.9",
    "insert into s (j) select to_jsonb(o) from orders o",
    "whole-row-reference",
    "post-migration",
  ),
  refused(
    "7.9",
    "delete from t using u where t = u",
    "whole-row-reference",
    "post-migration",
  ),
  refused(
    "7.9",
    "insert into t (a) values (1) on conflict (a) do update set note = excluded::text",
    "whole-row-reference",
    "post-migration",
  ),
  allowed(
    "7.9",
    "insert into s (j) select jsonb_build_object('id', t.id, 'a', t.a) from t",
    "post-migration",
  ),
  refused(
    "7.10",
    "update t set (a, b) = (select * from u where u.id = t.id)",
    "select-star",
    "post-migration",
  ),
  refused(
    "7.10",
    "update t set a = 1 where row(t.*) is not null",
    "select-star",
    "post-migration",
  ),
  allowed(
    "7.10",
    "update t set (a, b) = (select u.a, u.b from u where u.id = t.id)",
    "post-migration",
  ),
  refused(
    "7.11",
    "insert into s (a) select * from t union select * from u",
    "select-star",
    "post-migration",
  ),
  refused(
    "7.12",
    "insert into s (a) select t.a from t natural join u",
    "natural-join",
    "post-migration",
  ),
  allowed(
    "7.12",
    "insert into s (a) select t.a from t join u using (id)",
    "post-migration",
  ),
  allowed(
    "7.13",
    "create function all_t() returns setof t language sql as 'select * from t'",
  ),
  allowed("7.14", "create table t2 (like t including all)"),
  refused(
    "7.14",
    "create table child (b int) inherits (parent)",
    "unsupported-object",
  ),
  refused(
    "7.14",
    "create table t_2024 partition of t for values from (2024) to (2025)",
    "unsupported-object",
  ),
  refused("7.14", "create table typed of address_type", "unsupported-object"),

  // §8 New or changed in PostgreSQL 18
  refused(
    "8.1",
    "alter table t add column total int generated always as (a + 1) virtual",
    "unsupported-object",
  ),
  refused(
    "8.1",
    "alter table t add column total int generated always as (a + 1)",
    "unsupported-object",
  ),
  allowed(
    "8.2",
    "alter table t add constraint t_a_not_null not null a not valid",
  ),
  refused(
    "8.3",
    "alter table t add column b int check (b > 0) not enforced",
    "unsupported-object",
  ),
  refused(
    "8.3",
    "alter table t add constraint t_a_positive check (a > 0) not enforced",
    "unsupported-object",
  ),
  refused(
    "8.3",
    "alter table orders add constraint orders_fk foreign key (customer_id) references customers (id) not enforced",
    "unsupported-object",
  ),
  allowed(
    "8.4",
    "alter table bookings add constraint bookings_no_overlap primary key (room, during without overlaps)",
  ),
  refused(
    "8.6",
    "update t set a = 1 returning old.*, new.*",
    "select-star",
    "post-migration",
  ),
  refused(
    "8.6",
    "update t set a = 1 returning old",
    "whole-row-reference",
    "post-migration",
  ),
  allowed("8.6", "update t set a = 1 returning old.a, new.a", "post-migration"),
  allowed("8.7", "insert into t (id, a) values (uuidv7(), 1)", "seed-data"),
  refused("8.8", "set role admin", "escapes-transaction"),
  refused("8.9", "create unlogged table cache (a int)", "unsupported-object"),
  refused("8.9", "alter table t set unlogged", "unsupported-object"),
  refused(
    "8.9",
    "create table p (a int) partition by range (a)",
    "unsupported-object",
  ),
  refused("8.12", "vacuum (analyze) t", "not-in-transaction"),
  allowed("8.12", "analyze verbose t"),
  refused(
    "8.13",
    "copy t (a) from stdin with (on_error ignore)",
    "escapes-transaction",
  ),
  refused(
    "8.14",
    "alter subscription s set (two_phase = true)",
    "not-in-transaction",
  ),
  allowed("8.15", "alter table t drop constraint t_a_positive"),
  refused("8.17", "create role app_user password 'x'", "unsupported-object"),
  refused(
    "8.19",
    "alter default privileges grant select on large objects to reporting",
    "unsupported-object",
  ),

  // §9 Rest of the suggested denylist and banned statements
  refused("9", call("pg_sleep(1)"), "denylisted-call"),
  refused("9", call("pg_read_file('/etc/passwd')"), "denylisted-call"),
  refused("9", call("pg_read_binary_file('/etc/passwd')"), "denylisted-call"),
  refused(
    "9",
    "update t set note = (select count(*) from pg_ls_dir('.'))::text",
    "denylisted-call",
  ),
  refused("9", call("pg_export_snapshot()"), "denylisted-call"),
  refused("9", "explain analyze delete from t", "deploy-time-statement"),
  refused("9", "show work_mem", "deploy-time-statement"),
  refused(
    "9",
    "create rule r as on insert to t do nothing",
    "unsupported-object",
  ),
  refused("9", "create statistics t_ab on a, b from t", "unsupported-object"),
  refused("9", "create sequence s", "unsupported-object"),
];

describe("hazard catalogue", () => {
  test.each(
    hazardFixtures.map((fixture) => [
      `${fixture.hazard} ${fixture.expected === "allowed" ? "allow" : "refuse"} ${JSON.stringify(fixture.sql)}${fixture.kind ? ` in ${fixture.kind}` : ""}`,
      fixture,
    ]),
  )("%s", async (_, fixture) => {
    const kind = fixture.kind ?? "pre-migration";
    const expected =
      fixture.expected === "allowed"
        ? []
        : typeof fixture.expected === "string"
          ? [fixture.expected]
          : [...fixture.expected];

    expect(await rulesBroken(kind, fixture.sql)).toEqual(expected);
  });
});

describe("what each kind of file may contain", () => {
  const ddl = "alter table t add column note text";
  const dml = "update t set note = 'x'";
  const comment = "comment on table t is 'Things'";
  const staging = "create temp table staging (a int) on commit drop";
  const maintenance = "analyze t";

  test.each([
    ["schema-change", ddl, true],
    ["schema-change", comment, true],
    ["schema-change", dml, false],
    ["schema-change", staging, false],
    ["schema-change", maintenance, false],
    ["pre-migration", ddl, true],
    ["pre-migration", dml, true],
    ["pre-migration", staging, true],
    ["pre-migration", maintenance, true],
    ["pre-migration", comment, false],
    ["post-migration", dml, true],
    ["post-migration", staging, true],
    ["post-migration", maintenance, true],
    ["post-migration", ddl, false],
    ["post-migration", "create index t_note_idx on t (note)", false],
    ["post-migration", "drop table t", false],
    ["post-migration", comment, false],
    ["seed-data", "insert into t (a) values (1)", true],
    ["seed-data", dml, false],
    ["seed-data", "delete from t", false],
    ["seed-data", staging, false],
    ["seed-data", ddl, false],
  ] as const)("%s: %j allowed: %s", async (kind, sql, isAllowed) => {
    expect(await rulesBroken(kind, sql)).toEqual(
      isAllowed ? [] : ["deploy-time-statement"],
    );
  });

  test("explain why a statement is in the wrong kind of file", async () => {
    const messages = async (kind: DeployTimeKind, sql: string) =>
      (await check(kind, sql)).map((v) => v.message);

    expect(await messages("post-migration", ddl)).toEqual([
      "ALTER TABLE is not allowed in a post-migration script: post-migration scripts may only change data; structure belongs in the desired schema or the pre-migration script",
    ]);
    expect(await messages("pre-migration", comment)).toEqual([
      "COMMENT is not allowed in a pre-migration script: comments belong in the desired schema",
    ]);
    expect(await messages("seed-data", dml)).toEqual([
      "UPDATE is not allowed in seed data: seed data may contain only INSERT statements with a column list",
    ]);
    expect(await messages("schema-change", dml)).toEqual([
      "UPDATE is not allowed in a schema change: a generated schema change contains only DDL and comments",
    ]);
  });

  test.each([
    ["insert into t (a) values (1)"],
    [
      "insert into t (a) select a from u where u.b > 0 on conflict (a) do nothing",
    ],
    ["update t set a = a + 1 where b is null"],
    ["delete from t where a < 0"],
    ["truncate t"],
    ["merge into t using u on t.id = u.id when matched then delete"],
    [
      "with moved as (delete from u returning u.id, u.a) insert into t (id, a) select moved.id, moved.a from moved",
    ],
  ])("post-migration scripts allow the DML %j", async (sql) => {
    expect(await check("post-migration", sql)).toEqual([]);
  });

  test("refuse a standalone SELECT and a permanent CREATE TABLE AS", async () => {
    expect(
      await check("post-migration", "select count(*) from t"),
    ).toMatchObject([
      {
        rule: "deploy-time-statement",
        message:
          "A standalone SELECT is not allowed: its result goes nowhere in a deployment",
      },
    ]);
    expect(
      await rulesBroken("pre-migration", "create table t2 as select a from t"),
    ).toEqual(["deploy-time-statement"]);
  });
});

describe("function calls", () => {
  test.each([
    "update t set a = abs(a), b = lower(b), c = coalesce(c, 0)",
    "update t set a = pg_catalog.abs(a)",
    "update t set d = extract(year from created_at), e = substring(b from 2 for 3), f = trim(b)",
    "update t set g = date_trunc('day', created_at at time zone 'UTC')",
    "insert into t (id) select gen_random_uuid() from generate_series(1, 10)",
    "update t set h = (select count(*) from u where u.t_id = t.id)",
  ])("allow built-ins: %j", async (sql) => {
    expect(await check("post-migration", sql)).toEqual([]);
  });

  test.each([
    ["update t set a = normalise_name(a)", "normalise_name()"],
    ["update t set a = public.normalise_name(a)", "public.normalise_name()"],
    ["insert into t (a) select next_code() from u", "next_code()"],
    [
      "update t set a = pg_catalog.not_a_builtin(a)",
      "pg_catalog.not_a_builtin()",
    ],
  ])("refuse calling a user-defined function: %j", async (sql, name) => {
    expect(await check("post-migration", sql)).toMatchObject([
      {
        rule: "user-function-call",
        message: `${name} is not a built-in pg_catalog function; deploy-time SQL may not call user-defined functions`,
      },
    ]);
  });

  test("allow user-defined functions in stored definitions, which the desired schema owns", async () => {
    for (const sql of [
      "alter table t add column code text default next_code()",
      "alter table t add constraint t_code_valid check (valid_code(code))",
      "create index t_code_idx on t (normalise(code))",
      "create view v as select normalise(code) as code from t",
      "create trigger t_touch before update on t for each row execute function public.touch()",
    ]) {
      expect({ sql, violations: await check("pre-migration", sql) }).toEqual({
        sql,
        violations: [],
      });
    }
  });

  test("refuse a user-defined function in ALTER COLUMN ... USING, which runs for every row", async () => {
    expect(
      await rulesBroken(
        "pre-migration",
        "alter table t alter column code type int using parse_code(code)",
      ),
    ).toEqual(["user-function-call"]);
  });

  test("refuse denylisted built-ins anywhere, also in stored definitions and with any schema", async () => {
    for (const [kind, sql] of [
      [
        "pre-migration",
        "alter table t add column n bigint default setval('s', 1)",
      ],
      ["schema-change", "create view v as select pg_sleep(1) as x"],
      ["post-migration", "update t set a = pg_catalog.setval('s', 1)"],
      [
        "post-migration",
        "update t set a = (select pg_advisory_unlock_all())::int",
      ],
    ] as const) {
      expect({ sql, rules: await rulesBroken(kind, sql) }).toEqual({
        sql,
        rules: ["denylisted-call"],
      });
    }
  });

  test("explain why a denylisted function is refused", async () => {
    expect(
      await check("post-migration", call("pg_advisory_lock(42)")),
    ).toMatchObject([
      {
        rule: "denylisted-call",
        message:
          "pg_advisory_lock() is not allowed: it takes or releases a session-level advisory lock, which a failed deployment's rollback cannot undo",
        hint: 'If the statement is safe, override the refusal with "-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>" on the line before it',
      },
    ]);
  });
});

describe("references", () => {
  test.each([
    "insert into t (a) select relname from pg_catalog.pg_class",
    "insert into t (a) select relname from pg_class",
    "update public.t set a = 1",
    "insert into t (a) select typname from pg_type where oid = 'int4'::regtype",
    "update t set a = a::pg_catalog.int8",
  ])("allow the managed schema and reading pg_catalog: %j", async (sql) => {
    expect(await check("post-migration", sql)).toEqual([]);
  });

  test.each([
    ["update other.t set a = 1", "other.t"],
    ["insert into t (a) select a from other.u", "other.u"],
    [
      "insert into t (a) select table_name from information_schema.tables",
      "information_schema.tables",
    ],
    ["update t set a = other.f(a)", "other.f()"],
    ["update t set a = a::other.money_amount", "other.money_amount"],
    ["update db.public.t set a = 1", "db.public.t"],
  ])("refuse schemas other than the managed one: %j", async (sql, name) => {
    expect(await check("post-migration", sql)).toMatchObject([
      {
        rule: "outside-managed-schema",
        message: `${name} is outside the managed schema public; deploy-time SQL may reference only the managed schema, the migration's own temporary tables and pg_catalog (read-only)`,
      },
    ]);
  });

  test.each([
    ["post-migration", "update pg_catalog.pg_class set relname = 'x'"],
    ["post-migration", "delete from pg_class"],
    [
      "post-migration",
      "insert into pg_catalog.pg_description (objoid) values (1)",
    ],
    ["pre-migration", "drop function pg_catalog.lower(text)"],
    ["pre-migration", "alter table pg_catalog.pg_class add column x int"],
    ["schema-change", "comment on table pg_catalog.pg_class is 'x'"],
  ] as const)("refuse changing pg_catalog in %s: %j", async (kind, sql) => {
    expect(await rulesBroken(kind, sql)).toEqual(["catalog-write"]);
  });

  test("honour a managed schema other than public", async () => {
    const app = async (kind: DeployTimeKind, sql: string) => [
      ...new Set((await check(kind, sql, "app")).map((v) => v.rule)),
    ];

    expect(
      await app(
        "schema-change",
        'CREATE TABLE "app"."t" ("id" bigint NOT NULL)',
      ),
    ).toEqual([]);
    expect(
      await app(
        "schema-change",
        'CREATE TABLE "public"."t" ("id" bigint NOT NULL)',
      ),
    ).toEqual(["outside-managed-schema"]);
    expect(
      await app("schema-change", 'DROP TRIGGER "trg" ON "public"."t"'),
    ).toEqual(["outside-managed-schema"]);
    expect(
      await app("schema-change", 'COMMENT ON COLUMN "app"."t"."id" IS \'x\''),
    ).toEqual([]);
    expect(
      await app("schema-change", "comment on schema public is 'x'"),
    ).toEqual(["outside-managed-schema"]);
    expect(
      await app("post-migration", "update app.t set a = app.f(a)"),
    ).toEqual(["user-function-call"]);
  });

  test("allow pg_temp only for temporary tables created earlier in the migration, in any of its scripts", async () => {
    const insert = "insert into pg_temp.staging (a) values (1)";

    expect(await rulesBroken("post-migration", insert)).toEqual([
      "outside-managed-schema",
    ]);
    const analysis = await analyseMigration([
      {
        path: paths["pre-migration"],
        kind: "pre-migration",
        text: "create temp table staging (a int) on commit drop;",
      },
      { path: paths["schema-change"], kind: "schema-change", text: "" },
      {
        path: paths["post-migration"],
        kind: "post-migration",
        text: `${insert};`,
      },
    ]);
    expect(analysis.violations).toEqual([]);
  });
});

describe("identity columns", () => {
  const identityColumns = new Map([["orders", new Set(["id"])]]);
  const checkOrders = async (
    sql: string,
    kind: DeployTimeKind = "post-migration",
  ) => checkRules({ path: paths[kind], text: sql }, kind, { identityColumns });

  test.each([
    "insert into orders (id, total) values (42, 1)",
    "insert into public.orders (id, total) select o.id, o.total from old_orders o",
    "update orders set id = id + 1000",
    "merge into orders o using old_orders s on o.id = s.id when not matched then insert (id, total) values (s.id, s.total)",
    "merge into orders o using old_orders s on o.total = s.total when matched then update set id = s.id",
  ])("refuse explicit values into a known identity column: %j", async (sql) => {
    expect(await checkOrders(sql)).toMatchObject([
      {
        rule: "identity-value",
        message:
          "orders.id is an identity column; explicit values let its sequence fall behind and later inserts collide, so leave it out",
      },
    ]);
  });

  test("refuse OVERRIDING SYSTEM VALUE whatever the table", async () => {
    expect(
      await rulesBroken(
        "seed-data",
        "insert into anything (id) overriding system value values (1)",
      ),
    ).toEqual(["identity-value"]);
  });

  test.each([
    "insert into orders (total) values (1)",
    "insert into orders (id, total) overriding user value values (1, 1)",
    "update orders set id = default",
    "update orders set total = 0 where id = 42",
    "insert into other_table (id) values (1)",
  ])("allow %j", async (sql) => {
    expect(await checkOrders(sql)).toEqual([]);
  });

  test("find identity columns created earlier in the migration", async () => {
    const analysis = await analyseMigration([
      {
        path: paths["pre-migration"],
        kind: "pre-migration",
        text: "alter table invoices add column number bigint generated always as identity;\ncreate table notes (id bigint generated by default as identity, body text);\n",
      },
      {
        path: paths["post-migration"],
        kind: "post-migration",
        text: "insert into invoices (number) values (1);\ninsert into notes (id, body) values (1, 'x');\n",
      },
    ]);

    expect(analysis.violations.map((v) => [v.line, v.rule])).toEqual([
      [1, "identity-value"],
      [2, "identity-value"],
    ]);
  });

  test("identityColumnsOf reads them from a desired schema", async () => {
    const parsed = await parseSqlFile({
      path: "data-model/desired-schema/orders.sql",
      text: "create table orders (id bigint generated always as identity primary key, total numeric);\ncreate table lines (n int);\nalter table lines add column id bigint generated by default as identity;\n",
    });
    if (!parsed.ok) throw new Error("parse failed");

    expect(identityColumnsOf(parsed.statements)).toEqual(
      new Map([
        ["orders", new Set(["id"])],
        ["lines", new Set(["id"])],
      ]),
    );
  });
});

describe("rule catalogue", () => {
  test("only risk rules are overridable, and transaction-breaking rules never", () => {
    expect(
      ruleCatalogue.filter((rule) => rule.overridable).map((rule) => rule.id),
    ).toEqual(["denylisted-call", "plpgsql-dynamic-sql"]);
    for (const id of [
      "not-in-transaction",
      "transaction-control",
      "call-statement",
      "do-statement",
      "escapes-transaction",
    ]) {
      expect(ruleDefinition(id)).toMatchObject({
        category: "transaction",
        overridable: false,
      });
    }
  });
});
