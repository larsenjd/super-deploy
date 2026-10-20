#!/usr/bin/env node
import { runCli } from "./cli/main.ts";

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
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
