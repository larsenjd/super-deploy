// A real PostgreSQL 16 server for one test file: an unsupported version,
// which `postgresVersion` allows as an escape hatch for adoption (ADR-0007).
// Started straight from the `embedded-postgres-16` dev dependency (an alias of
// embedded-postgres 16), on a free port and a unique temp data directory, as
// the superuser `postgres`. Projects reach it through `postgresTarget`.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres-16";
import pg from "pg";
import { freePort, removeServerFolder } from "./postgres.ts";

export interface Postgres16Server {
  /** A superuser connection string to `database`. */
  connectionString(database: string): string;
  /** Creates an empty database, runs `sql` in it, and returns its name. */
  createDatabase(sql?: string): Promise<string>;
  stop(): Promise<void>;
}

let databaseCounter = 0;

export async function startPostgres16(): Promise<Postgres16Server> {
  const root = await mkdtemp(join(tmpdir(), "super-deploy-test-pg16-"));
  const port = await freePort();
  const password = "postgres";
  const server = new EmbeddedPostgres({
    databaseDir: join(root, "data"),
    port,
    user: "postgres",
    password,
    authMethod: "scram-sha-256",
    // As embedded-server.ts's initdb does. initdb would otherwise take the
    // system locale's encoding, WIN1252 on Windows, which can't hold the
    // non-ASCII text in pg-delta's catalog queries.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    persistent: false,
    onLog: () => {},
  });
  await server.initialise();
  await server.start();

  const connectionString = (database: string) =>
    `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;

  return {
    connectionString,
    async createDatabase(sql = "") {
      const name = `pg16_${process.pid}_${++databaseCounter}`;
      await server.createDatabase(name);
      if (sql !== "") {
        const client = new pg.Client({
          connectionString: connectionString(name),
        });
        await client.connect();
        try {
          await client.query(sql);
        } finally {
          await client.end();
        }
      }
      return name;
    },
    async stop() {
      await server.stop();
      await removeServerFolder(root);
    },
  };
}
