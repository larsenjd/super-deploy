// The library's node-postgres adapters: a deployment adapter and a rehearsal
// adapter, each configured from a connection string or the name of an
// environment variable holding one. Environment variables are read only when
// a command actually connects, so a command that never touches a target
// never needs its credentials.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import type {
  DatabaseRequest,
  DeploymentAdapter,
  QueryResult,
  RehearsalAdapter,
  Session,
  ThrowawayDatabase,
} from "./types.ts";
import { AdapterError } from "./types.ts";

/** Where to find the connection string: inline, or in an environment variable. */
export type ConnectionSource = { connectionString: string } | { env: string };

/** A deployment adapter connecting with node-postgres. */
export function postgresTarget(source: ConnectionSource): DeploymentAdapter {
  return targetOver(async () => resolveConnectionString(source));
}

/**
 * A rehearsal adapter creating throwaway databases on an existing server with
 * node-postgres. The login needs `CREATEDB` and `CREATEROLE`.
 */
export function postgresRehearsal(source: ConnectionSource): RehearsalAdapter {
  return rehearsalOver(async () => resolveConnectionString(source));
}

/** @internal A deployment adapter over a lazily resolved connection string. */
export function targetOver(
  connectionString: () => Promise<string>,
): DeploymentAdapter {
  return {
    async connect() {
      return connectSession(await connectionString());
    },
  };
}

/** @internal Every throwaway database's name starts with this. */
export const rehearsalDatabasePrefix = "super_deploy_rehearsal_";

/** @internal A rehearsal adapter over a lazily resolved connection string. */
export function rehearsalOver(
  connectionString: () => Promise<string>,
): RehearsalAdapter & { close(): Promise<void> } {
  const live = new Set<ThrowawayDatabase>();
  return {
    async createDatabase(request) {
      const adminConnection = await connectionString();
      const name = `${rehearsalDatabasePrefix}${randomBytes(8).toString("hex")}`;
      await withSession(adminConnection, (admin) =>
        admin.query(createDatabaseSql(name, request)),
      );
      const database: ThrowawayDatabase = {
        name,
        connect: () => connectSession(adminConnection, name),
        async drop() {
          live.delete(database);
          await withSession(adminConnection, (admin) =>
            admin.query(
              `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`,
            ),
          );
        },
      };
      live.add(database);
      return database;
    },
    async close() {
      for (const database of [...live]) {
        await database.drop().catch(() => {});
      }
    },
  };
}

function resolveConnectionString(source: ConnectionSource): string {
  if ("connectionString" in source) {
    return source.connectionString;
  }
  const value = process.env[source.env];
  if (value === undefined || value === "") {
    throw new AdapterError(`Environment variable ${source.env} is not set`);
  }
  return value;
}

function createDatabaseSql(name: string, request: DatabaseRequest): string {
  const locale = pg.escapeLiteral(request.locale);
  const provider =
    request.collationProvider === "libc"
      ? `LOCALE_PROVIDER libc LOCALE ${locale}`
      : request.collationProvider === "icu"
        ? `LOCALE_PROVIDER icu ICU_LOCALE ${locale} LOCALE 'C'`
        : `LOCALE_PROVIDER builtin BUILTIN_LOCALE ${locale} LOCALE 'C'`;
  return `CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE template0 ENCODING ${pg.escapeLiteral(request.encoding)} ${provider}`;
}

/** @internal Opens a node-postgres session, optionally to another database on the same server. */
export async function connectSession(
  connectionString: string,
  database?: string,
): Promise<Session> {
  const config = parseIntoClientConfig(connectionString);
  const client = new pg.Client(
    database === undefined ? config : { ...config, database },
  );
  // Idle clients are killed server-side by DROP DATABASE ... WITH (FORCE) or a
  // server stop; without a listener that would crash the process.
  client.on("error", () => {});
  await client.connect();
  return sessionOver(client);
}

async function withSession<T>(
  connectionString: string,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await connectSession(connectionString);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

function sessionOver(client: pg.Client): Session {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result =
        values === undefined
          ? await client.query(sql)
          : await client.query(sql, [...values]);
      return { rows: result.rows as Row[] };
    },
    async execute(sql) {
      // Without parameters node-postgres uses the simple protocol: one round
      // trip, one result per statement (a bare object for a single statement).
      const result: pg.QueryResult | pg.QueryResult[] = await client.query(sql);
      const results = Array.isArray(result) ? result : [result];
      return results.map((one): QueryResult => ({ rows: one.rows }));
    },
    async serverVersion() {
      const result = await client.query<{ server_version: string }>(
        "SHOW server_version",
      );
      return result.rows[0]?.server_version ?? "unknown";
    },
    async close() {
      await client.end();
    },
  };
}
