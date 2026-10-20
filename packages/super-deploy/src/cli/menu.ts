// The interactive menu: `super-deploy` with no arguments at a terminal.
// Pick a command, answer its options, see it run, and land back on the same
// command. Failures print and return to the menu; cancelling a question runs
// nothing; quit, Escape or Ctrl+C at the menu leaves (exit 0). An
// interruption while a command runs cleans up and exits like any other.
import { cancel, intro, outro } from "@clack/prompts";
import { loadProject } from "../project.ts";
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
    const command = await pickCommand(prompts, commands, current);
    if (io.signal.aborted) {
      return exitCodes.failure;
    }
    if (command === undefined) {
      outro("Bye", output);
      return exitCodes.success;
    }
    current = command;
    await runCommand(io, command, debug, async () => {
      const project = await loadProject({
        cwd: io.cwd,
        signal: io.signal,
        reload: true,
      });
      try {
        const values = await askOptions(prompts, command, project);
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
