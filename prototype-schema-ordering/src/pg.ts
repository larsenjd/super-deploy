// THROWAWAY spike (Q35 schema ordering). Copied from prototype-pg-delta/src/pg.ts with a different database prefix. Starts a private PostgreSQL 18 cluster via
// embedded-postgres and hands out throwaway databases. Every database name
// starts with PREFIX so nobody mistakes them for anything worth keeping.
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

export const PREFIX = "prototype_schema_ordering_wipe_me";
const DATA_DIR = fileURLToPath(new URL("../.pgdata-wipe-me", import.meta.url));
let PORT = 0;
const USER = "prototype_owner";
const PASSWORD = "prototype";

export const OWNER = USER;
export const ROLES = ["prototype_reader", "prototype_writer"];

let server: EmbeddedPostgres | undefined;
let admin: pg.Pool | undefined;
const pools = new Map<string, pg.Pool>();

export async function startCluster(): Promise<string> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  PORT = Number(process.env.PROTOTYPE_PG_PORT ?? (await freePort()));
  server = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: false,
    onLog: (m) => process.env.PROTOTYPE_PG_LOG && console.error("[pg]", m),
    onError: (m) => console.error("[pg:error]", m),
  });
  await server.initialise();
  await server.start();
  admin = new pg.Pool({ ...conn("postgres"), max: 2 });
  const { rows } = await admin.query("select version() as v, current_setting('server_version_num') as n");
  if (!String(rows[0].n).startsWith("18")) throw new Error(`expected PG18, got ${rows[0].v}`);
  for (const role of ROLES) await admin.query(`create role ${role} nologin`);
  await freshDb(PREFIX); // the "main" scratch database, kept for the whole run
  return rows[0].v as string;
}

export async function stopCluster(): Promise<void> {
  for (const p of pools.values()) await p.end().catch(() => {});
  pools.clear();
  await admin?.end().catch(() => {});
  await server?.stop().catch(() => {});
  rmSync(DATA_DIR, { recursive: true, force: true });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function conn(database: string): pg.PoolConfig {
  return { host: "localhost", port: PORT, user: USER, password: PASSWORD, database };
}

/** Drop (if present) and recreate a throwaway database; returns a pool on it. */
export async function freshDb(suffix: string): Promise<pg.Pool> {
  const name = suffix === PREFIX ? PREFIX : `${PREFIX}_${suffix}`;
  if (!/^[a-z0-9_]+$/.test(name) || name.length > 63) throw new Error(`bad db name ${name}`);
  const old = pools.get(name);
  if (old) {
    pools.delete(name);
    await old.end();
  }
  await admin!.query(`drop database if exists ${name} with (force)`);
  await admin!.query(`create database ${name} template template0 encoding 'UTF8'`);
  const pool = new pg.Pool({ ...conn(name), max: 4 });
  pool.on("error", () => {}); // idle clients killed by DROP DATABASE ... WITH (FORCE)
  pools.set(name, pool);
  return pool;
}

export async function dropDb(pool: pg.Pool): Promise<void> {
  for (const [name, p] of pools) {
    if (p === pool) {
      pools.delete(name);
      await p.end();
      await admin!.query(`drop database if exists ${name} with (force)`);
    }
  }
}

/** Run a SQL script as one multi-statement simple query (autocommit per statement). */
export async function runSql(pool: pg.Pool, sql: string): Promise<void> {
  if (sql.trim() === "") return;
  await pool.query(sql);
}

/** Apply a schema change the way super-deploy would: one transaction, pinned settings. */
export async function applyInOneTransaction(pool: pg.Pool, statements: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local search_path = public, pg_catalog");
    await client.query("set local check_function_bodies = on");
    for (const s of statements) await client.query(s);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
