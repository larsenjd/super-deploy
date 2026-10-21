// Reaching a target: resolve its name from config, connect through its
// deployment adapter (only when a command actually touches it), check the
// server, and read the locale its rehearsals must match.

import type { DatabaseRequest, Session } from "../adapters/types.ts";
import { AdapterError } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { SuperDeployError } from "../errors.ts";
import type { GuardedCommand } from "../guard/guard.ts";
import { InterruptedError } from "../interruption.ts";
import type { Project } from "../project.ts";
import { adapterCall, requirePostgres18 } from "../rehearsal/throwaway.ts";

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

/** `SET LOCAL` statements for a target's lock and statement timeouts. */
export function targetTimeouts(target: ResolvedTarget): string[] {
  return [
    `SET LOCAL lock_timeout TO '${target.lockTimeoutMs}ms'`,
    ...(target.statementTimeoutMs === undefined
      ? []
      : [`SET LOCAL statement_timeout TO '${target.statementTimeoutMs}ms'`]),
  ];
}

/**
 * Opens a session to `target` through its adapter and refuses a server that
 * isn't PostgreSQL 18. Every call is one `adapter.connect()`; a deployment
 * calls it twice (see deploy/engine.ts for which session is which). The
 * adapter is handed the target's connectTimeout and `signal`; a connect that
 * fails once `signal` has aborted is InterruptedError. A connection-string
 * problem is reported as the target's own ("Target qa has no connection
 * string"): the adapter doesn't know the target's name.
 */
export async function connectTarget(
  target: ResolvedTarget,
  signal: AbortSignal | undefined,
): Promise<Session> {
  const session = await adapterCall(
    `The deployment adapter of target ${target.name}`,
    "connect",
    async () => {
      try {
        return await target.adapter.connect({
          timeoutMs: target.connectTimeoutMs,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new InterruptedError({ cause: error });
        }
        throw error instanceof AdapterError
          ? error.about(`Target ${target.name}`)
          : error;
      }
    },
  );
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

/** A command named a target that isn't in the config. */
export class UnknownTargetError extends SuperDeployError {
  readonly code = "unknown-target";
  readonly target: string;
  /** The targets the config does define. */
  readonly known: readonly string[];

  constructor(target: string, known: readonly string[]) {
    super(
      `There is no target ${JSON.stringify(target)} in super-deploy.config.ts (${known.length === 0 ? "no targets are defined" : `targets: ${known.join(", ")}`})`,
    );
    this.target = target;
    this.known = known;
  }
}

/**
 * deploy-draft or rebuild was refused because the target's own history
 * schema doesn't flag it as disposable (`disposable --set yes`). Nothing was
 * asked or changed.
 */
export class TargetNotDisposableError extends SuperDeployError {
  readonly code = "target-not-disposable";
  readonly command: GuardedCommand;
  readonly target: string;

  constructor(command: GuardedCommand, target: string) {
    super(
      `${command} only runs on disposable targets, and target ${target} is not disposable (flag it with disposable --target ${target} --set yes if it is safe to wipe): nothing changed`,
    );
    this.command = command;
    this.target = target;
  }
}
