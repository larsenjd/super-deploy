// Running one command, shared by direct mode (main.ts) and the menu
// (menu.ts): load the project, get the option values, run, print any failure,
// close the project. Exit codes: 0 success; 1 failed or refused; 2 usage
// error (nothing ran). After an interruption the notice is the only message
// and the process watcher (process.ts) decides the exit code.
import { relative } from "node:path";
import { AdoptUnsupportedError } from "../commands/adopt.ts";
import { settleCleanups } from "../interruption.ts";
import type { Project } from "../project.ts";
import { RehearsalMismatchError } from "../rehearsal/same-structure.ts";
import {
  describeViolation,
  SqlRuleViolationError,
} from "../sql-analysis/index.ts";
import type {
  CommandContext,
  CommandDefinition,
  OptionValues,
} from "./definitions.ts";
import { UsageError } from "./parse.ts";
import { askAtTerminal, confirmAtTerminal } from "./prompts.ts";

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
 * `prepare` loads the project (unless the command needs none; see
 * `needsProject`) and resolves
 * the option values (`values` undefined: a question was cancelled and
 * nothing runs). If it throws, it
 * must close any project it loaded itself.
 */
export async function runCommand(
  io: CliIo,
  command: CommandDefinition,
  debug: boolean,
  prepare: () => Promise<{
    /** Undefined only for commands that need no project. */
    project: Project | undefined;
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
      const context = commandContext(io);
      if (project === undefined) {
        if (command.needsProject !== false) {
          throw new Error(`${command.name} needs a project`);
        }
        await command.run(io.cwd, prepared.values, context);
      } else if (command.needsProject === false) {
        if (command.projectMode === undefined) {
          throw new Error(`${command.name} runs without a project`);
        }
        await command.projectMode.run(project, prepared.values, context);
      } else {
        await command.run(project, prepared.values, context);
      }
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
    ask: io.interactive
      ? (question) => askAtTerminal(prompts, question)
      : undefined,
  };
}

/**
 * One `Error:` line; with `debug`, every stack trace and cause too. An error
 * listing several rule violations or rehearsal differences, or adoption's
 * refusal, prints each item on a line of its own first, and a summary that
 * names none of them as its `Error:` line.
 */
export function describeError(error: unknown, debug: boolean): string {
  const listing = listedDetails(error);
  const message =
    listing?.summary ??
    (error instanceof Error ? error.message : String(error));
  const lines = [
    ...(listing?.details ?? []),
    `Error: ${message.replace(/\s*\n\s*/g, " ")}`,
  ];
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

/**
 * The lines an error lists and the summary after them, when it lists more
 * than one (adoption's refusal: always, for the reasons).
 */
function listedDetails(
  error: unknown,
): { details: readonly string[]; summary: string } | undefined {
  if (error instanceof AdoptUnsupportedError) {
    return adoptionRefusal(error);
  }
  if (error instanceof SqlRuleViolationError && error.violations.length > 1) {
    return {
      details: error.violations.map(describeViolation),
      summary: `${error.violations.length} SQL rule violations (listed above)`,
    };
  }
  if (error instanceof RehearsalMismatchError && error.differences.length > 1) {
    return {
      details: error.differences,
      summary: `${error.subject} (${error.differences.length} differences, listed above)`,
    };
  }
  return undefined;
}

/**
 * Each object adoption refused with its rule and reason, then the objects
 * whose override reasons it will ask once nothing else is refused; the
 * summary keeps only the count and the advice.
 */
function adoptionRefusal({
  target,
  objects,
  overridesNeeded,
  advice,
}: AdoptUnsupportedError): { details: readonly string[]; summary: string } {
  const things = `${objects.length} thing${objects.length === 1 ? "" : "s"} V1 doesn't support`;
  const details = [
    `Target ${target} has ${things}:`,
    ...objects.flatMap(({ object, rule, reason }) => [
      `  ${object}`,
      `    ${rule}: ${reason}`,
    ]),
  ];
  if (overridesNeeded.length > 0) {
    const one = overridesNeeded.length === 1;
    details.push(
      `Once nothing else is refused, adoption will ask an override reason for ${overridesNeeded.length} object${one ? "" : "s"} that break${one ? "s" : ""} only risk rules: ${overridesNeeded.map((needed) => needed.object).join(", ")}`,
    );
  }
  return {
    details,
    summary: `Cannot adopt target ${target}: its managed schema has ${things}, listed above. Nothing was written; ${advice.join("; ")}`,
  };
}
