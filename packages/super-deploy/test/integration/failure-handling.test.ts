// API seam: what a deployment leaves behind when something goes wrong. Faults
// are injected by wrapping the real embedded-postgres target adapter's
// sessions (see the adapter expressions below), never by mocking internals.
import {
  CommitOutcomeUnknownError,
  deploy,
  InterruptedError,
  loadProject,
  type Session,
  status,
  TargetLockedError,
  TargetSessionEndedError,
  TargetTimeoutError,
} from "superdeploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  attemptLog,
  columnPending,
  deployProject,
  finalizeMigration,
  testSession,
  whileLocked,
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
  name text not null
);
`;

/**
 * A `dev` adapter that loses the deploy transaction's connection at COMMIT
 * when `globalThis.loseCommit` is set: `"after"` sends the COMMIT first (it
 * lands, its reply is lost), `"before"` drops the connection instead (the
 * server rolls back), `"linger"` sends nothing and leaves the server's side
 * open, as a server that hasn't noticed yet would (the real session goes to
 * `globalThis.lingering`). Each way the caller sees an error without a
 * SQLSTATE, as node-postgres reports a dropped connection, and the session is
 * dead.
 */
const losingAdapter = `{
  async connect() {
    const session = await real.connect();
    let deploying = false;
    let lost = false;
    const dead = () => { throw new Error("Client has encountered a connection error and is not queryable"); };
    return {
      ...session,
      async query(sql, values) {
        if (lost) dead();
        return session.query(sql, values);
      },
      async execute(sql) {
        if (lost) dead();
        // The drift check reads the catalogs under the same timeouts, READ ONLY.
        deploying ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        const lose = globalThis.loseCommit;
        if (deploying && sql === "COMMIT" && lose !== undefined) {
          globalThis.loseCommit = undefined;
          if (lose === "after") await session.execute(sql);
          lost = true;
          if (lose === "linger") globalThis.lingering = session;
          else await session.close();
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

function loseCommit(when: "before" | "after" | "linger"): void {
  Object.assign(globalThis, { loseCommit: when });
}

describe("a connection lost during COMMIT", () => {
  test("records the attempt as unknown, and the next status settles it as succeeded when its migrations are recorded", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: losingAdapter },
    );
    await finalizeMigration(project, "add customers");
    loseCommit("after");

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect((error as Error).message).toContain(
      "Connection terminated unexpectedly",
    );
    const [lost] = await attemptLog(server, database);
    expect(lost).toMatchObject({ outcome: "unknown" });

    const report = await status(project, { target: "dev" });

    expect(report.recorded.map((m) => m.number)).toEqual([1]);
    expect(report.pending).toEqual([]);
    expect(report.attempts).toEqual([
      expect.objectContaining({
        id: Number(lost?.id),
        outcome: "succeeded",
        endedAt: expect.any(Date),
        error: expect.stringContaining("settled as succeeded"),
      }),
    ]);
  });

  test("the next deployment settles it as failed when nothing was recorded, then deploys", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: losingAdapter },
    );
    await finalizeMigration(project, "add customers");
    loseCommit("before");
    await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
    expect(await attemptLog(server, database)).toEqual([
      expect.objectContaining({ outcome: "unknown" }),
    ]);

    const result = await deploy(project, { target: "dev" });

    expect(result.deployed.map((m) => m.number)).toEqual([1]);
    expect(await attemptLog(server, database)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining(
          "settled as failed: none of its migrations are recorded",
        ),
      }),
      {
        id: result.attemptId,
        command: "deploy",
        outcome: "succeeded",
        error: null,
      },
    ]);
  });

  test("stays unknown while the server process of the lost connection is still there, which still holds the target lock", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: losingAdapter },
    );
    await finalizeMigration(project, "add customers");
    loseCommit("linger");
    await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
      CommitOutcomeUnknownError,
    );
    const lingering = (globalThis as { lingering?: Session }).lingering;

    try {
      const report = await status(project, { target: "dev" });
      expect(report.attempts).toEqual([
        expect.objectContaining({ outcome: "unknown" }),
      ]);
      await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
        TargetLockedError,
      );
    } finally {
      await lingering?.close();
    }

    const report = await status(project, { target: "dev" });
    expect(report.attempts.map((a) => a.outcome)).toEqual(["failed", "failed"]);
    expect(report.pending.map((m) => m.number)).toEqual([1]);
    expect(await attemptLog(server, database)).toHaveLength(2);
  });
});

