// An embedded-postgres adapter: a private PostgreSQL 18 server in a project
// folder (e.g. `.super-deploy/postgres`, gitignored) that provides rehearsal
// databases and local targets such as `dev`. Imported as
// `super-deploy/embedded-postgres`; `embedded-postgres` itself is an optional
// peer dependency, loaded only when the server is first needed (importing it
// installs process exit and signal hooks).
//
// The server starts on a free port when a command first needs it and stops
// when the project is closed. If the data directory's server is already
// running (another command, or a test harness), the adapter attaches to it
// and leaves it running.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type EmbeddedPostgresServer from "embedded-postgres";
import pg from "pg";
import {
  connectSession,
  rehearsalDatabasePrefix,
  rehearsalOver,
  targetOver,
} from "./node-postgres.ts";
import type { DeploymentAdapter, RehearsalAdapter } from "./types.ts";
import { AdapterError } from "./types.ts";

export interface EmbeddedPostgresOptions {
  /**
   * The server's data directory. Created and initialised on first use. Pass an
   * absolute path or a file URL (e.g. `new URL(".super-deploy/postgres", import.meta.url)`).
   */
  dataDir: string | URL;
}

export interface EmbeddedPostgres {
  /** Throwaway databases on the embedded server. */
  readonly rehearsal: RehearsalAdapter;
  /** A target that is a database on the embedded server, created on first connect. */
  target(database: string): DeploymentAdapter;
  /** Starts the server, or attaches to it if it is already running. */
  start(): Promise<void>;
  /** Stops the server if this instance started it. */
  stop(): Promise<void>;
  /** A connection string for `database` (default `postgres`), starting the server if needed. */
  connectionString(database?: string): Promise<string>;
}

// Local-only credentials: the server listens on 127.0.0.1 only.
const user = "super_deploy";
const password = "super_deploy";
const host = "127.0.0.1";

export function embeddedPostgres(
  options: EmbeddedPostgresOptions,
): EmbeddedPostgres {
  const dataDir =
    options.dataDir instanceof URL
      ? fileURLToPath(options.dataDir)
      : resolve(options.dataDir);
  let running: Promise<number> | undefined;
  let owned: EmbeddedPostgresServer | undefined;

  function port(): Promise<number> {
    running ??= startOrAttach().catch((error: unknown) => {
      running = undefined;
      throw error;
    });
    return running;
  }

  async function startOrAttach(): Promise<number> {
    const attached = await runningPort(dataDir);
    if (attached !== undefined) {
      return attached;
    }
    const log: string[] = [];
    const remember = (message: unknown) => {
      log.push(String(message).trim());
      log.splice(0, log.length - 20);
    };
    const { default: EmbeddedPostgresClass } = await importDeferringSignals();
    const pgFlags = [
      "-c",
      `listen_addresses=${host}`,
      "-c",
      "unix_socket_directories=",
    ];
    if (!existsSync(join(dataDir, "PG_VERSION"))) {
      await mkdir(dirname(dataDir), { recursive: true });
      const initialiser = new EmbeddedPostgresClass({
        ...serverOptions(0),
        initdbFlags: ["--encoding=UTF8", "--locale=C", "--no-sync"],
      });
      await initialiser.initialise().catch((error: unknown) => {
        throw new AdapterError(
          `Embedded PostgreSQL failed to initialise ${dataDir}`,
          {
            cause: error,
          },
        );
      });
    }
    for (let attempt = 1; ; attempt++) {
      const candidate = await freePort();
      const server = new EmbeddedPostgresClass({
        ...serverOptions(candidate),
        postgresFlags: pgFlags,
      });
      try {
        await server.start();
        owned = server;
        return candidate;
      } catch {
        // Another process may have started the same data directory meanwhile.
        const other = await runningPort(dataDir);
        if (other !== undefined) {
          return other;
        }
        if (attempt === 3) {
          throw new AdapterError(
            `Embedded PostgreSQL failed to start in ${dataDir}: ${log.join(" | ")}`,
          );
        }
      }
    }

    function serverOptions(serverPort: number) {
      return {
        databaseDir: dataDir,
        port: serverPort,
        user,
        password,
        authMethod: "password" as const,
        persistent: true,
        onLog: remember,
        onError: remember,
      };
    }
  }

  async function connectionString(database = "postgres"): Promise<string> {
    const serverPort = await port();
    return `postgres://${user}:${password}@${host}:${serverPort}/${encodeURIComponent(database)}`;
  }

  async function stop(): Promise<void> {
    const server = owned;
    owned = undefined;
    running = undefined;
    swept = undefined;
    await server?.stop();
  }

  // Throwaway databases left behind on a server only this process uses, e.g.
  // when Ctrl+C in a terminal also reached the server and stopped it before
  // they could be dropped. Never swept on a server this process attached to:
  // another process may be using them.
  let swept: Promise<void> | undefined;
  async function sweepLeftovers(): Promise<void> {
    await port();
    if (owned === undefined) {
      return;
    }
    const admin = await connectSession(await connectionString());
    try {
      const { rows } = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
        [rehearsalDatabasePrefix],
      );
      for (const { datname } of rows) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`,
        );
      }
    } finally {
      await admin.close();
    }
  }

  const rehearsal = rehearsalOver(() => connectionString());

  return {
    rehearsal: {
      async createDatabase(request) {
        swept ??= sweepLeftovers().catch((error: unknown) => {
          swept = undefined;
          throw error;
        });
        await swept;
        return rehearsal.createDatabase(request);
      },
      async close() {
        await rehearsal.close();
        await stop();
      },
    },
    target(database) {
      const target = targetOver(async () => {
        const admin = await connectSession(await connectionString());
        try {
          const existing = await admin.query(
            "SELECT 1 FROM pg_database WHERE datname = $1",
            [database],
          );
          if (existing.rows.length === 0) {
            await admin.query(
              `CREATE DATABASE ${pg.escapeIdentifier(database)}`,
            );
          }
        } finally {
          await admin.close();
        }
        return connectionString(database);
      });
      return { connect: () => target.connect(), close: stop };
    },
    start: async () => {
      await port();
    },
    stop,
    connectionString,
  };
}

const hookedSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

/**
 * Imports embedded-postgres. Importing it installs async-exit-hook handlers
 * that stop every server and exit on SIGINT, SIGTERM, SIGHUP and SIGBREAK.
 * Where the process already handles one of those signals (the CLI does, to
 * roll back and drop throwaway databases first), the new handler is removed
 * again and the process's own handler stays in charge; the server is then
 * stopped by `close()` or, failing that, by the hook's `exit` handler.
 */
async function importDeferringSignals(): Promise<
  typeof import("embedded-postgres")
> {
  const before = new Map(
    hookedSignals.map((signal) => [signal, process.listeners(signal)]),
  );
  const module = await import("embedded-postgres");
  for (const [signal, existing] of before) {
    if (existing.length > 0) {
      for (const listener of process.listeners(signal)) {
        if (!existing.includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
  }
  return module;
}

/** The port of the server running on `dataDir`, if one is. */
async function runningPort(dataDir: string): Promise<number | undefined> {
  let lines: string[];
  try {
    lines = (await readFile(join(dataDir, "postmaster.pid"), "utf8")).split(
      /\r?\n/,
    );
  } catch {
    return undefined;
  }
  const pid = Number(lines[0]);
  const serverPort = Number(lines[3]);
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(serverPort) ||
    !isAlive(pid)
  ) {
    return undefined;
  }
  return serverPort;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("Could not find a free port"));
        }
      });
    });
  });
}
