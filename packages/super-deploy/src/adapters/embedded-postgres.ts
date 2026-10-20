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
import { AdapterError } from "../errors.ts";
import { connectSession, rehearsalOver, targetOver } from "./node-postgres.ts";
import type { DeploymentAdapter, RehearsalAdapter } from "./types.ts";

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
    const { default: EmbeddedPostgresClass } = await import(
      "embedded-postgres"
    );
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
    await server?.stop();
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
