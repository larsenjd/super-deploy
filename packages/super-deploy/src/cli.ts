#!/usr/bin/env node
import { inCI, terminalConfirm } from "./cli/confirm.ts";
import { runCli } from "./cli/main.ts";

const interactive =
  process.stdin.isTTY === true && process.stdout.isTTY === true && !inCI();
const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  confirm: interactive
    ? terminalConfirm(process.stdin, process.stderr)
    : undefined,
});

// Exit explicitly once output is flushed: embedded-postgres installs an
// async-exit-hook whose `beforeExit` handler would otherwise exit with 0.
await Promise.all(
  [process.stdout, process.stderr].map(
    (stream) =>
      new Promise<void>((resolve) => stream.write("", () => resolve())),
  ),
);
process.exit(exitCode);
