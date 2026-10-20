// One set of command definitions drives both direct CLI mode (util.parseArgs
// flags) and the interactive menu (ticket 05). Each command's `run` calls the
// exported API function and prints its result.
import { join } from "node:path";
import { discardDraft } from "../commands/discard-draft.ts";
import { draft } from "../commands/draft.ts";
import { finalize } from "../commands/finalize.ts";
import { rehearse } from "../commands/rehearse.ts";
import { restoreSchema } from "../commands/restore-schema.ts";
import { unfinalize } from "../commands/unfinalize.ts";
import { validate } from "../commands/validate.ts";
import { ValidationFailedError, type ValidationProblem } from "../errors.ts";
import type { Project } from "../project.ts";
import type { OverwriteOptions, Question } from "../questions.ts";

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
  /**
   * Asks a yes/no question (default no). Absent when there is no terminal
   * (or in CI): commands then refuse unless the acknowledgement flag is set.
   */
  confirm?: ((question: Question) => Promise<boolean>) | undefined;
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

const acknowledgeOverwriteOption: OptionDefinition = {
  name: "acknowledge-overwrite",
  kind: "flag",
  description:
    "Go ahead without asking when work would be deleted or overwritten (required without a terminal)",
};

/** The API's overwrite options from the flag and the context's question. */
function overwriteOptions(
  values: OptionValues,
  context: CommandContext,
): OverwriteOptions {
  return {
    acknowledgeOverwrite: values["acknowledge-overwrite"] === true,
    ...(context.confirm === undefined ? {} : { confirm: context.confirm }),
  };
}

/** One result line per desired-schema file written or deleted (paths are project-relative). */
function reportRestore(
  project: Project,
  result: { restored: readonly string[]; deleted: readonly string[] },
  context: CommandContext,
): void {
  const show = (path: string) => context.displayPath(join(project.root, path));
  for (const path of result.restored) {
    context.result(`Restored ${show(path)}`);
  }
  for (const path of result.deleted) {
    context.result(`Deleted ${show(path)}`);
  }
}

const unfinalizeCommand: CommandDefinition = {
  name: "unfinalize",
  group: "Author",
  summary:
    "Move the newest migration back into the draft and restore its desired-schema snapshot",
  options: [acknowledgeOverwriteOption],
  async run(project, values, context) {
    const result = await unfinalize(project, overwriteOptions(values, context));
    context.result(
      `Moved migration ${result.folder} back into draft ${result.name} in ${context.displayPath(result.draftPath)}`,
    );
    reportRestore(project, result, context);
  },
};

const restoreSchemaCommand: CommandDefinition = {
  name: "restore-schema",
  group: "Author",
  summary:
    "Reset the desired schema to the newest migration's snapshot and delete any draft",
  options: [acknowledgeOverwriteOption],
  async run(project, values, context) {
    const result = await restoreSchema(
      project,
      overwriteOptions(values, context),
    );
    const changed =
      result.restored.length > 0 ||
      result.deleted.length > 0 ||
      result.discardedDraft !== undefined;
    context.result(
      changed
        ? `Reset the desired schema to migration ${result.migration}'s snapshot`
        : `The desired schema already matches migration ${result.migration}'s snapshot`,
    );
    if (result.discardedDraft !== undefined) {
      context.result(`Discarded draft ${result.discardedDraft}`);
    }
    reportRestore(project, result, context);
  },
};

const discardDraftCommand: CommandDefinition = {
  name: "discard-draft",
  group: "Author",
  summary: "Delete the draft, leaving the desired schema alone",
  options: [acknowledgeOverwriteOption],
  async run(project, values, context) {
    const result = await discardDraft(
      project,
      overwriteOptions(values, context),
    );
    context.result(
      `Discarded draft ${result.name ?? "(unnamed)"} (${context.displayPath(result.path)})`,
    );
  },
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const commands: readonly CommandDefinition[] = [
  draftCommand,
  rehearseCommand,
  finalizeCommand,
  unfinalizeCommand,
  restoreSchemaCommand,
  discardDraftCommand,
  validateCommand,
];
