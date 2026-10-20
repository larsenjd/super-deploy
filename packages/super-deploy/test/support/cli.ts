// The CLI seam: spawns the built binary (dist/cli.js) as a child process with
// no terminal attached, the way CI runs it.
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const cliPath = join(import.meta.dirname, "..", "..", "dist", "cli.js");

export function runCli(
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, CI: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
