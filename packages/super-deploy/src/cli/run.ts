// Running one command, shared by direct mode (main.ts) and the menu
// (menu.ts): load the project, get the option values, run, print any failure,
// close the project. Exit codes: 0 success; 1 failed or refused; 2 usage
// error (nothing ran). After an interruption the notice is the only message
// and the process watcher (process.ts) decides the exit code.
import { relative } from "node:path";
import { settleCleanups } from "../interruption.ts";
import type { Project } from "../project.ts";
import type {
  CommandContext,
  CommandDefinition,
  OptionValues,
} from "./definitions.ts";
import { UsageError } from "./parse.ts";
import { confirmAtTerminal } from "./prompts.ts";

export interface CliIo {
  readonly cwd: string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** A terminal on stdin and stdout, outside CI: the menu and questions are allowed. */
  readonly interactive: boolean;
  /** Aborts when the process is interrupted. */
  readonly signal: AbortSignal;
}

export const exitCodes = { success: 0, failure: 1, usage: 2 } as const;

/**
 * `prepare` loads the project and resolves the option values (`values`
 * undefined: a question was cancelled and nothing runs). If it throws, it
 * must close any project it loaded itself.
 */
export async function runCommand(
  io: CliIo,
  command: CommandDefinition,
  debug: boolean,
  prepare: () => Promise<{
    project: Project;
    values: OptionValues | undefined;
  }>,
): Promise<number> {
  const report = (error: unknown): number => {
    if (io.signal.aborted) {
      return exitCodes.failure;
    }
    io.stderr.write(describeError(error, debug));
    return error instanceof UsageError ? exitCodes.usage : exitCodes.failure;
  };
  let project: Project | undefined;
  let code: number = exitCodes.success;
  try {
    const prepared = await prepare();
    project = prepared.project;
    if (prepared.values !== undefined) {
      await command.run(project, prepared.values, commandContext(io));
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
  const prompts = { input: io.stdin, output: io.stdout, signal: io.signal };
  return {
    result: (line) => io.stdout.write(`${line}\n`),
    warn: (line) => io.stderr.write(`${line}\n`),
    displayPath: (path) => relative(io.cwd, path).split("\\").join("/") || ".",
    confirm: io.interactive
      ? (question) => confirmAtTerminal(prompts, question)
      : undefined,
  };
}

/** One `Error:` line; with `debug`, every stack trace and cause too. */
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
