// The library's node-postgres adapters: a deployment adapter and a rehearsal
// adapter, each configured from a connection string or the name of an
// environment variable holding one. Environment variables are read only when
// a command actually connects, so a command that never touches a target
// never needs its credentials. The connection string is checked before any
// connection is attempted (ConnectionStringError): node-postgres's parser
// turns undefined, "" or a non-URL into odd errors such as "ENOTFOUND base".
// The adapter doesn't know its target's name, so connectTarget renames the
// error's subject (deploy/target.ts).
//
// A target connect honours ConnectOptions with its own deadline and the
// interruption signal, racing client.connect(), rather than node-postgres's
// connectionTimeoutMillis: that fails with a bare "timeout expired", and
// client.end() during a connect never settles connect(), so racing is the one
// way to abandon it on an interruption anyway. Without the deadline an
// unreachable host waits for the operating system's TCP timeout (minutes).
// node-postgres ignores connect_timeout in the URL.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { durationText } from "../config/config.ts";
import type {
  ConnectOptions,
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
  return targetOver(async () =>
    resolveConnectionString(source, "The deployment adapter"),
  );
}

/**
 * A rehearsal adapter creating throwaway databases on an existing server with
 * node-postgres. The login needs `CREATEDB`; rehearsals create no roles, so
 * it never needs `CREATEROLE`.
 */
export function postgresRehearsal(source: ConnectionSource): RehearsalAdapter {
  return rehearsalOver(async () =>
    resolveConnectionString(source, "The rehearsal adapter"),
  );
}

/** @internal A deployment adapter over a lazily resolved connection string. */
export function targetOver(
  connectionString: () => Promise<string>,
): DeploymentAdapter {
  return {
    async connect(options) {
      return connectSession(await connectionString(), undefined, options);
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

/** @internal What is wrong with a ConnectionSource. */
export type ConnectionStringProblem =
  | { kind: "missing"; value: "undefined" | "empty" | "not a string" }
  | { kind: "variable-unset"; variable: string }
  | { kind: "variable-empty"; variable: string }
  | { kind: "not-postgres-url" };

/**
 * @internal A ConnectionSource gives no usable connection string. `subject`
 * names who it belongs to ("Target qa"); see `about`.
 */
export class ConnectionStringError extends AdapterError {
  readonly problem: ConnectionStringProblem;

  constructor(problem: ConnectionStringProblem, subject: string) {
    super(connectionStringMessage(problem, subject));
    this.problem = problem;
  }

  /** The same problem, attributed to `subject`. */
  about(subject: string): ConnectionStringError {
    return new ConnectionStringError(this.problem, subject);
  }
}

// Never echoes the connection string: it may hold a password.
function connectionStringMessage(
  problem: ConnectionStringProblem,
  subject: string,
): string {
  switch (problem.kind) {
    case "missing":
      return `${subject} has no connection string (connectionString is ${problem.value}): set one in super-deploy.config.ts, usually from an environment variable with postgresTarget({ env: "DATABASE_URL" })`;
    case "variable-unset":
      return `${subject}: environment variable ${problem.variable} is not set`;
    case "variable-empty":
      return `${subject}: environment variable ${problem.variable} is empty`;
    case "not-postgres-url":
      return `${subject}'s connection string is not a PostgreSQL URL (postgres://user:password@host:port/database)`;
  }
}

function resolveConnectionString(
  source: ConnectionSource,
  subject: string,
): string {
  const value: unknown =
    "env" in source ? process.env[source.env] : source.connectionString;
  const problem = sourceProblem(source, value);
  if (problem !== undefined) {
    throw new ConnectionStringError(problem, subject);
  }
  return value as string;
}

/** What is wrong with `value`, read from `source`, if anything. */
function sourceProblem(
  source: ConnectionSource,
  value: unknown,
): ConnectionStringProblem | undefined {
  if ("env" in source) {
    if (value === undefined) {
      return { kind: "variable-unset", variable: source.env };
    }
    if (value === "") {
      return { kind: "variable-empty", variable: source.env };
    }
  } else if (typeof value !== "string" || value === "") {
    return {
      kind: "missing",
      value:
        value === undefined
          ? "undefined"
          : value === ""
            ? "empty"
            : "not a string",
    };
  }
  return typeof value === "string" && isPostgresUrl(value)
    ? undefined
    : { kind: "not-postgres-url" };
}

/** A postgres:// or postgresql:// URL that node-postgres can parse. */
function isPostgresUrl(value: string): boolean {
  if (!/^postgres(ql)?:\/\//i.test(value)) {
    return false;
  }
  try {
    parseIntoClientConfig(value);
    return true;
  } catch {
    return false;
  }
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

/**
 * @internal Opens a node-postgres session, optionally to another database on
 * the same server, within `options` if given (see the header).
 */
export async function connectSession(
  connectionString: string,
  database?: string,
  options?: ConnectOptions,
): Promise<Session> {
  const config = parseIntoClientConfig(connectionString);
  const client = new pg.Client(
    database === undefined ? config : { ...config, database },
  );
  // Idle clients are killed server-side by DROP DATABASE ... WITH (FORCE) or a
  // server stop; without a listener that would crash the process.
  client.on("error", () => {});
  if (options === undefined) {
    await client.connect();
  } else {
    const host = `${config.host ?? "localhost"}:${config.port ?? 5432}`;
    await connectWithin(client, host, options);
  }
  return sessionOver(client);
}

/**
 * Connects `client`, giving up after `options.timeoutMs` or as soon as
 * `options.signal` aborts (rejecting with its reason), and then dropping the
 * half-open connection.
 */
async function connectWithin(
  client: pg.Client,
  host: string,
  options: ConnectOptions,
): Promise<void> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const stop =
    options.signal === undefined
      ? deadline
      : AbortSignal.any([options.signal, deadline]);
  let abandon = () => {};
  const abandoned = new Promise<never>((_, reject) => {
    abandon = () =>
      reject(
        deadline.aborted
          ? new Error(
              `no answer from ${host} within ${durationText(options.timeoutMs)} (connectTimeout in super-deploy.config.ts)`,
            )
          : stop.reason,
      );
  });
  if (stop.aborted) {
    abandon();
  }
  stop.addEventListener("abort", abandon, { once: true });
  try {
    await Promise.race([client.connect(), abandoned]);
  } catch (error) {
    // Not awaited: it destroys the socket, and its promise never settles if
    // the connect was abandoned before the server answered.
    client.end().catch(() => {});
    throw error;
  } finally {
    stop.removeEventListener("abort", abandon);
  }
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
