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
  rolesNamedIn,
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
 * Creates every role in `roles` that the rehearsal server lacks, as NOLOGIN,
 * outside any transaction. Roles are server-wide and never dropped: a
 * rehearsal must not remove a role something else on the server relies on.
 * Another rehearsal creating the same role at the same moment is fine.
 */
export async function ensureRoles(
  session: Session,
  roles: readonly string[],
): Promise<void> {
  if (roles.length === 0) {
    return;
  }
  const { rows } = await session.query<{ rolname: string }>(
    "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
    [roles],
  );
  const existing = new Set(rows.map((row) => row.rolname));
  for (const role of roles.filter((name) => !existing.has(name))) {
    try {
      await session.execute(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
    } catch (error) {
      // 42710 duplicate_object, or 23505 when a concurrent CREATE ROLE wins
      // the race on pg_authid's unique index.
      const code = (error as { code?: string }).code;
      if (code !== "42710" && code !== "23505") {
        throw error;
      }
    }
  }
}

/**
 * Loads ordered desired-schema statements in one transaction, one statement
 * at a time so a failure names its file and line. A failing statement that
 * binds to a declared external schema at CREATE gets a hint: rehearsals never
 * contain external schemas. Roles the statements grant to are created first
 * if the server lacks them (ensureRoles).
 */
export async function loadDesiredSchema(
  session: Session,
  statements: readonly ParsedStatement[],
  managedSchema: string,
  externalSchemas: readonly string[] = [],
): Promise<void> {
  await ensureManagedSchema(session, managedSchema);
  await ensureRoles(session, rolesNamedIn(statements));
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
          {
            cause: error,
            hint:
              externalHint(statement, externalSchemas) ??
              materializedViewHint(statement, error),
          },
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
