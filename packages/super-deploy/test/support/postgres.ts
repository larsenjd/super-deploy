// A real PostgreSQL 18 server for one test file, started through the
// library's own embedded-postgres adapter on a free port and a unique temp
// data directory. Test projects point their config at `dataDir`; their
// adapter finds the running server and attaches to it instead of starting
// another one, so every project in the file shares this server. The harness
// is one of the server's clients, so closing a project leaves it running.
// `stop()` stops it even while projects a test never closed are still
// registered as clients.
//
// Also helpers for a project's own server (`serverRunning`, `stopServerOn`,
// `promoteStandby`, `onStoppedServer`), which run `pg_ctl` outside the
// adapter's lease, and for
// ports (`freePort`, `holdPort`).
//
// Test support may not import src/ (biome's noRestrictedImports), so what
// runs a server outside the adapter mirrors src/adapters: `pgCtl` finds
// pg_ctl as embedded-server.ts's postgresBinaries does, `onStoppedServer`
// starts it as startServer does (its log file and options) and logs in as
// embedded-postgres.ts's superuser, `serverRunning` judges a pid as
// server-lease.ts's isAlive does, and `freePort` picks a port as ports.ts's
// does. Change them together.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import { onTestFinished, vi } from "vitest";

export interface TestServer {
  /** The embedded server's data directory; pass it to `embeddedPostgres({ dataDir })`. */
  readonly dataDir: string;
  /** Runs one statement as the server's superuser in `database` (default `postgres`). */
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
    database?: string,
  ): Promise<Row[]>;
  /** Names of every non-template database on the server, sorted. */
  databases(): Promise<string[]>;
  /** Creates an empty database, runs `sql` in it, and returns its name. */
  createDatabase(sql?: string): Promise<string>;
  /**
   * The server processes of the sessions in `database` waiting for a lock
   * now, optionally only those whose statement matches `statement` (an ILIKE
   * pattern, e.g. `alter table%`).
   */
  lockWaiters(database: string, statement?: string): Promise<number[]>;
  /**
   * `lockWaiters` once there is one: polls for up to 10 s, then fails the
   * test. For a test that holds a lock and waits for a command to block on it.
   */
  untilLockWaiter(database: string, statement?: string): Promise<number[]>;
  stop(): Promise<void>;
}

let databaseCounter = 0;

export async function startTestServer(): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "super-deploy-test-pg-"));
  const dataDir = join(root, "data");
  const server = embeddedPostgres({ dataDir });
  await server.start();

  async function query<Row>(
    sql: string,
    values: readonly unknown[] = [],
    database = "postgres",
  ): Promise<Row[]> {
    const client = new pg.Client({
      connectionString: await server.connectionString(database),
    });
    client.on("error", () => {});
    await client.connect();
    try {
      const result =
        values.length === 0
          ? await client.query(sql)
          : await client.query(sql, [...values]);
      return result.rows as Row[];
    } finally {
      await client.end();
    }
  }

  async function lockWaiters(
    database: string,
    statement = "%",
  ): Promise<number[]> {
    const rows = await query<{ pid: number }>(
      "select pid from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query ilike $2 order by pid",
      [database, statement],
    );
    return rows.map((row) => row.pid);
  }

  return {
    dataDir,
    query,
    async databases() {
      const rows = await query<{ datname: string }>(
        "select datname from pg_database where not datistemplate order by datname",
      );
      return rows.map((row) => row.datname);
    },
    lockWaiters,
    async untilLockWaiter(database, statement) {
      let waiters: number[] = [];
      await vi.waitFor(
        async () => {
          waiters = await lockWaiters(database, statement);
          if (waiters.length === 0) {
            throw new Error(`No session in ${database} waits for a lock`);
          }
        },
        { timeout: 10_000, interval: 50 },
      );
      return waiters;
    },
    async createDatabase(sql) {
      databaseCounter += 1;
      const name = `test_${process.pid}_${databaseCounter}`;
      await query(`create database ${name}`);
      if (sql !== undefined) {
        await query(sql, [], name);
      }
      return name;
    },
    async stop() {
      await server.stop();
      await stopServerOn(dataDir);
      await removeServerFolder(root);
    },
  };
}

