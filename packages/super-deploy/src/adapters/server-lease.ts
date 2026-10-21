// The lease on an embedded PostgreSQL server (ticket 14): every client of a
// data directory, an `embeddedPostgres` instance that started or attached to
// its server, registers a file in `<dataDir>/super-deploy-clients`, and the
// client whose release leaves no live one stops the server. So commands run
// at the same time share the server, and none stops it under another.
//
// A client file holds its process's pid; it is live while that pid is
// (`process.kill(pid, 0)`, which Node also offers on Windows). Node can't
// read another process's start time without a platform-specific lookup, so
// a pid the system has reused for an unrelated process keeps a dead client
// counted live until that process exits too: meanwhile the server outlives
// its last real client and leftover throwaway databases stay. Rare (a command
// killed outright, then its pid reused), and harmless to data; the next
// client to register after the reusing process exits takes the server over.
// One process may hold several clients (a test harness and the projects it
// runs), so a file is per client, not per process. A file whose process is
// gone (a command killed outright) is dead: it is deleted by the next
// registration or release, and a client that registers next to only dead ones
// has taken the server over (`others` is 0), so it sweeps leftover throwaway
// databases and stops the server when it releases, like any last client.
//
// Registering, releasing, and the start or stop that goes with them run under
// a lock file, `<dataDir>/super-deploy.lock` (created exclusively, holding the
// holder's pid), so a client never attaches to a server another is stopping.
// A lock whose holder is dead is taken over. Two waiters that both find the
// same dead holder could both take over; that needs a command killed while
// starting or stopping the server, and is left at that.
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AdapterError } from "./types.ts";

const clientsDirectory = "super-deploy-clients";
const lockFileName = "super-deploy.lock";
// Longer than a start (pg_ctl's 60 s) plus the wait for connections.
const lockWaitMs = 120_000;

/** One client's registration on a data directory. */
export interface Registration {
  readonly file: string;
  /** Live clients other than this one when it registered. */
  readonly others: number;
}

/**
 * Runs `body` holding the data directory's lock, waiting while another client
 * (in this process or another) holds it.
 */
export async function withLeaseLock<T>(
  dataDir: string,
  body: () => Promise<T>,
): Promise<T> {
  const path = join(dataDir, lockFileName);
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    if (await isStaleLock(path)) {
      await rm(path, { force: true });
    } else if (Date.now() > deadline) {
      throw new AdapterError(
        `Timed out waiting for another command to start or stop the embedded PostgreSQL server in ${dataDir}. If no other command is running, delete ${path}`,
      );
    } else {
      await delay(50);
    }
  }
  try {
    return await body();
  } finally {
    await rm(path, { force: true });
  }
}

/** Registers a new client of the data directory. Call under the lock. */
export async function register(dataDir: string): Promise<Registration> {
  const others = await liveClients(dataDir);
  const file = join(
    dataDir,
    clientsDirectory,
    `${process.pid}-${randomUUID()}.json`,
  );
  await writeFile(file, `${JSON.stringify({ pid: process.pid })}\n`);
  return { file, others: others.length };
}

/**
 * Removes a client's registration and answers how many live clients remain.
 * Call under the lock.
 */
export async function release(
  dataDir: string,
  registration: Registration,
): Promise<number> {
  await rm(registration.file, { force: true });
  return (await liveClients(dataDir)).length;
}

/** Whether process `pid` exists (EPERM: it does, as another user's). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The live clients' files, deleting dead and unreadable ones. */
async function liveClients(dataDir: string): Promise<string[]> {
  const directory = join(dataDir, clientsDirectory);
  await mkdir(directory, { recursive: true });
  const live: string[] = [];
  for (const name of await readdir(directory)) {
    const file = join(directory, name);
    const pid = await clientPid(file);
    if (pid !== undefined && isAlive(pid)) {
      live.push(file);
    } else {
      await rm(file, { force: true });
    }
  }
  return live;
}

async function clientPid(file: string): Promise<number | undefined> {
  try {
    const { pid } = JSON.parse(await readFile(file, "utf8")) as {
      pid?: unknown;
    };
    return Number.isInteger(pid) ? (pid as number) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the lock's holder is gone. A lock without a pid yet is being
 * written, unless it is old: its holder died between creating and writing it.
 */
async function isStaleLock(path: string): Promise<boolean> {
  try {
    const pid = Number((await readFile(path, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      return !isAlive(pid);
    }
    return Date.now() - (await stat(path)).mtimeMs > 10_000;
  } catch {
    // Released meanwhile: try again.
    return false;
  }
}