/**
 * A `dev` adapter whose deploy transaction stalls in `pg_sleep(60)` on the
 * target, just before its first migration file, while
 * `globalThis.stallDeploy` is set (it is called first).
 */
const stallingAdapter = `{
  async connect() {
    const session = await real.connect();
    let deploying = false;
    return {
      ...session,
      async execute(sql) {
        const stall = globalThis.stallDeploy;
        if (deploying && stall !== undefined) {
          globalThis.stallDeploy = undefined;
          stall();
          await session.query("select pg_sleep(60)");
        }
        // The drift check reads the catalogs under the same timeouts, READ ONLY.
        deploying ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        return session.execute(sql);
      },
    };
  },
}`;

/** Resolves when a deployment through `stallingAdapter` has stalled in its transaction. */
function stallDeploy(): Promise<void> {
  return new Promise((resolve) => {
    Object.assign(globalThis, { stallDeploy: resolve });
  });
}

async function advisoryLocks(database: string): Promise<number> {
  const [row] = await server.query<{ count: number }>(
    `select count(*)::int as count from pg_locks
      where locktype = 'advisory' and granted
        and database = (select oid from pg_database where datname = $1)`,
    [database],
  );
  return row?.count ?? -1;
}

describe("settling", () => {
  test("leaves a deployment that is still running alone", async () => {
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        // Pauses the deployment's rehearsal while globalThis.pauseRehearsal is set.
        rehearsal: `{
  async createDatabase(request) {
    const pause = globalThis.pauseRehearsal;
    if (pause !== undefined && request.collationProvider === "libc") {
      globalThis.pauseRehearsal = undefined;
      await pause();
    }
    return postgres.rehearsal.createDatabase(request);
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");
    let release = () => {};
    const paused = new Promise<void>((reached) => {
      Object.assign(globalThis, {
        pauseRehearsal: () => {
          reached();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      });
    });
    const deployment = deploy(project, { target: "dev" });
    try {
      await paused;

      const report = await status(project, { target: "dev" });

      expect(report.attempts).toEqual([
        expect.objectContaining({ outcome: "running" }),
      ]);
    } finally {
      release();
    }
    const result = await deployment;
    expect((await status(project, { target: "dev" })).attempts).toEqual([
      expect.objectContaining({
        id: result.attemptId,
        outcome: "succeeded",
        error: undefined,
      }),
    ]);
  });
});

describe("an interrupted deployment", () => {
  test("rolls back at once, records the attempt as abandoned, releases the lock and rejects with InterruptedError", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: stallingAdapter },
    );
    await finalizeMigration(project, "add customers");
    const controller = new AbortController();
    const interruptible = await loadProject({
      cwd: dir.root,
      signal: controller.signal,
    });
    try {
      const stalled = stallDeploy();
      const deployment = deploy(interruptible, { target: "dev" }).catch(
        (e: unknown) => e,
      );
      await stalled;
      expect(await advisoryLocks(database)).toBe(1);
      const started = Date.now();

      controller.abort();
      const error = await deployment;

      expect(error).toBeInstanceOf(InterruptedError);
      // Well before the stalled statement's 60 s.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(await advisoryLocks(database)).toBe(0);
      expect(
        await server.query(
          `select to_regclass('customers') as customers,
                  (select count(*)::int from deployment_history.migrations) as recorded`,
          [],
          database,
        ),
      ).toEqual([{ customers: null, recorded: 0 }]);
      expect(
        await server.query(
          "select outcome, ended_at is not null as ended from deployment_history.attempts",
          [],
          database,
        ),
      ).toEqual([{ outcome: "abandoned", ended: true }]);
    } finally {
      await interruptible.close();
    }
  });
});

describe("an attempt its command could not end", () => {
  test("a deployment whose attempt-log connection fails after COMMIT still succeeds, and the next status settles the attempt as succeeded", async () => {
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        // Fault injection: the attempt log refuses to end the attempt.
        adapter: `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async query(sql, values) {
        if (globalThis.failAttemptEnd && sql.includes("SET outcome = $2")) {
          globalThis.failAttemptEnd = false;
          throw new Error("Connection terminated unexpectedly");
        }
        return session.query(sql, values);
      },
    };
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");
    Object.assign(globalThis, { failAttemptEnd: true });

    const result = await deploy(project, { target: "dev" });

    expect(result.deployed.map((m) => m.number)).toEqual([1]);
    expect(await attemptLog(server, database)).toEqual([
      expect.objectContaining({ outcome: "running" }),
    ]);
    const report = await status(project, { target: "dev" });
    expect(report.attempts).toEqual([
      expect.objectContaining({
        id: result.attemptId,
        outcome: "succeeded",
        endedAt: expect.any(Date),
        error:
          "The command ended without recording an outcome; settled as succeeded: its migrations are recorded",
      }),
    ]);
  });
});

