// The embedded PostgreSQL server process: initialising a data directory,
// starting and stopping its server, and waiting until it accepts
// connections. `embedded-postgres.ts` decides when, under the lease
// (`server-lease.ts`).
//
// The binaries come from the platform package of the optional peer
// dependency `embedded-postgres` (e.g. `@embedded-postgres/linux-x64`); the
// library's own start and stop are not used. Its server is a child of the
// process that started it, which its exit hooks stop when that process ends
// and which Ctrl+C reaches with the rest of the process group, so it could not
// outlive its starter for other commands. `pg_ctl` starts the server in a
// session of its own instead (a detached child), and stops it wherever it was
// started; both work on Windows too.
//
// A new data directory is initialised in a sibling folder and renamed into
// place, so two commands initialising at once both end with the same
// complete directory. A folder that has files but no PG_VERSION (damaged, or
// half deleted) is refused instead, before initdb runs, and left as it is.
//
// A server is taken to be running while its `postmaster.pid` names a live
// process. After a reboot or crash that pid may belong to an unrelated
// process: when the file says the server is `ready` and nothing answers on
// its port, the wait for connections fails at once naming the file, and the
// caller must not `stopServer` (pg_ctl would signal that process). The server's output goes to `super-deploy-server.log`
// in the data directory, emptied at each start; a failed start reports its
// last lines.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { localHost } from "./ports.ts";
import { isAlive } from "./server-lease.ts";
import { AdapterError } from "./types.ts";

const logFileName = "super-deploy-server.log";
// How long a client waits for a server that reports it is starting up
// (SQLSTATE 57P03), e.g. one started by a command that was killed meanwhile.
const startingUpWaitMs = 30_000;

interface Binaries {
  readonly initdb: string;
  readonly pg_ctl: string;
}

let binaries: Promise<Binaries> | undefined;

function postgresBinaries(): Promise<Binaries> {
  binaries ??= (async () => {
    const platform =
      process.platform === "win32" ? "windows" : process.platform;
    const name = `@embedded-postgres/${platform}-${process.arch}`;
    let entry: string;
    try {
      const library = createRequire(import.meta.url).resolve(
        "embedded-postgres",
      );
      entry = createRequire(library).resolve(name);
    } catch (error) {
      throw new AdapterError(
        `Embedded PostgreSQL needs the packages embedded-postgres and ${name}: add embedded-postgres to the project's devDependencies`,
        { cause: error },
      );
    }
    return (await import(pathToFileURL(entry).href)) as Binaries;
  })().catch((error: unknown) => {
    binaries = undefined;
    throw error;
  });
  return binaries;
}

/**
 * Initialises `dataDir` with superuser `user` unless it is initialised
 * already. A folder with files but no PG_VERSION is refused with `wayOut`,
 * what to do about it.
 */
