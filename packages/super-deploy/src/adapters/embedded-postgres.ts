// An embedded-postgres adapter: a private PostgreSQL 18 server in a project
// folder that provides rehearsal databases, local targets such as `dev`, or
// both. Imported as `superdeploy/embedded-postgres`; `embedded-postgres`
// itself is an optional peer dependency, whose binaries are found only when
// the server is first needed (`embedded-server.ts`).
//
// The generated config runs two (packages/template/super-deploy.config.ts):
// one for `dev` in `.super-deploy/dev` on a fixed `port`, so users and their
// apps connect to `dev` at a known URL, and one for rehearsals in
// `.super-deploy/rehearsal` on a free port, so a rehearsal never creates a
// database next to `dev` (ticket 06).
//
// One server per data directory, shared by every client of it under a lease
// (`server-lease.ts`, ticket 14): an instance registers when it is first
// needed, starting the server on its `port` or else a free one if it isn't
// running, or attaching to it, on whatever port it has, if it is (another
// command, a test harness). `stop()` releases the registration, and the last
// live client stops the server. So commands run at the same time in one
// project all share it, and none stops it under another. A client that finds
// only dead clients (commands killed outright) has taken the server over: it
// drops the throwaway databases they left behind, and its `stop()` stops the
// server. A `port` something else listens on fails the start with an
// AdapterError naming it and the setting.
//
// The server runs in a session of its own, so Ctrl+C in one terminal doesn't
// stop it under a command in another; the interrupted command's close
// releases its registration like any other.
//
// The server's superuser `super_deploy` sets the server up and runs the
// rehearsal databases. A target (`target(database)`) is deployed as the
// deploy role `deployer` instead, like a real target's: a LOGIN role that is
// not a superuser and holds no predefined roles, so `dev` gets none of the
// deploy pre-flight's superuser warnings. On each connect the superuser
// creates the role if it is missing and the database if it is missing, and
// makes the role the database's owner, one connect at a time
// (`targetSetupLock`). Owning the database gives it CREATE
// there (for the history schema) and `public`, through `pg_database_owner`.
// A database created before the deploy role existed keeps what the superuser
// created in it: the ownership pre-flight lists those objects.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  initialise,
  runningPort,
  startServer,
  stopServer,
  waitUntilAccepting,
} from "./embedded-server.ts";
import {
  connectSession,
  rehearsalDatabasePrefix,
  rehearsalOver,
  targetOver,
} from "./node-postgres.ts";
import {
  freePort,
  localHost as host,
  hostAndPort,
  portInUse,
} from "./ports.ts";
import {
  type Registration,
  register,
  release,
  withLeaseLock,
} from "./server-lease.ts";
import type { DeploymentAdapter, RehearsalAdapter } from "./types.ts";
import { AdapterError, shownPath } from "./types.ts";

export interface EmbeddedPostgresOptions {
  /**
   * The server's data directory. Created and initialised on first use. Pass an
   * absolute path or a file URL (e.g. `new URL(".super-deploy/postgres", import.meta.url)`).
   */
  dataDir: string | URL;
  /**
   * The port the server listens on, on 127.0.0.1, so its databases are always
   * at the same URL. If something else listens there, starting the server
   * fails. Default: a free port, picked each time the server starts.
   */
  port?: number;
}

export interface EmbeddedPostgres {
  /** Throwaway databases on the embedded server. */
  readonly rehearsal: RehearsalAdapter;
  /**
   * A target that is a database on the embedded server, created on first
   * connect. It is deployed as the deploy role `deployer`, which isn't a
   * superuser and owns the database.
   */
  target(database: string): DeploymentAdapter;
  /**
   * Registers as a client of the data directory's server, starting the server
   * if it isn't running.
   */
  start(): Promise<void>;
  /**
   * Releases this client's registration. The server stops when no live client
   * of its data directory remains.
   */
  stop(): Promise<void>;
  /**
   * A connection string for `database` (default `postgres`) as the server's
   * superuser, starting the server if needed.
   */
  connectionString(database?: string): Promise<string>;
}

// Local-only credentials: the server listens on 127.0.0.1 only.
const user = "super_deploy";
const password = "super_deploy";
const deployRole = "deployer";
const deployRolePassword = "deployer";