describe("a deployment failing with an error that has no message of its own", () => {
  test("records its inner errors' reasons, deduplicated, falling back to an error's code", async () => {
    // As Node reports a refused connect to localhost (::1 and 127.0.0.1): an
    // AggregateError with an empty message. One inner error has no message.
    const aggregateAdapter = `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async execute(sql) {
        if (sql.includes("lock_timeout") && !sql.includes("READ ONLY")) {
          const refused = (address) => Object.assign(new Error("connect ECONNREFUSED " + address), { code: "ECONNREFUSED" });
          throw Object.assign(
            new AggregateError([refused("::1:5432"), refused("::1:5432"), Object.assign(new Error(""), { code: "ECONNRESET" })], ""),
            { code: "ECONNREFUSED" },
          );
        }
        return session.execute(sql);
      },
    };
  },
}`;
    const { project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: aggregateAdapter },
    );
    await finalizeMigration(project, "add customers");

    // An error without a SQLSTATE is a lost connection.
    await expect(deploy(project, { target: "dev" })).rejects.toBeInstanceOf(
      TargetSessionEndedError,
    );

    expect(await attemptLog(server, database)).toEqual([
      {
        id: expect.any(Number),
        command: "deploy",
        outcome: "failed",
        error: expect.stringContaining(
          "(connect ECONNREFUSED ::1:5432; ECONNRESET)",
        ),
      },
    ]);
  });
});

/**
 * A `dev` adapter that, on closing each session, reads the settings a server
 * ends a silent client's session by into `globalThis.targetSettings`.
 */
const settingsAdapter = `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async close() {
        const { rows } = await session.query(
          \`select current_setting('idle_in_transaction_session_timeout') as idle,
                  current_setting('tcp_keepalives_idle') as "keepalivesIdle",
                  current_setting('tcp_keepalives_interval') as "keepalivesInterval",
                  current_setting('tcp_keepalives_count') as "keepalivesCount"\`,
        );
        (globalThis.targetSettings ??= []).push(rows[0]);
        await session.close();
      },
    };
  },
}`;

/**
 * A `dev` adapter whose sessions end a transaction left idle after 1 s rather
 * than a minute, and whose deploy transaction hangs before its second
 * statement while `globalThis.hangDeploy` is set (it is called with a release
 * function), as a client that stopped responding would.
 */
const hangingAdapter = `{
  async connect() {
    const session = await real.connect();
    let deploying = false;
    let statements = 0;
    return {
      ...session,
      async query(sql, values) {
        const result = await session.query(sql, values);
        if (sql.includes("idle_in_transaction_session_timeout")) {
          await session.query("SET idle_in_transaction_session_timeout TO '1s'");
        }
        return result;
      },
      async execute(sql) {
        deploying ||= sql.includes("lock_timeout") && !sql.includes("READ ONLY");
        if (deploying && ++statements === 3 && globalThis.hangDeploy !== undefined) {
          const hang = globalThis.hangDeploy;
          globalThis.hangDeploy = undefined;
          await new Promise((release) => hang(release));
        }
        return session.execute(sql);
      },
    };
  },
}`;

