// The CLI seam: spawns the built binary (dist/cli.js) as a child process with
// no terminal attached, the way CI runs it.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const cliPath = join(import.meta.dirname, "..", "..", "dist", "cli.js");

export interface SpawnCliOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Run in its own process group, so `signalGroup` reaches its children too (like Ctrl+C in a terminal). */
  detached?: boolean;
}

export interface RunningCli {
  readonly child: ChildProcess;
  /** Resolves when the process has exited and its output is closed. */
  readonly result: Promise<CliResult>;
  /**
   * Sends a signal to the CLI process only. On Windows every signal ends the
   * process outright, unhandled, so tests of what the CLI does on a signal
   * skip there.
   */
  signal(signal: NodeJS.Signals): void;
  /** Sends a signal to the CLI's whole process group (needs `detached`; not on Windows, which has no process groups). */
  signalGroup(signal: NodeJS.Signals): void;
}

export function spawnCli(
  args: readonly string[],
  options: SpawnCliOptions,
): RunningCli {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: options.cwd,
    env: { ...process.env, CI: "1", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: options.detached ?? false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const result = new Promise<CliResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
  return {
    child,
    result,
    signal: (signal) => child.kill(signal),
    signalGroup: (signal) => {
      if (child.pid !== undefined) {
        process.kill(-child.pid, signal);
      }
    },
  };
}

export function runCli(
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<CliResult> {
  return spawnCli(args, options).result;
}

/** Waits until `path` exists (e.g. a marker file a test config writes); 20 s by default, inside the test timeout. */
export async function waitForFile(
  path: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await delay(20);
  }
}