// Creates the deploy role unless it exists. Another process may create it
// meanwhile, so losing that race is not an error.
const createDeployRole = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${deployRole}') THEN
    CREATE ROLE ${deployRole} LOGIN PASSWORD '${deployRolePassword}';
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$`;

// The session-level advisory lock (two-key form, in the `postgres` database)
// a target's connect holds while it sets the deploy role and the database up,
// released when its admin session closes. Commands connecting at the same
// time would otherwise both create the database (a duplicate key on
// pg_database_datname_index) or both hand it over ("tuple concurrently
// updated"). The two-key form never meets the target lock's one-key form.
const targetSetupLock = [0x73757065, 1] as const;

export function embeddedPostgres(
  options: EmbeddedPostgresOptions,
): EmbeddedPostgres {
  const dataDir = resolve(
    options.dataDir instanceof URL
      ? fileURLToPath(options.dataDir)
      : options.dataDir,
  );
  let running: Promise<number> | undefined;
  let registration: Registration | undefined;
  /** The databases `target()` was asked for. */
  const targetDatabases = new Set<string>();

  function port(): Promise<number> {
    running ??= registerAndStart().catch((error: unknown) => {
      running = undefined;
      throw error;
    });
    return running;
  }

  async function registerAndStart(): Promise<number> {
    await initialise(dataDir, user, password, wayOut());
    return withLeaseLock(dataDir, async () => {
      const lease = await register(dataDir);
      const attached = await runningPort(dataDir);
      let answered = false;
      try {
        const serverPort = attached ?? (await start());
        const admin = urlAs(user, password, "postgres", serverPort);
        await waitUntilAccepting(admin, dataDir);
        answered = true;
        if (lease.others === 0) {
          await sweepLeftovers(admin);
        }
        registration = lease;
        return serverPort;
      } catch (error) {
        // A server attached to that never answered may be a stale
        // postmaster.pid naming an unrelated process: stopping it would
        // signal that process, so only the registration goes.
        await (attached === undefined || answered
          ? releaseLease(lease)
          : release(dataDir, lease)
        ).catch(() => {});
        throw error;
      }
    });
  }

  /**
   * What to do about a damaged data directory: deleting it loses only
   * throwaway databases, unless targets are databases on it.
   */
  function wayOut(): string {
    const databases = [...targetDatabases];
    return databases.length === 0
      ? "with no super-deploy command running, delete that folder; it holds only rehearsals' throwaway databases, so nothing is lost"
      : `with no super-deploy command running, delete that folder and deploy again to the targets on it (${databases.length === 1 ? "database" : "databases"} ${databases.join(", ")}), losing whatever was added to them by hand`;
  }

  /** Starts the server, which isn't running. Call under the lease lock. */
  async function start(): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      if (options.port !== undefined && (await portInUse(options.port))) {
        throw new AdapterError(
          `Embedded PostgreSQL can't start in ${shownPath(dataDir)}: port ${options.port} on ${host} is in use by another program. Stop that program, or set another \`port\` in embeddedPostgres({ ... }) in super-deploy.config.ts`,
        );
      }
      const candidate = options.port ?? (await freePort());
      try {
        await startServer(dataDir, candidate);
        return candidate;
      } catch (error) {
        // A free port may have been taken meanwhile: try another.
        if (attempt === 3 || options.port !== undefined) {
          throw error;
        }
      }
    }
  }

  /** Releases a registration, stopping the server if it was the last. */
  async function releaseLease(lease: Registration): Promise<void> {
    if (
      (await release(dataDir, lease)) === 0 &&
      (await runningPort(dataDir)) !== undefined
    ) {
      await stopServer(dataDir);
    }
  }

  function urlAs(
    role: string,
    rolePassword: string,
    database: string,
    serverPort: number,
  ): string {
    return `postgres://${role}:${rolePassword}@${host}:${serverPort}/${encodeURIComponent(database)}`;
  }

  async function connectionString(database = "postgres"): Promise<string> {
    return urlAs(user, password, database, await port());
  }

  async function stop(): Promise<void> {
    const starting = running;
    running = undefined;
    await starting?.catch(() => {});
    const lease = registration;
    registration = undefined;
    if (lease !== undefined) {
      await withLeaseLock(dataDir, () => releaseLease(lease));
    }
  }

  // Throwaway databases left behind by clients that are gone, e.g. a command
  // killed outright mid-rehearsal. Dropped only by a client registering next
  // to no live one: another client may be using them.
  async function sweepLeftovers(admin: string): Promise<void> {
    const session = await connectSession(admin);
    try {
      const { rows } = await session.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
        [rehearsalDatabasePrefix],
      );
      for (const { datname } of rows) {
        await session.query(
          `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`,
        );
      }
    } finally {
      await session.close();
    }
  }

  const rehearsal = rehearsalOver(() => connectionString());

  return {
    rehearsal: {
      createDatabase: (request) => rehearsal.createDatabase(request),
      async close() {
        await rehearsal.close();
        await stop();
      },
    },
    target(database) {
      targetDatabases.add(database);
      const target = targetOver(async () => {
        const admin = await connectSession(await connectionString());
        try {
          await admin.query(
            `SELECT pg_advisory_lock(${targetSetupLock.join(", ")})`,
          );
          await admin.query(createDeployRole);
          const existing = await admin.query<{ owner: string }>(
            "SELECT pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_catalog.pg_database WHERE datname = $1",
            [database],
          );
          const quoted = pg.escapeIdentifier(database);
          if (existing.rows.length === 0) {
            await admin.query(`CREATE DATABASE ${quoted} OWNER ${deployRole}`);
          } else if (existing.rows[0]?.owner !== deployRole) {
            await admin.query(
              `ALTER DATABASE ${quoted} OWNER TO ${deployRole}`,
            );
          }
        } finally {
          await admin.close();
        }
        return urlAs(deployRole, deployRolePassword, database, await port());
      });
      return {
        connect: (options) => target.connect(options),
        host: async () => hostAndPort(host, await port()),
        close: stop,
      };
    },
    start: async () => {
      await port();
    },
    stop,
    connectionString,
  };
}