describe("a target session whose client stops responding", () => {
  test("sets the timeouts that end it: idle in a transaction for a minute, TCP keepalives after about a minute", async () => {
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: settingsAdapter },
    );
    await finalizeMigration(project, "add customers");
    Object.assign(globalThis, { targetSettings: [] });

    await deploy(project, { target: "dev" });

    const seen = (globalThis as { targetSettings?: unknown[] }).targetSettings;
    expect(seen).toHaveLength(2);
    for (const settings of seen ?? []) {
      expect(settings).toEqual({
        idle: "1min",
        keepalivesIdle: "30",
        keepalivesInterval: "10",
        keepalivesCount: "3",
      });
    }
  });

  test("is ended by the server once its deploy transaction sits idle, releasing its locks", async () => {
    const { dir, project, database } = await deployProject(
      server,
      { "customers.sql": customers },
      { adapter: hangingAdapter },
    );
    await finalizeMigration(project, "add customers");
    await deploy(project, { target: "dev" });
    await dir.write(
      "data-model/desired-schema/customers.sql",
      `${customers}\ncreate index customers_name on customers (name);\n`,
    );
    await finalizeMigration(project, "index names");
    let release = () => {};
    const hung = new Promise<void>((resolve) => {
      Object.assign(globalThis, {
        hangDeploy: (resume: () => void) => {
          release = resume;
          resolve();
        },
      });
    });
    const deployment = deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );
    const holder = await testSession(server, database);
    try {
      await hung;

      // The deploy's session holds customers' lock until the server ends it.
      await holder.execute("SET lock_timeout TO '10s'");
      await holder.execute("BEGIN");
      await holder.execute("LOCK TABLE customers IN ACCESS EXCLUSIVE MODE");
      await holder.execute("ROLLBACK");
      expect(await advisoryLocks(database)).toBe(0);
    } finally {
      release();
      await holder.close();
    }
    const error = await deployment;
    expect(error).toBeInstanceOf(TargetSessionEndedError);
    expect(error).toMatchObject({ ending: "idle" });
    expect((error as TargetSessionEndedError).message).toContain(
      "its transaction sat idle for over a minute, so super-deploy had stopped responding",
    );
    expect((error as TargetSessionEndedError).message).not.toContain(
      "ended on purpose",
    );
    expect((await status(project, { target: "dev" })).pending).toEqual([
      expect.objectContaining({ number: 2 }),
    ]);
  });
});

/**
 * Migration 1 (customers) deployed to `dev`, and migration 2 (a column on
 * customers, which takes ACCESS EXCLUSIVE) finalized and pending.
 */

/**
 * Deploys migration 2 of `columnPending` while customers is held in `mode`,
 * and ends the deployment's session that waits for it from the server.
 */
async function terminatedWhileLocked(
  mode: "ACCESS SHARE" | "ACCESS EXCLUSIVE",
) {
  const { project, database } = await columnPending(server, {
    target: 'lockTimeout: "30s",',
  });
  const error = await whileLocked(server, database, "customers", mode, () => {
    const deployment = deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );
    return server
      .untilLockWaiter(database)
      .then(([pid]) => server.query("select pg_terminate_backend($1)", [pid]))
      .then(() => deployment);
  });
  return { database, error };
}

