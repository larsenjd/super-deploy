// Reaching a target: resolve its name from config, connect through its
// deployment adapter (only when a command actually touches it), check the
// server, and read the locale its rehearsals must match.
//
// Every target session sets client_connection_check_interval (5 s). Without
// it PostgreSQL notices a vanished client only when it next writes to it, so
// a statement whose CLI was killed (SIGKILL, a lost laptop) runs to its end,
// possibly hours, holding the target lock and its table locks. With it the
// server polls the socket while the statement runs and ends the session soon
// after the client is gone. The setting is user-settable, but a server on a
// platform that can't poll (Windows) refuses any value but 0 with
// invalid_parameter_value; such a server runs without the check.

import type { DatabaseRequest, Session } from "../adapters/types.ts";
import { AdapterError } from "../adapters/types.ts";
import {
  durationText,
  type ResolvedTarget,
  targetDefaults,
} from "../config/config.ts";
import { SuperDeployError } from "../errors.ts";
import type { GuardedCommand, TargetView } from "../guard/guard.ts";
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

/** A target's lock and statement timeouts, as messages about them need them. */
export type TargetTimeoutSettings = Pick<
  ResolvedTarget,
  "name" | "lockTimeoutMs" | "statementTimeoutMs"
>;

/**
 * The timeout that made PostgreSQL cancel a statement on `target`, by its
 * SQLSTATE (55P03 lock timeout, 57014 statement timeout), for a message:
 * `setting` names it with the value that ran out ("the target's lockTimeout
 * (2s)", "... (5s, the default)", or, when the target sets no
 * statementTimeout, "the server's statement_timeout for the deploy role"),
 * and `change` says how to change it in the config. Undefined for any other SQLSTATE.
 */
export function timeoutThatRanOut(
  target: TargetTimeoutSettings,
  sqlState: string | undefined,
):
  | {
      readonly lock: boolean;
      readonly setting: string;
      readonly change: string;
    }
  | undefined {
  const where = `for target ${target.name} in super-deploy.config.ts`;
  if (sqlState === "55P03") {
    const value = durationText(target.lockTimeoutMs);
    return {
      lock: true,
      setting: `the target's lockTimeout (${target.lockTimeoutMs === targetDefaults.lockTimeoutMs ? `${value}, the default` : value})`,
      change: `raise lockTimeout ${where}`,
    };
  }
  if (sqlState === "57014") {
    return target.statementTimeoutMs === undefined
      ? {
          lock: false,
          setting: "the server's statement_timeout for the deploy role",
          change: `set statementTimeout ${where}, which overrides it`,
        }
      : {
          lock: false,
          setting: `the target's statementTimeout (${durationText(target.statementTimeoutMs)})`,
          change: `raise statementTimeout ${where}`,
        };
  }
  return undefined;
}

/**
 * Opens a session to `target` through its adapter and refuses a server that
 * isn't PostgreSQL 18, then sets the client connection check (see the
 * header). Every call is one `adapter.connect()`; a deployment calls it
 * twice (see deploy/engine.ts for which session is which). The
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
    await session.query(checkClientConnection);
  } catch (error) {
    await session.close().catch(() => {});
    throw error;
  }
  return session;
}

/** Sets client_connection_check_interval for the session, where the server's platform supports it (see the header). */
const checkClientConnection = `DO $$
BEGIN
  PERFORM set_config('client_connection_check_interval', '5s', false);
EXCEPTION WHEN invalid_parameter_value THEN
  NULL;
END
$$`;

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

/** A guarded command's precondition: throws TargetNotDisposableError unless the view shows the target disposable. */
export function requireDisposable(
  command: GuardedCommand,
  view: TargetView,
): void {
  if (!view.disposable) {
    throw new TargetNotDisposableError(command, view.target.name);
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
