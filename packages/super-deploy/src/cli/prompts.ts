// Terminal questions with @clack/prompts: the menu's command list, one
// question per option kind, and yes/no confirmations (default no). Every
// prompt is cancelled by Escape or Ctrl+C (clack reads them in raw mode) and
// by the interruption signal.
import { styleText } from "node:util";
import { SelectPrompt, TextPrompt } from "@clack/core";
import {
  autocomplete,
  confirm as clackConfirm,
  isCancel,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  select,
  symbol,
  unicodeOr,
} from "@clack/prompts";
import { InvalidDraftNameError } from "../errors.ts";
import type { Project } from "../project.ts";
import { normaliseDraftName } from "../store/draft-name.ts";
import {
  type CommandDefinition,
  commandGroups,
  type NameOption,
  type OptionDefinition,
  type OptionValues,
  RefusedError,
} from "./definitions.ts";

export interface PromptIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly signal: AbortSignal;
}

// clack types its streams as node:stream's Readable/Writable.
function streams(io: PromptIo) {
  return {
    input: io.input as import("node:stream").Readable,
    output: io.output as import("node:stream").Writable,
    signal: io.signal,
  };
}

export const quit = "quit";

const arrow = unicodeOr("\u2192", "->");

interface MenuEntry {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * The menu: commands grouped by section, then `quit`. Resolves to the chosen
 * command, or `undefined` for quit, Escape, Ctrl+C or an interruption.
 */
export async function pickCommand(
  io: PromptIo,
  commands: readonly CommandDefinition[],
  current: CommandDefinition | undefined,
): Promise<CommandDefinition | undefined> {
  const entries: MenuEntry[] = [];
  for (const group of commandGroups) {
    const inGroup = commands.filter((command) => command.group === group);
    if (inGroup.length > 0) {
      entries.push({ value: `#${group}`, label: group, disabled: true });
      for (const command of inGroup) {
        entries.push({
          value: command.name,
          label: command.name,
          hint: command.summary,
        });
      }
    }
  }
  entries.push({ value: quit, label: quit, hint: "Leave the menu" });
  const width = Math.max(...entries.map((entry) => entry.label.length)) + 2;
  const message = "What do you want to do?";

  const answer = await new SelectPrompt<MenuEntry>({
    ...streams(io),
    options: entries,
    initialValue: current?.name ?? commands[0]?.name ?? quit,
    render() {
      const title = `${styleText("gray", S_BAR)}\n${symbol(this.state)}  ${message}\n`;
      const chosen = this.options[this.cursor];
      if (this.state === "submit" || this.state === "cancel") {
        const label = chosen?.label ?? "";
        return `${title}${styleText("gray", S_BAR)}  ${styleText(this.state === "cancel" ? ["strikethrough", "dim"] : "dim", label)}`;
      }
      const bar = styleText("cyan", S_BAR);
      const lines = this.options.map((entry, index) => {
        if (entry.disabled) {
          return `${bar}  ${styleText("bold", entry.label)}`;
        }
        const active = index === this.cursor;
        const radio = active
          ? styleText("green", S_RADIO_ACTIVE)
          : styleText("dim", S_RADIO_INACTIVE);
        const label = entry.label.padEnd(width);
        const hint = styleText("dim", entry.hint ?? "");
        return `${bar}    ${radio} ${active ? label : styleText("dim", label)}${hint}`;
      });
      const footer = styleText(
        "dim",
        "Up/Down to move, Enter to run, Escape to leave",
      );
      return `${title}${lines.join("\n")}\n${bar}\n${styleText("cyan", S_BAR_END)}  ${footer}\n`;
    },
  }).prompt();
  if (isCancel(answer) || answer === undefined || answer === quit) {
    return undefined;
  }
  return commands.find((command) => command.name === answer);
}

/**
 * Asks for each of the command's options in order. Resolves to the values,
 * or `undefined` if a question was cancelled (nothing should run). `project`
 * is undefined for commands that need none (their options never use it).
 */
export async function askOptions(
  io: PromptIo,
  command: CommandDefinition,
  project: Project | undefined,
): Promise<OptionValues | undefined> {
  const values: Record<string, string | boolean> = {};
  for (const option of command.options) {
    const answer = await askOption(io, option, project);
    if (answer === cancelled) {
      return undefined;
    }
    if (answer !== undefined) {
      values[option.name] = answer;
    }
  }
  return values;
}

const cancelled = Symbol("cancelled");

async function askOption(
  io: PromptIo,
  option: OptionDefinition,
  project: Project | undefined,
): Promise<string | boolean | undefined | typeof cancelled> {
  const message = option.description;
  switch (option.kind) {
    case "target": {
      const names = Object.keys(needed(project, option).config.targets);
      if (names.length === 0) {
        throw new RefusedError("super-deploy.config.ts has no targets");
      }
      return answered(
        await select({
          ...streams(io),
          message,
          options: names.map((name) => ({ value: name, label: name })),
        }),
      );
    }
    case "migration": {
      const migrations = [
        ...(await option.migrations(needed(project, option))),
      ].sort((a, b) => b.number - a.number);
      if (migrations.length === 0) {
        throw new RefusedError("There are no migrations to choose from");
      }
      return answered(
        await autocomplete({
          ...streams(io),
          message,
          placeholder: "Type to search",
          maxItems: 10,
          options: migrations.map((migration) => ({
            value: String(migration.number),
            label: `${String(migration.number).padStart(5, "0")}-${migration.name}`,
          })),
        }),
      );
    }
    case "choice":
      return answered(
        await select({
          ...streams(io),
          message,
          options: option.choices.map((choice) => ({
            value: choice,
            label: choice,
          })),
        }),
      );
    case "name":
      return askName(io, option, project);
    case "flag": {
      if (option.acknowledgement) {
        // Never set by the menu: the command asks when it matters.
        return undefined;
      }
      const answer = answered(
        await clackConfirm({ ...streams(io), message, initialValue: false }),
      );
      return answer === cancelled ? cancelled : answer ? true : undefined;
    }
  }
}

/** Options of commands without a project must not need one (see DirectoryCommandDefinition). */
function needed(
  project: Project | undefined,
  option: OptionDefinition,
): Project {
  if (project === undefined) {
    throw new Error(`Option --${option.name} needs a project`);
  }
  return project;
}

function answered<T>(answer: T): Exclude<T, symbol> | typeof cancelled {
  return isCancel(answer) ? cancelled : (answer as Exclude<T, symbol>);
}

/** A name, previewing the normalised result as it is typed. */
async function askName(
  io: PromptIo,
  option: NameOption,
  project: Project | undefined,
): Promise<string | undefined | typeof cancelled> {
  const initial =
    (option.initial === undefined
      ? undefined
      : await option.initial(needed(project, option))) ?? "";
  const preview = (input: string): string => {
    if (input.trim() === "") {
      return styleText(
        "dim",
        option.required ? "(required)" : "(leave empty to skip)",
      );
    }
    try {
      return styleText("dim", `${arrow} ${normaliseDraftName(input)}`);
    } catch (error) {
      if (error instanceof InvalidDraftNameError) {
        return styleText(
          "yellow",
          `${arrow} ${error.normalised} (not allowed)`,
        );
      }
      throw error;
    }
  };
  const answer = await new TextPrompt({
    ...streams(io),
    initialValue: initial,
    validate(value) {
      const input = value ?? "";
      if (input.trim() === "") {
        return option.required ? "A name is required" : undefined;
      }
      try {
        normaliseDraftName(input);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    render() {
      const title = `${styleText("gray", S_BAR)}\n${symbol(this.state)}  ${option.description}\n`;
      const input = this.userInput;
      switch (this.state) {
        case "submit":
          return `${title}${styleText("gray", S_BAR)}  ${styleText("dim", input.trim() === "" ? "(none)" : normaliseDraftName(input))}`;
        case "cancel":
          return `${title}${styleText("gray", S_BAR)}  ${styleText(["strikethrough", "dim"], input)}`;
        case "error":
          return `${title}${styleText("yellow", S_BAR)}  ${this.userInputWithCursor}\n${styleText("yellow", S_BAR_END)}  ${styleText("yellow", this.error)}\n`;
        default:
          return `${title}${styleText("cyan", S_BAR)}  ${this.userInputWithCursor}\n${styleText("cyan", S_BAR_END)}  ${preview(input)}\n`;
      }
    },
  }).prompt();
  if (isCancel(answer)) {
    return cancelled;
  }
  const input = answer ?? "";
  return input.trim() === "" ? undefined : input;
}

/** A yes/no question, default no. Cancelling (or an interruption) answers no. */
export async function confirmAtTerminal(
  io: PromptIo,
  question: string,
): Promise<boolean> {
  const answer = await clackConfirm({
    ...streams(io),
    message: question,
    initialValue: false,
  });
  return answer === true;
}