/**
 * Deletes a temp folder that holds a server's data directory. On Windows the
 * server's processes, whose working directory it is, can still hold it for a
 * moment after `pg_ctl stop -w` returns, so EBUSY is tried again for a few
 * seconds.
 */
export function removeServerFolder(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 10 });
}

/**
 * Whether a server runs on `dataDir`: its `postmaster.pid` names a live
 * process (EPERM: alive, as another user's).
 */
export async function serverRunning(dataDir: string): Promise<boolean> {
  const pid = await readFile(join(dataDir, "postmaster.pid"), "utf8").then(
    (text) => Number(text.split("\n")[0]),
    () => undefined,
  );
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Stops the server on `dataDir`, if one runs, whoever its clients are: for
 * cleaning up after a test.
 */
export async function stopServerOn(dataDir: string): Promise<void> {
  if (await serverRunning(dataDir)) {
    await pgCtl(["stop", "-D", dataDir, "-m", "fast", "-w"]);
  }
}

/**
 * Promotes the standby running on `dataDir` and waits until it has, as
 * `pg_ctl promote` does on every platform (Windows has no SIGUSR1). pg_ctl
 * refuses, changing nothing, until the server has entered standby mode, which
 * a loaded machine can take seconds to do after its postmaster starts: it is
 * tried again until then, for up to 20 s.
 */
export async function promoteStandby(dataDir: string): Promise<void> {
  await vi.waitFor(() => pgCtl(["promote", "-D", dataDir, "-w"]), {
    timeout: 20_000,
    interval: 100,
  });
}

/**
 * Runs one statement as the superuser on the stopped server of a data
 * directory, starting it for the statement and stopping it again outside the
 * adapter. Unlike a client of the server, it drops no leftover throwaway
 * databases, so a test can create or observe them.
 */
export async function onStoppedServer<Row>(
  dataDir: string,
  sql: string,
): Promise<Row[]> {
  const port = await freePort();
  await pgCtl([
    "start",
    "-D",
    dataDir,
    "-w",
    "-l",
    join(dataDir, "super-deploy-server.log"),
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`,
  ]);
  try {
    const client = new pg.Client({
      connectionString: `postgres://super_deploy:super_deploy@127.0.0.1:${port}/postgres`,
    });
    client.on("error", () => {});
    await client.connect();
    try {
      return (await client.query(sql)).rows as Row[];
    } finally {
      await client.end();
    }
  } finally {
    await pgCtl(["stop", "-D", dataDir, "-m", "fast", "-w"]);
  }
}

/** A port of 127.0.0.1 that is free now. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address !== "object") {
    throw new Error("no port");
  }
  return address.port;
}

/**
 * Listens on `port` of 127.0.0.1 (default: a free one) until the test
 * finishes, so no server can take it, and returns it. A port something else
 * already listens on is left to that.
 */
export async function holdPort(port = 0): Promise<number> {
  const holder: Server = createServer();
  const held = await new Promise<boolean>((resolve) => {
    holder.once("error", () => resolve(false));
    holder.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!held) {
    return port;
  }
  onTestFinished(
    () => new Promise<void>((resolve) => holder.close(() => resolve())),
  );
  const address = holder.address();
  if (address === null || typeof address !== "object") {
    throw new Error("no port");
  }
  return address.port;
}

/**
 * Runs embedded-postgres's `pg_ctl`, rejecting on a non-zero exit. Its output
 * is ignored: on Windows a server it starts would hold output pipes open (see
 * embedded-server.ts's header).
 */
async function pgCtl(args: readonly string[]): Promise<void> {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const library = createRequire(import.meta.url).resolve("embedded-postgres");
  const entry = createRequire(library).resolve(
    `@embedded-postgres/${platform}-${process.arch}`,
  );
  const { pg_ctl } = (await import(pathToFileURL(entry).href)) as {
    pg_ctl: string;
  };
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(pg_ctl, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    throw new Error(`pg_ctl ${args.join(" ")} exited with code ${code}`);
  }
}