describe("a target session that ends before the command finishes", () => {
  test("lost while the attempt opens, before anything changed: reported as the target's, nothing changed", async () => {
    const { project } = await deployProject(
      server,
      { "customers.sql": customers },
      {
        // Fault injection: the connection drops as the attempt is recorded.
        adapter: `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async query(sql, values) {
        if (globalThis.loseAttemptOpen === true && sql.startsWith("INSERT INTO") && sql.includes("attempts")) {
          throw new Error("Connection terminated unexpectedly");
        }
        return session.query(sql, values);
      },
    };
  },
}`,
      },
    );
    await finalizeMigration(project, "add customers");
    Object.assign(globalThis, { loseAttemptOpen: true });
    try {
      const error = await deploy(project, { target: "dev" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(TargetSessionEndedError);
      expect(error).toMatchObject({ ending: "lost", rollback: undefined });
      expect((error as TargetSessionEndedError).message).toContain(
        "Nothing changed on target dev.",
      );
    } finally {
      Object.assign(globalThis, { loseAttemptOpen: undefined });
    }
  });

  test("ended by the server inside the deploy transaction: the deployment rolled back, and the target is still at its last migration", async () => {
    const { database, error } = await terminatedWhileLocked("ACCESS SHARE");

    expect(error).toBeInstanceOf(TargetSessionEndedError);
    const { message } = error as TargetSessionEndedError;
    expect(message).toContain(
      "The server ended the session on target dev (terminating connection due to administrator command)",
    );
    expect(message).toContain(
      "The deployment rolled back: target dev is unchanged, still at migration 00001-add-customers.",
    );
    expect(message).toContain("Next: retry once target dev is reachable");
    expect(message).not.toContain("PostgreSQL refused it");
    expect((await attemptLog(server, database)).at(-1)).toMatchObject({
      outcome: "failed",
      error: message,
    });
  });

  test("ended by the server during the drift check: nothing changed", async () => {
    const { database, error } = await terminatedWhileLocked("ACCESS EXCLUSIVE");

    expect(error).toBeInstanceOf(TargetSessionEndedError);
    const { message } = error as TargetSessionEndedError;
    expect(message).toContain("The server ended the session on target dev");
    expect(message).toContain("Nothing changed on target dev.");
    expect(message).not.toContain("rolled back");
    expect((await attemptLog(server, database)).at(-1)).toMatchObject({
      outcome: "failed",
      error: message,
    });
  });

  test("a lock timeout during the drift check names the target's lockTimeout: nothing changed", async () => {
    const { project, database } = await columnPending(server, {
      target: 'lockTimeout: "200ms",',
    });

    const error = await whileLocked(
      server,
      database,
      "customers",
      "ACCESS EXCLUSIVE",
      () => deploy(project, { target: "dev" }).catch((e: unknown) => e),
    );

    expect(error).toBeInstanceOf(TargetTimeoutError);
    const { message } = error as TargetTimeoutError;
    expect(message).toContain(
      "Target dev's lockTimeout (200ms) ran out waiting for a lock",
    );
    expect(message).toContain("Nothing changed on target dev.");
  });

  test("a connection lost at the end of a migration isn't blamed on deferred constraints", async () => {
    const { project, database } = await columnPending(server, {
      // Fault injection: the connection is lost when the migration ends.
      adapter: `{
  async connect() {
    const session = await real.connect();
    return {
      ...session,
      async execute(sql) {
        if (globalThis.loseAtBoundary && sql === "SET CONSTRAINTS ALL IMMEDIATE") {
          globalThis.loseAtBoundary = false;
          throw new Error("Client has encountered a connection error and is not queryable");
        }
        return session.execute(sql);
      },
    };
  },
}`,
    });
    Object.assign(globalThis, { loseAtBoundary: true });

    const error = await deploy(project, { target: "dev" }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TargetSessionEndedError);
    const { message } = error as TargetSessionEndedError;
    expect(message).toContain(
      "The connection to target dev was lost (Client has encountered a connection error and is not queryable)",
    );
    expect(message).toContain(
      "The deployment rolled back: target dev is unchanged, still at migration 00001-add-customers.",
    );
    expect(message).not.toContain("deferred constraints");
    expect((await status(project, { target: "dev" })).pending).toEqual([
      expect.objectContaining({ number: 2 }),
    ]);
    expect((await attemptLog(server, database)).at(-1)).toMatchObject({
      outcome: "failed",
    });
  });
});
