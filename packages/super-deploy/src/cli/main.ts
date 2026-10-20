// The CLI shell: parse argv, then show help, open the menu (no arguments at a
// terminal) or run one command from its flags.
import { loadProject, type Project } from "../project.ts";
import { toolVersion } from "../version.ts";
import { commands, type OptionValues } from "./definitions.ts";
import { commandHelp, usage } from "./help.ts";
import { runMenu } from "./menu.ts";
import { type Invocation, parseInvocation, UsageError } from "./parse.ts";
import { type CliIo, exitCodes, runCommand } from "./run.ts";

export type { CliIo } from "./run.ts";

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
      if (io.interactive) {
        return runMenu(io, invocation.debug);
      }
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
      const { command, values } = invocation;
      return runCommand(io, command, invocation.debug, async () => {
        const project = await loadProject({ cwd: io.cwd, signal: io.signal });
        try {
          checkTargets(project, command.options, values);
        } catch (error) {
          await project.close().catch(() => {});
          throw error;
        }
        return { project, values };
      });
    }
  }
}

/** Target names can only be checked once the config is loaded; unknown ones are usage errors. */
function checkTargets(
  project: Project,
  options: (typeof commands)[number]["options"],
  values: OptionValues,
): void {
  for (const option of options) {
    const value = values[option.name];
    if (
      option.kind === "target" &&
      typeof value === "string" &&
      !Object.hasOwn(project.config.targets, value)
    ) {
      const known = Object.keys(project.config.targets);
      throw new UsageError(
        `Unknown target "${value}" for --${option.name}; super-deploy.config.ts has ${known.length === 0 ? "no targets" : known.join(", ")}`,
      );
    }
  }
}
