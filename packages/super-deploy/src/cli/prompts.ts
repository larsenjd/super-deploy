// Terminal questions with @clack/prompts: the menu (sections, then a
// section's commands, in one prompt that redraws in place), one
// question per option kind (worded by the option's `question`, else its
// `--help` description; a choice may work out its question and preselection
// from the answers so far), and yes/no confirmations (default no). Every
// prompt is cancelled by Escape or Ctrl+C (clack reads them in raw mode), by
// Ctrl+D on an empty answer (`askUntilEndOfInput`) and by the interruption
// signal.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { Prompt, TextPrompt } from "@clack/core";
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
  text,
  unicodeOr,
} from "@clack/prompts";
import { askUntilEndOfInput, type PromptStreams } from "../end-of-input.ts";
import type { Project } from "../project.ts";
import {
  InvalidDraftNameError,
  normaliseDraftName,
} from "../store/draft-name.ts";
import { migrationFolderName } from "../store/migrations.ts";
import {
  type CommandDefinition,
  type CommandSection,
  commandSections,
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

/** Every prompt is asked through here, so that end of input cancels it. */
function ask<T>(
  io: PromptIo,
  prompt: (streams: PromptStreams) => Promise<T>,
): Promise<T> {
  // clack types its streams as node:stream's Readable/Writable.
  return askUntilEndOfInput(
    {
      input: io.input as Readable,
      output: io.output as Writable,
      signal: io.signal,
    },
    prompt,
  );
}

export const quit = "quit";

const arrow = unicodeOr("\u2192", "->");

/** A menu section: its commands, in the order `commands` lists them. */
interface MenuSection {
  readonly name: CommandSection;
  readonly commands: readonly CommandDefinition[];
}

/** Where the menu opens: at the top on a section, or inside one on a command. */
export type MenuStart =
  | { readonly section: CommandSection | undefined }
  | { readonly command: CommandDefinition };

interface MenuEntry {
  readonly label: string;
  readonly hint: string;
}

/** What one of the menu's levels shows, and where its cursor is. */
interface MenuLevel {
  /** Shown above the entries: the open section's name. */
  readonly heading: string | undefined;
  readonly entries: readonly MenuEntry[];
  readonly cursor: number;
  readonly footer: string;
}

const menuMessage = "What do you want to do?";

/**
 * The menu's two levels. At the top: the sections, then `quit`; Enter or
 * Right opens the section under the cursor. Inside a section: its commands;
 * Enter runs one, Backspace or Left go back to the top. Escape leaves from
 * either.
 * Each level keeps its cursor, so a section reopens where it was left. Its
 * value is the chosen command's name, or `quit`.
 */
class MenuPrompt extends Prompt<string> {
  readonly sections: readonly MenuSection[];
  /** The section whose commands are showing; undefined at the top. */
  openSection: MenuSection | undefined;
  /** Each level's cursor, by the open section's name (undefined: the top). */
  private readonly cursors = new Map<CommandSection | undefined, number>();

  constructor(
    streams: PromptStreams,
    sections: readonly MenuSection[],
    start: MenuStart,
  ) {
    super({ ...streams, render: renderMenu }, false);
    this.sections = sections;
    const name = "command" in start ? start.command.section : start.section;
    const index = sections.findIndex((section) => section.name === name);
    this.cursors.set(undefined, Math.max(index, 0));
    if ("command" in start && index >= 0) {
      this.openSection = sections[index];
      this.cursors.set(
        name,
        Math.max(this.openSection?.commands.indexOf(start.command) ?? 0, 0),
      );
    }
    this.on("cursor", (action) => {
      switch (action) {
        case "up":
        case "down":
          this.move(action === "up" ? -1 : 1);
          break;
        case "right":
          this.openSectionAtCursor();
          break;
        case "left":
          this.closeSection();
          break;
      }
    });
    this.on("key", (_char, key) => {
      if (key.name === "backspace") {
        this.closeSection();
      }
    });
  }

  /** The level showing now. */
  get level(): MenuLevel {
    const open = this.openSection;
    const cursor = this.cursors.get(open?.name) ?? 0;
    if (open === undefined) {
      return {
        heading: undefined,
        entries: [
          ...this.sections.map((section) => ({
            label: section.name,
            hint: section.commands.map((command) => command.name).join(", "),
          })),
          { label: quit, hint: "Leave the menu" },
        ],
        cursor,
        footer: "Up/Down to move, Enter or Right to open, Escape to leave",
      };
    }
    return {
      heading: open.name,
      entries: open.commands.map((command) => ({
        label: command.name,
        hint: command.summary,
      })),
      cursor,
      footer: "Up/Down to move, Enter to run, Left to go back, Escape to leave",
    };
  }

  private move(by: number): void {
    const { entries, cursor } = this.level;
    const count = entries.length;
    this.cursors.set(this.openSection?.name, (cursor + by + count) % count);
  }

  /** Opens the section under the top's cursor (not quit). */
  private openSectionAtCursor(): boolean {
    const section = this.sections[this.cursors.get(undefined) ?? 0];
    if (this.openSection !== undefined || section === undefined) {
      return false;
    }
    this.openSection = section;
    return true;
  }

  private closeSection(): void {
    this.openSection = undefined;
  }

  /** Enter opens a section at the top; it submits a command or quit. */
  protected override _shouldSubmit(): boolean {
    if (this.openSectionAtCursor()) {
      return false;
    }
    const { entries, cursor } = this.level;
    this.value = entries[cursor]?.label ?? quit;
    return true;
  }
}

function renderMenu(this: MenuPrompt): string {
  const title = `${styleText("gray", S_BAR)}\n${symbol(this.state)}  ${menuMessage}\n`;
  const { heading, entries, cursor, footer } = this.level;
  if (this.state === "submit" || this.state === "cancel") {
    const label = entries[cursor]?.label ?? "";
    return `${title}${styleText("gray", S_BAR)}  ${styleText(this.state === "cancel" ? ["strikethrough", "dim"] : "dim", label)}`;
  }
  const bar = styleText("cyan", S_BAR);
  const width = Math.max(...entries.map((entry) => entry.label.length)) + 2;
  const lines = entries.map((entry, index) => {
    const active = index === cursor;
    const radio = active
      ? styleText("green", S_RADIO_ACTIVE)
      : styleText("dim", S_RADIO_INACTIVE);
    const label = entry.label.padEnd(width);
    return `${bar}    ${radio} ${active ? label : styleText("dim", label)}${styleText("dim", entry.hint)}`;
  });
  const headingLine =
    heading === undefined ? "" : `${bar}  ${styleText("bold", heading)}\n`;
  return `${title}${headingLine}${lines.join("\n")}\n${bar}\n${styleText("cyan", S_BAR_END)}  ${styleText("dim", footer)}\n`;
}

/**
 * The menu: sections of commands, then `quit`. Resolves to the chosen
 * command, or `undefined` for quit, Escape, Ctrl+C or an
 * interruption.
 */
export async function pickCommand(
  io: PromptIo,
  commands: readonly CommandDefinition[],
  start: MenuStart,
): Promise<CommandDefinition | undefined> {
  const sections = commandSections
    .map((name) => ({
      name,
      commands: commands.filter((command) => command.section === name),
    }))
    .filter((section) => section.commands.length > 0);
  const answer = await ask(io, (streams) =>
    new MenuPrompt(streams, sections, start).prompt(),
  );
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
    const answer = await askOption(io, option, project, values);
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
  answers: OptionValues,
): Promise<string | boolean | undefined | typeof cancelled> {
  const message = menuQuestion(option);
  switch (option.kind) {
    case "target": {
      const names = Object.keys(needed(project, option).config.targets);
      if (names.length === 0) {
        throw new RefusedError("super-deploy.config.ts has no targets");
      }
      return answered(
        await ask(io, (streams) =>
          select({
            ...streams,
            message,
            options: names.map((name) => ({ value: name, label: name })),
          }),
        ),
      );
    }
    case "migration": {
      const migrations = [
        ...(await option.migrations(needed(project, option))),
      ].sort((a, b) => b.number - a.number);
      if (migrations.length === 0 && option.zero === undefined) {
        if (!option.required) {
          // Nothing to choose: the option is simply not given.
          return undefined;
        }
        throw new RefusedError("There are no migrations to choose from");
      }
      const none = "";
      const answer = answered(
        await ask(io, (streams) =>
          autocomplete({
            ...streams,
            message,
            placeholder: "Type to search",
            maxItems: 10,
            options: [
              ...(option.required ? [] : [{ value: none, label: "(none)" }]),
              ...migrations.map((migration) => ({
                value: String(migration.number),
                label: migrationFolderName(migration.number, migration.name),
              })),
              ...(option.zero === undefined
                ? []
                : [{ value: "0", label: option.zero }]),
            ],
          }),
        ),
      );
      return answer === none ? undefined : answer;
    }
    case "choice": {
      const asked = await option.menu?.(needed(project, option), answers);
      return answered(
        await ask(io, (streams) =>
          select({
            ...streams,
            message: asked?.question ?? message,
            options: option.choices.map((choice) => ({
              value: choice,
              label: choice,
            })),
            ...(asked === undefined ? {} : { initialValue: asked.initial }),
          }),
        ),
      );
    }
    case "name":
      return askName(io, option, project);
    case "flag": {
      if (option.acknowledgement) {
        // Never set by the menu: the command asks when it matters.
        return undefined;
      }
      const answer = answered(
        await ask(io, (streams) =>
          clackConfirm({ ...streams, message, initialValue: false }),
        ),
      );
      return answer === cancelled ? cancelled : answer ? true : undefined;
    }
  }
}

function menuQuestion(option: OptionDefinition): string {
  return option.question ?? option.description;
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
  const answer = await ask(io, (streams) =>
    new TextPrompt({
      ...streams,
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
        const title = `${styleText("gray", S_BAR)}\n${symbol(this.state)}  ${menuQuestion(option)}\n`;
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
    }).prompt(),
  );
  if (isCancel(answer)) {
    return cancelled;
  }
  const input = answer ?? "";
  return input.trim() === "" ? undefined : input;
}

/** A free-text question. Cancelling (or an interruption) answers undefined. */
export async function askAtTerminal(
  io: PromptIo,
  question: string,
): Promise<string | undefined> {
  const answer = await ask(io, (streams) =>
    text({ ...streams, message: question }),
  );
  return isCancel(answer) ? undefined : answer;
}

/** A yes/no question, default no. Cancelling (or an interruption) answers no. */
export async function confirmAtTerminal(
  io: PromptIo,
  question: string,
): Promise<boolean> {
  const answer = await ask(io, (streams) =>
    clackConfirm({ ...streams, message: question, initialValue: false }),
  );
  return answer === true;
}
