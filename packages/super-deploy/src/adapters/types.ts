// Adapter interfaces: how super-deploy reaches PostgreSQL. Integrators may
// implement these themselves (secrets managers, IAM tokens, tunnels, CI
// servers); the library ships node-postgres and embedded-postgres versions.
// The library validates what adapters return (e.g. it refuses a server that
// isn't PostgreSQL 18), so adapters stay thin.

import { SuperDeployError } from "../errors.ts";
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

/**
 * What a target connection is asked to honour. The library always passes it;
 * an adapter that ignores it connects as long as it takes, uninterrupted.
 */
export interface ConnectOptions {
  /** Give up after this many milliseconds: the target's `connectTimeout`. */
  readonly timeoutMs: number;
  /** Abandon the connect when this aborts: the project's interruption signal. */
  readonly signal?: AbortSignal | undefined;
}

/** Connects to one named target. Called only by commands that touch that target. */
export interface DeploymentAdapter {
  connect(options?: ConnectOptions): Promise<Session>;
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
 * needs `CREATEDB`, and never `CREATEROLE`: rehearsals create no roles.
 */
export interface RehearsalAdapter {
  createDatabase(request: DatabaseRequest): Promise<ThrowawayDatabase>;
  /** Releases anything the adapter holds (pools, servers it started). */
  close?(): Promise<void>;
}

/** An adapter failed to provide a database or connection. */
export class AdapterError extends SuperDeployError {
  readonly code = "adapter-failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