export async function initialise(
  dataDir: string,
  user: string,
  password: string,
  wayOut: string,
): Promise<void> {
  if (existsSync(join(dataDir, "PG_VERSION"))) {
    return;
  }
  if ((await readdir(dataDir).catch(() => [])).length > 0) {
    throw new AdapterError(
      `${dataDir} is not a complete PostgreSQL data folder (it has no PG_VERSION): ${wayOut}`,
    );
  }
  const { initdb } = await postgresBinaries();
  await mkdir(dirname(dataDir), { recursive: true });
  const staging = `${dataDir}.initdb-${randomUUID()}`;
  const passwordFile = join(tmpdir(), `super-deploy-password-${randomUUID()}`);
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  try {
    const result = await run(initdb, [
      `--pgdata=${staging}`,
      "--auth=password",
      `--username=${user}`,
      `--pwfile=${passwordFile}`,
      "--encoding=UTF8",
      "--locale=C",
      "--no-sync",
    ]);
    if (result.code !== 0) {
      throw new AdapterError(
        `Embedded PostgreSQL failed to initialise ${dataDir}: ${lastLines(result.output)}`,
      );
    }
    // An empty folder in its place (made by hand) is replaced.
    await rmdir(dataDir).catch(() => {});
    await rename(staging, dataDir).catch((error: unknown) => {
      // Another command initialised it meanwhile.
      if (!existsSync(join(dataDir, "PG_VERSION"))) {
        throw new AdapterError(
          `Embedded PostgreSQL failed to initialise ${dataDir}`,
          { cause: error },
        );
      }
    });
  } finally {
    await rm(passwordFile, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Starts the server on `port` of 127.0.0.1, in a session of its own, and
 * resolves once it is up. Rejects with the server's last log lines.
 */
export async function startServer(
  dataDir: string,
  port: number,
): Promise<void> {
  const { pg_ctl } = await postgresBinaries();
  const log = join(dataDir, logFileName);
  await writeFile(log, "");
  const result = await run(
    pg_ctl,
    [
      "start",
      "-D",
      dataDir,
      "-w",
      "-t",
      "60",
      "-l",
      log,
      "-o",
      `-p ${port} -c listen_addresses=${localHost} -c unix_socket_directories=`,
    ],
    { detached: true },
  );
  if (result.code !== 0) {
    const serverLog = await readFile(log, "utf8").catch(() => "");
    throw new AdapterError(
      `Embedded PostgreSQL failed to start in ${dataDir}: ${lastLines(serverLog || result.output)}`,
    );
  }
}

/**
 * Stops the data directory's server, if it is running, and waits until it
 * has. `pg_ctl` runs in a session of its own, so a signal to the terminal's
 * group (closing it, a wrapper forwarding SIGTERM) can't cut the stop short.
 */
export async function stopServer(dataDir: string): Promise<void> {
  const { pg_ctl } = await postgresBinaries();
  const result = await run(
    pg_ctl,
    ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "60"],
    { detached: true },
  );
  if (result.code !== 0 && (await runningPort(dataDir)) !== undefined) {
    throw new AdapterError(
      `Embedded PostgreSQL failed to stop in ${dataDir}: ${lastLines(result.output)}`,
    );
  }
}

/**
 * Waits until the server at `connectionString` accepts connections: while it
 * reports that it is starting up (57P03), or refuses the connection before it
 * listens, for at most 30 s. A refusal while `postmaster.pid` says `ready`
 * means the file is stale: that fails at once.
 */
export async function waitUntilAccepting(
  connectionString: string,
  dataDir: string,
): Promise<void> {
  const deadline = Date.now() + startingUpWaitMs;
  for (;;) {
    const client = new pg.Client({ connectionString });
    client.on("error", () => {});
    try {
      await client.connect();
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === "57P03" || code === "ECONNREFUSED";
      const recorded =
        code === "ECONNREFUSED" ? await readPidFile(dataDir) : undefined;
      if (
        recorded !== undefined &&
        (recorded.status === "ready" || Date.now() > deadline)
      ) {
        throw new AdapterError(
          `${recorded.path} names process ${recorded.pid} and port ${recorded.port}, but no server answers there: if no super-deploy command is running, delete that file and try again`,
          { cause: error },
        );
      }
      if (!transient || Date.now() > deadline) {
        throw new AdapterError(
          `Embedded PostgreSQL in ${dataDir} does not accept connections: ${(error as Error).message}`,
          { cause: error },
        );
      }
    } finally {
      await client.end().catch(() => {});
    }
    await delay(100);
  }
}

/** The port of the server running on `dataDir`, if one is. */
export async function runningPort(
  dataDir: string,
): Promise<number | undefined> {
  const recorded = await readPidFile(dataDir);
  return recorded !== undefined && isAlive(recorded.pid)
    ? recorded.port
    : undefined;
}

/**
 * What `postmaster.pid` records: the postmaster's pid, its port, and its
 * status line (`starting`, `ready`, `standby`, `stopping`), if the file is
 * there and readable.
 */
async function readPidFile(
  dataDir: string,
): Promise<
  { path: string; pid: number; port: number; status: string } | undefined
> {
  const path = join(dataDir, "postmaster.pid");
  let lines: string[];
  try {
    lines = (await readFile(path, "utf8")).split(/\r?\n/);
  } catch {
    return undefined;
  }
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  if (!Number.isInteger(pid) || !Number.isInteger(port)) {
    return undefined;
  }
  return { path, pid, port, status: lines[7]?.trim() ?? "" };
}

function lastLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-20)
    .join(" | ");
}

/** Runs a binary to completion, collecting its output. */
function run(
  command: string,
  args: readonly string[],
  options: { detached?: boolean } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.detached ?? false,
      windowsHide: true,
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, output }));
  });
}
