// One set of command definitions drives both direct CLI mode (util.parseArgs
// flags) and the interactive menu (ticket 05). Each command's `run` calls the
// exported API function and prints its result.
import { draft } from "../commands/draft.ts";
import type { Project } from "../project.ts";

export type CommandGroup =
  | "Start"
  | "Author"
  | "Deploy"
  | "Recover"
  | "Disposable";

export const commandGroups: readonly CommandGroup[] = [
  "Start",
  "Author",
  "Deploy",
  "Recover",
  "Disposable",
];

/**
 * How an option is asked for in the menu and parsed on the command line:
 * - target: a target name from config
 * - migration: a migration number (menu: searchable, newest first)
 * - choice: one of `choices`
 * - name: free text normalised like a draft name (invalid input is a usage error)
 * - flag: a boolean switch (the menu never sets acknowledgement flags)
 */
export type OptionKind = "target" | "migration" | "choice" | "name" | "flag";

export interface OptionDefinition {
  /** Long option name without dashes, e.g. `name` for `--name`. */
  readonly name: string;
  readonly kind: OptionKind;
  readonly description: string;
  readonly required?: boolean;
  readonly choices?: readonly string[];
}

export type OptionValues = Readonly<
  Record<string, string | boolean | undefined>
>;

export interface CommandContext {
  /** A result line, to stdout. */
  result(line: string): void;
  /** A warning or progress line, to stderr. */
  warn(line: string): void;
  /** An absolute path as shown to the user (relative to the working directory). */
  displayPath(path: string): string;
}

export interface CommandDefinition {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly options: readonly OptionDefinition[];
  run(
    project: Project,
    values: OptionValues,
    context: CommandContext,
  ): Promise<void>;
}

const draftCommand: CommandDefinition = {
  name: "draft",
  group: "Author",
  summary:
    "Generate the draft's schema change from the newest migration to the desired schema",
  options: [
    {
      name: "name",
      kind: "name",
      description:
        "Name for a new draft, or a new name for the existing draft (spaces become hyphens)",
    },
  ],
  async run(project, values, context) {
    const name = typeof values.name === "string" ? values.name : undefined;
    const result = await draft(project, name === undefined ? {} : { name });
    const count = `${result.statements.length} statement${result.statements.length === 1 ? "" : "s"}`;
    const where = context.displayPath(result.schemaChangePath);
    const what = result.created
      ? `Created draft ${result.name}`
      : result.renamedFrom !== undefined
        ? `Renamed draft ${result.renamedFrom} to ${result.name}`
        : `Regenerated draft ${result.name}`;
    context.result(`${what}: ${count} in ${where}`);
  },
};

export const commands: readonly CommandDefinition[] = [draftCommand];
