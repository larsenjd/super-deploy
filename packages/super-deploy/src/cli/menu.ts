// The interactive menu: `super-deploy` with no arguments at a terminal.
// Pick a command, answer its options, see it run, and land back on the same
// command. Failures print and return to the menu; cancelling a question runs
// nothing; quit, Escape, Ctrl+C or Ctrl+D at the menu leaves (exit 0). An
// interruption while a command runs cleans up and exits like any other.
import { cancel, intro, outro } from "@clack/prompts";
import { findConfig, loadProject } from "../project.ts";
import { toolVersion } from "../version.ts";
import { type CommandDefinition, commands } from "./definitions.ts";
import { askOptions, type PromptIo, pickCommand } from "./prompts.ts";
import { type CliIo, exitCodes, runCommand } from "./run.ts";

export async function runMenu(io: CliIo, debug: boolean): Promise<number> {
  const prompts: PromptIo = {
    input: io.stdin,
    output: io.stdout,
    signal: io.signal,
  };
  const output = { output: prompts.output as import("node:stream").Writable };
  intro(`super-deploy ${toolVersion}`, output);
  let current: CommandDefinition | undefined;
  for (;;) {
    const command = await pickCommand(
      prompts,
      commands,
      current ?? startingCommand(io.cwd),
    );
    if (io.signal.aborted) {
      return exitCodes.failure;
    }
    if (command === undefined) {
      outro("Bye", output);
      return exitCodes.success;
    }
    current = command;
    await runCommand(io, command, debug, async () => {
      const projectMode =
        command.needsProject === false ? command.projectMode : undefined;
      const inProject = findConfig(io.cwd) !== undefined;
      if (command.needsProject === false && !(projectMode && inProject)) {
        // Outside a project, the option that needs one isn't asked.
        const values = await askOptions(
          prompts,
          {
            ...command,
            options: command.options.filter(
              (option) => option.name !== projectMode?.option,
            ),
          },
          undefined,
        );
        if (values === undefined && !io.signal.aborted) {
          cancel("Cancelled: nothing ran", output);
        }
        return { project: undefined, values };
      }
      const project = await loadProject({
        cwd: io.cwd,
        signal: io.signal,
        reload: true,
      });
      try {
        // Inside a project, a directory command runs in its project mode,
        // so that mode's option is required.
        const values = await askOptions(
          prompts,
          {
            ...command,
            options: command.options.map((option) =>
              option.name === projectMode?.option
                ? { ...option, required: true }
                : option,
            ),
          },
          project,
        );
        if (values === undefined && !io.signal.aborted) {
          cancel("Cancelled: nothing ran", output);
        }
        return { project, values };
      } catch (error) {
        await project.close().catch(() => {});
        throw error;
      }
    });
    if (io.signal.aborted) {
      return exitCodes.failure;
    }
  }
}

/**
 * Where the cursor starts: on the first command that needs no project
 * (init) when there is none, otherwise on the first one that does (draft).
 */
function startingCommand(cwd: string): CommandDefinition | undefined {
  const inProject = findConfig(cwd) !== undefined;
  return commands.find(
    (command) => (command.needsProject !== false) === inProject,
  );
}
