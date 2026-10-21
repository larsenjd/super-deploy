// Throwaway databases from the rehearsal adapter: always PostgreSQL 18,
// always dropped, with session settings pinned identically to deployments.

import { inTransaction } from "../adapters/transaction.ts";
import type {
  DatabaseRequest,
  RehearsalAdapter,
  Session,
} from "../adapters/types.ts";
import { AdapterError } from "../adapters/types.ts";
import { quoteIdentifier } from "../deploy/history.ts";
import { SuperDeployError } from "../errors.ts";
import type { ParsedStatement } from "../sql-analysis/index.ts";
import {
  externalSchemasBoundAtCreate,
  isAlreadyInstalled,
} from "../sql-analysis/index.ts";

/**
 * Drafts and draft rehearsals: UTF-8 with PostgreSQL 18's builtin `C.UTF-8`
 * locale, which behaves the same on every OS. Deployment rehearsals match the
 * target's settings instead (ticket 04).
 */
export const draftDatabaseRequest: DatabaseRequest = {
  encoding: "UTF8",
  locale: "C.UTF-8",
  collationProvider: "builtin",
};

const rehearsalAdapter = "The rehearsal adapter";

/**
 * Creates a throwaway database, checks it is PostgreSQL 18, runs `use` on a
 * session to it, then closes the session and drops the database whatever
 * happens.
 */
export async function withThrowawayDatabase<T>(
  adapter: RehearsalAdapter,
  request: DatabaseRequest,
  use: (session: Session) => Promise<T>,
): Promise<T> {
  const database = await adapterCall(
    rehearsalAdapter,
    "create a throwaway database",
    () => adapter.createDatabase(request),
  );
  try {
    const session = await adapterCall(
      rehearsalAdapter,
      `connect to throwaway database ${database.name}`,
      () => database.connect(),
    );
    try {
      await requirePostgres18(session, "The rehearsal server");
      return await use(session);
    } finally {
      await session.close().catch(() => {});
    }
  } finally {
    await adapterCall(
      rehearsalAdapter,
      `drop throwaway database ${database.name}`,
      () => database.drop(),
    );
  }
}

/** Refuses a session whose server isn't PostgreSQL 18. */
export async function requirePostgres18(
  session: Session,
  source: string,
): Promise<void> {
  const version = await session.serverVersion();
  if (/^(\d+)/.exec(version)?.[1] !== "18") {
    throw new UnsupportedServerError(source, version);
  }
}

/**
 * Session settings pinned identically in rehearsals and deployments, as
 * `SET LOCAL` statements for the start of a transaction.
 */
export function pinnedSettings(managedSchema: string): string[] {
  return [
    `SET LOCAL search_path TO ${quoteIdentifier(managedSchema)}, pg_catalog`,
    "SET LOCAL TimeZone TO 'UTC'",
    "SET LOCAL DateStyle TO 'ISO, YMD'",
    "SET LOCAL IntervalStyle TO 'postgres'",
    "SET LOCAL check_function_bodies TO on",
  ];
}

/** Runs `body` in one transaction that starts with the pinned settings. */
export function inPinnedTransaction(
  session: Session,
  managedSchema: string,
  body: () => Promise<void>,
): Promise<void> {
  return inTransaction(session, async () => {
    await session.execute(pinnedSettings(managedSchema).join(";\n"));
    await body();
  });
}

