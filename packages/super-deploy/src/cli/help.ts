import { toolVersion } from "../version.ts";
import { type CommandDefinition, commandGroups } from "./definitions.ts";
import { optionsOf } from "./parse.ts";

export function usage(commands: readonly CommandDefinition[]): string {
  const width = Math.max(...commands.map((command) => command.name.length)) + 2;
  const lines = [
    `super-deploy ${toolVersion}`,
    "",
    "Usage: super-deploy <command> [options]",
    "",
  ];
  for (const group of commandGroups) {
    const inGroup = commands.filter((command) => command.group === group);
    if (inGroup.length > 0) {
      lines.push(`${group}:`);
      for (const command of inGroup) {
        lines.push(`  ${command.name.padEnd(width)}${command.summary}`);
      }
      lines.push("");
    }
  }
  lines.push(
    "Options:",
    "  --help     Show this help",
    "  --version  Show the version",
    "",
    'Run "super-deploy <command> --help" for a command\'s options.',
  );
  return `${lines.join("\n")}\n`;
}

export function commandHelp(command: CommandDefinition): string {
  const options = optionsOf(command).map((option) => ({
    label:
      option.kind === "flag"
        ? `--${option.name}`
        : `--${option.name} <${option.kind}>`,
    description: option.required
      ? `${option.description} (required)`
      : option.description,
  }));
  const width = Math.max(...options.map((option) => option.label.length)) + 2;
  const lines = [
    `Usage: super-deploy ${command.name} [options]`,
    "",
    `${command.summary}.`,
    "",
    "Options:",
    ...options.map(
      (option) => `  ${option.label.padEnd(width)}${option.description}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
