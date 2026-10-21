// Adapter interfaces: how super-deploy reaches PostgreSQL. Integrators may
// implement these themselves (secrets managers, IAM tokens, tunnels, CI
// servers); the library ships node-postgres and embedded-postgres versions.
// The library validates what adapters return (e.g. it refuses a server that
// isn't PostgreSQL 18), so adapters stay thin.

import { isAbsolute, relative, sep } from "node:path";
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
  /**
   * Where `connect` connects, as configured: `host:port`, never credentials
   * (`db.example.com:5432`). The guarded commands show it before asking for
   * YES, next to the address the server reports, so the person typing YES
   * recognises the target. Called only after a connect succeeded. Without
   * it, they show the server's address alone.
   */
  host?(): Promise<string>;
  /**
   * Releases anything the adapter holds: pools, and its client registration on
   * a server it shares with other commands, which stops that server if no
   * other client remains (the embedded adapter).
   */
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
  /**
   * Releases anything the adapter holds: pools, and its client registration on
   * a server it shares with other commands, which stops that server if no
   * other client remains (the embedded adapter).
   */
  close?(): Promise<void>;
}

/**
 * An adapter failed to provide a database or connection. A subclass may
 * narrow `code` to one of its own (ConnectionStringError).
 */
/**
 * `path` as an adapter's message shows it: relative to the working directory
 * when it is inside it (a command runs in its project's folder, so that is
 * project-relative, as the CLI shows paths), absolute otherwise.
 */
export function shownPath(path: string): string {
  const inside = relative(process.cwd(), path);
  return inside === "" || inside.startsWith("..") || isAbsolute(inside)
    ? path
    : inside.split(sep).join("/");
}

export class AdapterError extends SuperDeployError {
  readonly code: "adapter-failed" | "connection-string-invalid" =
    "adapter-failed";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }

  /**
   * The same failure, attributed to `subject` ("Target qa"): an adapter
   * doesn't know its target's name, so the caller names it. A subclass whose
   * message names a subject rebuilds it; this one names none and is returned
   * as it is.
   */
  about(_subject: string): AdapterError {
    return this;
  }
}
