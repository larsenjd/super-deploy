// Adapter interfaces: how super-deploy reaches PostgreSQL. Integrators may
// implement these themselves (secrets managers, IAM tokens, tunnels, CI
// servers); the library ships node-postgres and embedded-postgres versions.
// The library validates what adapters return (e.g. it refuses a server that
// isn't PostgreSQL 18), so adapters stay thin.

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

/**
 * One connection to one database. Statements run in autocommit unless the
 * caller sends BEGIN; a session is never shared by two callers at once.
 */
export interface Session {
  /** Runs exactly one statement, optionally with `$1`-style parameters. */
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  /**
   * Runs one or more statements as a single simple-protocol batch (no
   * parameters) and resolves to one result per statement, in order.
   */
  execute(sql: string): Promise<QueryResult[]>;
  /** The server's `server_version`, e.g. `18.4`. */
  serverVersion(): Promise<string>;
  close(): Promise<void>;
}

/** Connects to one named target. Called only by commands that touch that target. */
export interface DeploymentAdapter {
  connect(): Promise<Session>;
  /** Releases anything the adapter holds (pools, servers it started). */
  close?(): Promise<void>;
}

export type CollationProvider = "libc" | "icu" | "builtin";

/** What a throwaway database must match. */
export interface DatabaseRequest {
  /** e.g. `UTF8`. */
  encoding: string;
  /** The libc locale, ICU locale or builtin locale, depending on `collationProvider`. */
  locale: string;
  collationProvider: CollationProvider;
}

export interface ThrowawayDatabase {
  readonly name: string;
  connect(): Promise<Session>;
  /** Drops the database, closing any sessions still connected to it. */
  drop(): Promise<void>;
}

/**
 * Provides empty throwaway PostgreSQL 18 databases for rehearsals. Its login
 * needs `CREATEROLE` (rehearsals create missing roles as NOLOGIN).
 */
export interface RehearsalAdapter {
  createDatabase(request: DatabaseRequest): Promise<ThrowawayDatabase>;
  /** Releases anything the adapter holds (pools, servers it started). */
  close?(): Promise<void>;
}
