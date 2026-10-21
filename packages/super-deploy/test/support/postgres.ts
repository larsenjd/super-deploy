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
// `onStoppedServer`), which run `pg_ctl` outside the adapter's lease.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { embeddedPostgres } from "super-deploy/embedded-postgres";

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

  return {
    dataDir,
    query,
    async databases() {
      const rows = await query<{ datname: string }>(
        "select datname from pg_database where not datistemplate order by datname",
      );
      return rows.map((row) => row.datname);
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
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Whether a server runs on `dataDir`: its `postmaster.pid` names a live
 * process.
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
  } catch {
    return false;
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

/** Runs embedded-postgres's `pg_ctl`, rejecting on a non-zero exit. */
async function pgCtl(args: readonly string[]): Promise<void> {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const library = createRequire(import.meta.url).resolve("embedded-postgres");
  const entry = createRequire(library).resolve(
    `@embedded-postgres/${platform}-${process.arch}`,
  );
  const { pg_ctl } = (await import(pathToFileURL(entry).href)) as {
    pg_ctl: string;
  };
  await promisify(execFile)(pg_ctl, args, { windowsHide: true });
}
