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
} from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { deployProject, finalizeMigration } from "../support/deploy.ts";
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

async function attempts(database: string) {
  return server.query<{ id: string; outcome: string; error: string | null }>(
    "select id, outcome, error from deployment_history.attempts order by id",
    [],
    database,
  );
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
    const [lost] = await attempts(database);
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
    expect(await attempts(database)).toEqual([
      expect.objectContaining({ outcome: "unknown" }),
    ]);

    const result = await deploy(project, { target: "dev" });

    expect(result.deployed.map((m) => m.number)).toEqual([1]);
    expect(await attempts(database)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        error: expect.stringContaining(
          "settled as failed: none of its migrations are recorded",
        ),
      }),
      {
        id: String(result.attemptId),
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
    expect(await attempts(database)).toHaveLength(2);
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
    expect(await attempts(database)).toEqual([
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