/** Creates the managed schema if the database doesn't have it yet. */
export async function ensureManagedSchema(
  session: Session,
  managedSchema: string,
): Promise<void> {
  await session.execute(
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(managedSchema)}`,
  );
}

/**
 * Loads ordered desired-schema statements in one transaction, one statement
 * at a time so a failure names its file and line. A failing statement that
 * binds to a declared external schema at CREATE gets a hint: rehearsals never
 * contain external schemas.
 */
export async function loadDesiredSchema(
  session: Session,
  statements: readonly ParsedStatement[],
  managedSchema: string,
  externalSchemas: readonly string[] = [],
): Promise<void> {
  await ensureManagedSchema(session, managedSchema);
  await inPinnedTransaction(session, managedSchema, async () => {
    for (const statement of statements) {
      if (isAlreadyInstalled(statement)) {
        continue;
      }
      try {
        await session.execute(statement.text);
      } catch (error) {
        throw new DesiredSchemaLoadError(
          statement.file,
          statement.line +
            linesBefore(
              statement.text,
              (error as { position?: string }).position,
            ),
          error instanceof Error ? error.message : String(error),
          {
            cause: error,
            hint:
              externalHint(statement, externalSchemas) ??
              materializedViewHint(statement, error),
          },
        );
      }
    }
  });
}

function externalHint(
  statement: ParsedStatement,
  externalSchemas: readonly string[],
): string | undefined {
  const schemas = externalSchemasBoundAtCreate(statement, externalSchemas);
  if (schemas.length === 0) {
    return undefined;
  }
  return `this statement references ${externalSchemaExplanation(schemas)}`;
}

/**
 * Why a statement referencing these external schemas can't load, as the
 * object of "references": `external schema "auth", which rehearsals don't
 * contain. ...`.
 */
export function externalSchemaExplanation(schemas: readonly string[]): string {
  const names = schemas.map((schema) => `"${schema}"`).join(", ");
  return `external schema ${names}, which rehearsals don't contain. Only PL/pgSQL bodies may reference external schemas: views, defaults, foreign keys, triggers, LANGUAGE sql and BEGIN ATOMIC bodies, and PL/pgSQL variable declarations bind their references at CREATE`;
}

/**
 * PostgreSQL creates (and refreshes) a materialized view with
 * `search_path = pg_catalog, pg_temp`, so a LANGUAGE sql function it calls
 * can't find unqualified tables.
 */
function materializedViewHint(
  statement: ParsedStatement,
  error: unknown,
): string | undefined {
  const node = statement.node as { CreateTableAsStmt?: { objtype?: string } };
  const code = (error as { code?: string }).code;
  if (
    node.CreateTableAsStmt?.objtype !== "OBJECT_MATVIEW" ||
    (code !== "42P01" && code !== "42883" && code !== "42704")
  ) {
    return undefined;
  }
  return "PostgreSQL builds a materialized view with search_path set to pg_catalog only, so a LANGUAGE sql function it calls must schema-qualify the objects it uses (or set search_path in the function)";
}

function linesBefore(text: string, position: string | undefined): number {
  const index = Number(position);
  if (!(index > 0)) {
    return 0;
  }
  return Array.from(text)
    .slice(0, index - 1)
    .filter((character) => character === "\n").length;
}

/**
 * Calls an adapter, turning anything it throws (other than a SuperDeployError)
 * into an AdapterError: "`adapter` failed to `action`: reason".
 */
export async function adapterCall<T>(
  adapter: string,
  action: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SuperDeployError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new AdapterError(`${adapter} failed to ${action}: ${reason}`, {
      cause: error,
    });
  }
}

/** PostgreSQL refused a desired-schema statement while loading it into a throwaway database. */
export class DesiredSchemaLoadError extends SuperDeployError {
  readonly code = "desired-schema-load-failed";
  readonly file: string;
  readonly line: number;
  /** PostgreSQL's own message. */
  readonly detail: string;
  /** Our explanation of the likely cause, when we know one. */
  readonly hint: string | undefined;

  constructor(
    file: string,
    line: number,
    detail: string,
    options?: ErrorOptions & { hint?: string | undefined },
  ) {
    const hint = options?.hint;
    super(
      `${file}:${line}: PostgreSQL refused the desired schema: ${detail}${hint === undefined ? "" : `. Hint: ${hint}`}`,
      options,
    );
    this.file = file;
    this.line = line;
    this.detail = detail;
    this.hint = hint;
  }
}

/** An adapter connected to a server that isn't PostgreSQL 18. */
export class UnsupportedServerError extends SuperDeployError {
  readonly code = "unsupported-server";
  readonly serverVersion: string;

  constructor(source: string, serverVersion: string) {
    super(
      `${source} is PostgreSQL ${serverVersion}, but super-deploy requires PostgreSQL 18`,
    );
    this.serverVersion = serverVersion;
  }
}
