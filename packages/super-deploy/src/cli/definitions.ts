// One set of command definitions drives both direct CLI mode (util.parseArgs
// flags, parse.ts) and the interactive menu (menu.ts). Each command's `run`
// calls the exported API function and prints its result. To add a command,
// define it here and append it to `commands`.
import { join } from "node:path";
import { deploy } from "../commands/deploy.ts";
import { discardDraft } from "../commands/discard-draft.ts";
import { disposable } from "../commands/disposable.ts";
import { draft } from "../commands/draft.ts";
import { finalize } from "../commands/finalize.ts";
import { init } from "../commands/init.ts";
import { rehearse } from "../commands/rehearse.ts";
import { restoreSchema } from "../commands/restore-schema.ts";
import { status } from "../commands/status.ts";
import { unfinalize } from "../commands/unfinalize.ts";
import { validate } from "../commands/validate.ts";
import type { AttemptRecord } from "../deploy/history.ts";
import {
  OverwriteNotAcknowledgedError,
  ValidationFailedError,
  type ValidationProblem,
} from "../errors.ts";
import type { Project } from "../project.ts";
import type { OverwriteOptions, Question } from "../questions.ts";
import type { Override } from "../sql-analysis/index.ts";
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

interface CommandBase {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly options: readonly OptionDefinition[];
}

/** A command on the project found from the working directory (most commands). */
export interface ProjectCommandDefinition extends CommandBase {
  readonly needsProject?: true;
  run(
    project: Project,
    values: OptionValues,
    context: CommandContext,
  ): Promise<void>;
}

/**
 * A command that runs in the working directory without loading a project
 * (`init`). Its options must not need one: no `target` or `migration` kinds,
 * and no `initial` on `name` options.
 */
export interface DirectoryCommandDefinition extends CommandBase {
  readonly needsProject: false;
  run(
    directory: string,
    values: OptionValues,
    context: CommandContext,
  ): Promise<void>;
}

export type CommandDefinition =
  | ProjectCommandDefinition
  | DirectoryCommandDefinition;

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

const initCommand: DirectoryCommandDefinition = {
  name: "init",
  group: "Start",
  summary:
    "Create a project here from the bundled template, with a local embedded PostgreSQL and a dev target",
  needsProject: false,
  options: [],
  async run(directory, _values, context) {
    const result = await init({ directory });
    context.result(
      `Initialised a super-deploy project in ${context.displayPath(result.root)}`,
    );
    context.result(
      "Next: pnpm install, add CREATE statements under data-model/desired-schema/, then run draft",
    );
  },
};

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
    for (const item of result.toCover) {
      context.warn(`warning: ${item.message}`);
    }
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
    for (const override of result.metadata.overrides) {
      context.result(describeOverride(override, result.path, context));
    }
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
      for (const override of result.overrides) {
        context.result(describeOverride(override, project.root, context));
      }
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

const acknowledgeOverwriteOption: FlagOption = {
  name: "acknowledge-overwrite",
  kind: "flag",
  acknowledgement: true,
  description:
    "Go ahead without asking when work would be deleted or overwritten (required without a terminal)",
};

/**
 * The API's overwrite options: the flag, and the terminal's yes/no question
 * (listing what would be lost) as the confirm callback.
 */
function overwriteOptions(
  values: OptionValues,
  context: CommandContext,
): OverwriteOptions {
  const { confirm } = context;
  return {
    acknowledgeOverwrite: values["acknowledge-overwrite"] === true,
    ...(confirm === undefined
      ? {}
      : {
          confirm: (question: Question) =>
            confirm(
              [
                question.message,
                ...question.paths.map((path) => `  ${path}`),
              ].join("\n"),
            ),
        }),
  };
}

/**
 * Runs an overwriting command; answering no at the terminal is not a failure:
 * it prints a result line and nothing changes (exit 0).
 */
async function unlessDeclined<T>(
  context: CommandContext,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OverwriteNotAcknowledgedError && error.declined) {
      context.result("Nothing changed");
      return undefined;
    }
    throw error;
  }
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
    const result = await unlessDeclined(context, () =>
      unfinalize(project, overwriteOptions(values, context)),
    );
    if (result === undefined) {
      return;
    }
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
    const result = await unlessDeclined(context, () =>
      restoreSchema(project, overwriteOptions(values, context)),
    );
    if (result === undefined) {
      return;
    }
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
    const result = await unlessDeclined(context, () =>
      discardDraft(project, overwriteOptions(values, context)),
    );
    if (result === undefined) {
      return;
    }
    context.result(
      `Discarded draft ${result.name ?? "(unnamed)"} (${context.displayPath(result.path)})`,
    );
  },
};

