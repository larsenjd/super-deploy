// Reaching a target: resolve its name from config, connect through its
// deployment adapter (only when a command actually touches it), check the
// server, and read the locale its rehearsals must match.
import type { DatabaseRequest, Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import {
  AdapterError,
  SuperDeployError,
  UnknownTargetError,
} from "../errors.ts";
import type { Project } from "../project.ts";
import { requirePostgres18 } from "../rehearsal/throwaway.ts";

/** The configured target called `name`, or UnknownTargetError. */
export function resolveTarget(project: Project, name: string): ResolvedTarget {
  const target = Object.hasOwn(project.config.targets, name)
    ? project.config.targets[name]
    : undefined;
  if (target === undefined) {
    throw new UnknownTargetError(name, Object.keys(project.config.targets));
  }
  return target;
}

/**
 * Opens a session to `target` through its adapter and refuses a server that
 * isn't PostgreSQL 18. Every call is one `adapter.connect()`; a deployment
 * calls it twice (see deploy/engine.ts for which session is which).
 */
export async function connectTarget(target: ResolvedTarget): Promise<Session> {
  let session: Session;
  try {
    session = await target.adapter.connect();
  } catch (error) {
    if (error instanceof SuperDeployError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new AdapterError(
      `The deployment adapter of target ${target.name} failed to connect: ${reason}`,
      { cause: error },
    );
  }
  try {
    await requirePostgres18(session, `Target ${target.name}`);
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
  return session;
}

/** The target database's encoding, locale and collation provider, for a matching throwaway database. */
export async function targetDatabaseRequest(
  session: Session,
): Promise<DatabaseRequest> {
  const { rows } = await session.query<{
    encoding: string;
    provider: string;
    collate: string;
    locale: string | null;
  }>(
    `SELECT pg_encoding_to_char(encoding) AS encoding, datlocprovider::text AS provider,
            datcollate AS collate, datlocale AS locale
       FROM pg_database WHERE datname = current_database()`,
  );
  const [row] = rows;
  if (row === undefined) {
    throw new AdapterError("Could not read the target database's locale");
  }
  switch (row.provider) {
    case "i":
      return {
        encoding: row.encoding,
        locale: row.locale ?? row.collate,
        collationProvider: "icu",
      };
    case "b":
      return {
        encoding: row.encoding,
        locale: row.locale ?? row.collate,
        collationProvider: "builtin",
      };
    default:
      return {
        encoding: row.encoding,
        locale: row.collate,
        collationProvider: "libc",
      };
  }
}
