// The CLI shell: parse argv, load the project, run the command, map the
// outcome to an exit code. Exit codes: 0 success; 1 failed or refused;
// 2 usage error (nothing ran). Interruptions (130, 141, 143) are decided by
// the process watcher (process.ts); after one, runCli returns as soon as
// cleanup is done and its own code is ignored.
import { relative } from "node:path";
import { settleCleanups } from "../interruption.ts";
import { loadProject, type Project } from "../project.ts";
import { toolVersion } from "../version.ts";
import {
  type CommandContext,
  type CommandDefinition,
  commands,
  type OptionValues,
} from "./definitions.ts";
import { commandHelp, usage } from "./help.ts";
import { type Invocation, parseInvocation, UsageError } from "./parse.ts";

export interface CliIo {
  readonly cwd: string;
  readonly stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly stdout: NodeJS.WritableStream & { isTTY?: boolean };
  readonly stderr: NodeJS.WritableStream;
  /** A terminal on stdin and stdout, outside CI: the menu and questions are allowed. */
  readonly interactive: boolean;
  /** Aborts when the process is interrupted. */
  readonly signal: AbortSignal;
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
    case "run":
      return runCommand(io, invocation.command, invocation.debug, async () => {
        const project = await loadProject({ cwd: io.cwd, signal: io.signal });
        return { project, values: invocation.values };
      });
  }
}

/**
 * Loads the project, gets the option values (`prepare` may ask for them, or
 * return undefined when a question was cancelled: nothing runs), runs the
 * command and prints any failure. Returns the exit code.
 */
export async function runCommand(
  io: CliIo,
  command: CommandDefinition,
  debug: boolean,
  prepare: () => Promise<
    { project: Project; values: OptionValues | undefined } | undefined
  >,
): Promise<number> {
  const report = (error: unknown): number => {
    if (io.signal.aborted) {
      // The interruption notice is the only message.
      return exitCodes.failure;
    }
    io.stderr.write(describeError(error, debug));
    return error instanceof UsageError ? exitCodes.usage : exitCodes.failure;
  };
  let project: Project | undefined;
  let code: number = exitCodes.success;
  try {
    const prepared = await prepare();
    project = prepared?.project;
    if (prepared?.values !== undefined) {
      await command.run(prepared.project, prepared.values, commandContext(io));
    }
  } catch (error) {
    code = report(error);
  }
  await settleCleanups(io.signal);
  try {
    await project?.close();
  } catch (error) {
    if (code === exitCodes.success) {
      code = report(error);
    }
  }
  return code;
}

function commandContext(io: CliIo): CommandContext {
  return {
    result: (line) => io.stdout.write(`${line}\n`),
    warn: (line) => io.stderr.write(`${line}\n`),
    displayPath: (path) => relative(io.cwd, path).split("\\").join("/") || ".",
  };
}

export function describeError(error: unknown, debug: boolean): string {
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