const targetOption: TargetOption = {
  name: "target",
  kind: "target",
  description: "The target to use, by its name in super-deploy.config.ts",
  required: true,
};

const deployCommand: CommandDefinition = {
  name: "deploy",
  group: "Deploy",
  summary:
    "Rehearse every pending migration, then apply them all to the target in one transaction",
  options: [targetOption],
  async run(project, values, context) {
    const result = await deploy(project, {
      target: String(values.target),
      onWarning: (warning) => context.warn(`warning: ${warning}`),
    });
    context.result(
      result.deployed.length === 0
        ? `Target ${result.target} is up to date: nothing to deploy`
        : `Deployed ${plural(result.deployed.length, "migration")} to ${result.target}: ${result.deployed.map((m) => m.folder).join(", ")}`,
    );
  },
};

const statusCommand: CommandDefinition = {
  name: "status",
  group: "Deploy",
  summary: "Show the target's pending migrations and recent attempts",
  options: [targetOption],
  async run(project, values, context) {
    const report = await status(project, { target: String(values.target) });
    const { preflight } = report;
    for (const warning of preflight.warnings) {
      context.warn(`warning: ${warning}`);
    }
    context.result(
      `Target ${report.target}${report.disposable ? " (disposable)" : ""}: ${plural(report.recorded.length, "migration")} recorded, ${report.pending.length} pending`,
    );
    const refusals = [
      ...preflight.missingRoles.map((role) => `role "${role}" does not exist`),
      ...preflight.missingExternalSchemas.map(
        (schema) => `external schema "${schema}" does not exist`,
      ),
      ...preflight.historyMismatches.map((mismatch) => mismatch.message),
    ];
    if (refusals.length > 0) {
      context.result("Deploy would refuse:");
      for (const refusal of refusals) {
        context.result(`  ${refusal}`);
      }
    }
    if (report.pending.length > 0) {
      context.result("Pending:");
      for (const migration of report.pending) {
        context.result(`  ${migration.folder}`);
      }
    }
    if (report.attempts.length > 0) {
      context.result("Recent attempts:");
      for (const attempt of report.attempts) {
        context.result(`  ${describeAttempt(attempt)}`);
      }
    }
  },
};

const disposableCommand: CommandDefinition = {
  name: "disposable",
  group: "Disposable",
  summary:
    "Flag the target as disposable (or not) in its own history schema; asks you to type YES",
  options: [
    targetOption,
    {
      name: "set",
      kind: "choice",
      choices: ["yes", "no"],
      description:
        "yes to make the target disposable, no to make it not disposable",
      required: true,
    },
  ],
  async run(project, values, context) {
    const result = await disposable(project, {
      target: String(values.target),
      set: values.set === "yes",
    });
    const what = result.disposable ? "disposable" : "not disposable";
    context.result(
      result.changed
        ? `Target ${result.target} is now ${what}`
        : `Target ${result.target} is already ${what}: nothing changed`,
    );
  },
};

function describeAttempt(attempt: AttemptRecord): string {
  const range =
    attempt.fromMigration === undefined
      ? ""
      : attempt.fromMigration === attempt.toMigration
        ? ` migration ${attempt.fromMigration}`
        : ` migrations ${attempt.fromMigration}-${attempt.toMigration}`;
  const error = attempt.error === undefined ? "" : `: ${attempt.error}`;
  return `#${attempt.id} ${attempt.command} ${attempt.outcome}${range} by ${attempt.osUser} at ${attempt.startedAt.toISOString()}${error}`;
}

/** `override: <file>:<line>: <object> [<rules>]: <reason>`; `file` is relative to `base`. */
function describeOverride(
  override: Override,
  base: string,
  context: CommandContext,
): string {
  const file = context.displayPath(join(base, override.file));
  return `override: ${file}:${override.line}: ${override.object} [${override.rules.join(", ")}]: ${override.reason}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const commands: readonly CommandDefinition[] = [
  initCommand,
  draftCommand,
  rehearseCommand,
  finalizeCommand,
  unfinalizeCommand,
  restoreSchemaCommand,
  discardDraftCommand,
  validateCommand,
  deployCommand,
  statusCommand,
  disposableCommand,
];
