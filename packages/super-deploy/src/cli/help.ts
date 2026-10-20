import { toolVersion } from "../version.ts";
import {
  type CommandDefinition,
  commandGroups,
  type OptionDefinition,
} from "./definitions.ts";
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
    "  --debug    With no command: open the menu, showing stack traces on errors",
    "",
    'Run "super-deploy <command> --help" for a command\'s options.',
    "Run super-deploy with no arguments in a terminal for an interactive menu.",
  );
  return `${lines.join("\n")}\n`;
}

export function commandHelp(command: CommandDefinition): string {
  const options = optionsOf(command).map((option) => ({
    label: `--${option.name}${placeholder(option)}`,
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

function placeholder(option: OptionDefinition): string {
  switch (option.kind) {
    case "flag":
      return "";
    case "choice":
      return ` <${option.choices.join("|")}>`;
    case "migration":
      return " <number>";
    case "target":
    case "name":
      return ` <${option.kind}>`;
  }
}
