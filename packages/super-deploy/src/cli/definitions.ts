// One set of command definitions drives both direct CLI mode (util.parseArgs
// flags, parse.ts) and the interactive menu (menu.ts). Each command's `run`
// calls the exported API function and prints its result. To add a command,
// define it here and append it to `commands`.
import { draft } from "../commands/draft.ts";
import { finalize } from "../commands/finalize.ts";
import { rehearse } from "../commands/rehearse.ts";
import { validate } from "../commands/validate.ts";
import { ValidationFailedError, type ValidationProblem } from "../errors.ts";
import type { Project } from "../project.ts";
import { readDraft } from "../store/draft.ts";

export type CommandGroup =
  | "Start"
  | "Author"
  | "Deploy"
  | "Recover"
  | "Disposable";

/** Menu and help sections, in order. */
export const commandGroups: readonly CommandGroup[] = [
  "Start",
  "Author",
  "Deploy",
  "Recover",
  "Disposable",
];

interface OptionBase {
  /** Long option name without dashes, e.g. `name` for `--name`. */
  readonly name: string;
  readonly description: string;
  /** Missing on the command line is a usage error; the menu insists on an answer. */
  readonly required?: boolean;
}

/** A target name from config. Unknown names are usage errors; the menu picks from the configured targets. */
export interface TargetOption extends OptionBase {
  readonly kind: "target";
}

export interface MigrationChoice {
  readonly number: number;
  readonly name: string;
}

/** A migration number. The menu offers `migrations(project)` newest first, searchable. */
export interface MigrationOption extends OptionBase {
  readonly kind: "migration";
  migrations(project: Project): Promise<readonly MigrationChoice[]>;
}

/** One of `choices`. */
export interface ChoiceOption extends OptionBase {
  readonly kind: "choice";
  readonly choices: readonly string[];
}

/** Free text normalised like a draft name; the menu previews the normalised result. */
export interface NameOption extends OptionBase {
  readonly kind: "name";
  /** The menu's starting text, e.g. the current draft's name. */
  initial?(project: Project): Promise<string | undefined>;
}

/**
 * A boolean switch. The menu asks yes/no (default no), except for
 * acknowledgement flags, which the menu never sets: the command itself asks
 * when it matters (see `acknowledge`).
 */
export interface FlagOption extends OptionBase {
  readonly kind: "flag";
  readonly acknowledgement?: boolean;
}

export type OptionDefinition =
  | TargetOption
  | MigrationOption
  | ChoiceOption
  | NameOption
  | FlagOption;

export type OptionKind = OptionDefinition["kind"];

/** Option values by option name: strings for valued kinds, `true` for flags given. */
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
  /**
   * Asks a yes/no question at the terminal, default no; cancelling answers
   * no. Undefined without a terminal (or in CI): commands must then refuse
   * unless the acknowledgement flag was given. See `acknowledge`.
   */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
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

/** A command refused to go ahead (exit 1). */
export class RefusedError extends Error {
  override name = "RefusedError";
}

/**
 * For acknowledgements: true if the flag was given or the user answers yes,
 * false if they answer no (the command should then stop without changing
 * anything). Without a terminal, refuses with RefusedError naming the flag.
 */
export async function acknowledge(
  values: OptionValues,
  context: CommandContext,
  flag: string,
  question: string,
): Promise<boolean> {
  if (values[flag] === true) {
    return true;
  }
  if (context.confirm === undefined) {
    throw new RefusedError(
      `${question} Refused without a terminal: pass --${flag} to accept`,
    );
  }
  return context.confirm(question);
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
      initial: async (project) => (await readDraft(project.paths))?.name,
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

const rehearseCommand: CommandDefinition = {
  name: "rehearse",
  group: "Author",
  summary:
    "Replay every migration plus the draft on a throwaway database and prove it matches the desired schema",
  options: [],
  async run(project, _values, context) {
    const result = await rehearse(project);
    context.result(
      `Rehearsed draft ${result.name} after ${plural(result.migrationsReplayed, "migration")}: matches the desired schema`,
    );
  },
};

const finalizeCommand: CommandDefinition = {
  name: "finalize",
  group: "Author",
  summary:
    "Rehearse the draft, then freeze it as the next numbered, read-only, hash-chained migration",
  options: [],
  async run(project, _values, context) {
    const result = await finalize(project);
    context.result(
      `Finalized migration ${result.folder} in ${context.displayPath(result.path)}`,
    );
  },
};

const validateCommand: CommandDefinition = {
  name: "validate",
  group: "Author",
  summary:
    "Check the finalized migrations' hashes, chain and read-only state, and warn about unfinished work",
  options: [
    {
      name: "strict",
      kind: "flag",
      description: "Fail on warnings too (for pre-commit hooks and CI)",
    },
  ],
  async run(project, values, context) {
    const report = (problem: ValidationProblem) =>
      context.warn(`${problem.severity}: ${problem.message}`);
    try {
      const result = await validate(project, {
        strict: values.strict === true,
      });
      result.problems.forEach(report);
      if (result.readOnlyRestored.length > 0) {
        context.warn(
          `Made ${plural(result.readOnlyRestored.length, "finalized file")} read-only again`,
        );
      }
      context.result(`Validated ${plural(result.migrations, "migration")}`);
    } catch (error) {
      if (error instanceof ValidationFailedError) {
        error.problems.forEach(report);
      }
      throw error;
    }
  },
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const commands: readonly CommandDefinition[] = [
  draftCommand,
  rehearseCommand,
  finalizeCommand,
  validateCommand,
];
