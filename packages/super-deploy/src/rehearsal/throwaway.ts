// Throwaway databases from the rehearsal adapter: always PostgreSQL 18,
// always dropped, with session settings pinned identically to deployments.
import type {
  DatabaseRequest,
  RehearsalAdapter,
  Session,
} from "../adapters/types.ts";
import {
  AdapterError,
  DesiredSchemaLoadError,
  SuperDeployError,
  UnsupportedServerError,
} from "../errors.ts";
import {
  externalSchemasBoundAtCreate,
  isAlreadyInstalled,
} from "../sql-analysis/index.ts";
import type { ParsedStatement } from "../sql-analysis/parse.ts";

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
  const database = await adapterCall("create a throwaway database", () =>
    adapter.createDatabase(request),
  );
  try {
    const session = await adapterCall(
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
    await adapterCall(`drop throwaway database ${database.name}`, () =>
      database.drop(),
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
  await session.execute("BEGIN");
  try {
    await session.execute(pinnedSettings(managedSchema).join(";\n"));
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
          { cause: error, hint: externalHint(statement, externalSchemas) },
        );
      }
    }
    await session.execute("COMMIT");
  } catch (error) {
    await session.execute("ROLLBACK").catch(() => {});
    throw error;
  }
}

function externalHint(
  statement: ParsedStatement,
  externalSchemas: readonly string[],
): string | undefined {
  const schemas = externalSchemasBoundAtCreate(statement, externalSchemas);
  if (schemas.length === 0) {
    return undefined;
  }
  const names = schemas.map((schema) => `"${schema}"`).join(", ");
  return `this statement references external schema ${names}, which rehearsals don't contain. Only PL/pgSQL bodies may reference external schemas: views, defaults, foreign keys, triggers, LANGUAGE sql and BEGIN ATOMIC bodies, and PL/pgSQL variable declarations bind their references at CREATE`;
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

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function adapterCall<T>(
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
    throw new AdapterError(
      `The rehearsal adapter failed to ${action}: ${reason}`,
      {
        cause: error,
      },
    );
  }
}
