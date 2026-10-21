#!/usr/bin/env node
import { isCI } from "./cli/environment.ts";
import { runCli } from "./cli/main.ts";
import { watchInterruptions } from "./cli/process.ts";

const interruptions = watchInterruptions();
const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive:
    process.stdin.isTTY === true && process.stdout.isTTY === true && !isCI(),
  signal: interruptions.signal,
  interruptions,
});

// Exit explicitly once output is flushed, rather than waiting for whatever
// handles a command left open (e.g. stdin after a prompt).
await Promise.all(
  [process.stdout, process.stderr].map(
    (stream) =>
      new Promise<void>((resolve) => {
        if (stream.destroyed) {
          resolve();
        } else {
          stream.write("", () => resolve());
        }
      }),
  ),
);
process.exit(interruptions.exitCode ?? code);
