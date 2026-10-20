// A real PostgreSQL 18 server for one test file, started through the
// library's own embedded-postgres adapter on a free port and a unique temp
// data directory. Test projects point their config at `dataDir`; their
// adapter finds the running server and attaches to it instead of starting
// another one, so every project in the file shares this server.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      await rm(root, { recursive: true, force: true });
    },
  };
}
