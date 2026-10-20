// The CLI shell: parse argv, load the project, run the command, map the
// outcome to an exit code. Exit codes: 0 success; 1 failed or refused;
// 2 usage error (nothing ran). Ticket 05 adds the menu, signals (130/143)
// and closed output (141).
import { relative } from "node:path";
import { loadProject, type Project } from "../project.ts";
import type { Question } from "../questions.ts";
import { toolVersion } from "../version.ts";
import { commands } from "./definitions.ts";
import { commandHelp, usage } from "./help.ts";
import { type Invocation, parseInvocation, UsageError } from "./parse.ts";

export interface CliIo {
  readonly cwd: string;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  /** Asks a yes/no question at the terminal; absent without one (or in CI). */
  readonly confirm?: ((question: Question) => Promise<boolean>) | undefined;
}

export const exitCodes = { success: 0, failure: 1, usage: 2 } as const;

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let invocation: Invocation;
  try {
    invocation = parseInvocation(argv, commands);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`Error: ${error.message}\n`);
      return exitCodes.usage;
    }
    throw error;
  }

  switch (invocation.kind) {
    case "no-command":
      io.stderr.write(usage(commands));
      return exitCodes.usage;
    case "help":
      io.stdout.write(
        invocation.command ? commandHelp(invocation.command) : usage(commands),
      );
      return exitCodes.success;
    case "version":
      io.stdout.write(`super-deploy ${toolVersion}\n`);
      return exitCodes.success;
    case "run": {
      let project: Project | undefined;
      try {
        project = await loadProject({ cwd: io.cwd });
        await invocation.command.run(project, invocation.values, {
          result: (line) => io.stdout.write(`${line}\n`),
          warn: (line) => io.stderr.write(`${line}\n`),
          displayPath: (path) =>
            relative(io.cwd, path).split("\\").join("/") || ".",
          confirm: io.confirm,
        });
        await project.close();
        return exitCodes.success;
      } catch (error) {
        await project?.close().catch(() => {});
        io.stderr.write(describeError(error, invocation.debug));
        return exitCodes.failure;
      }
    }
  }
}

function describeError(error: unknown, debug: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = [`Error: ${message.replace(/\s*\n\s*/g, " ")}`];
  if (debug) {
    for (let cause: unknown = error; cause !== undefined; ) {
      lines.push(
        cause instanceof Error ? (cause.stack ?? String(cause)) : String(cause),
      );
      cause = cause instanceof Error ? cause.cause : undefined;
      if (cause !== undefined) {
        lines.push("Caused by:");
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
