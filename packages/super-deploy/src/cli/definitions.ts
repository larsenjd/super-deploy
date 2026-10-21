// One set of command definitions drives both direct CLI mode (util.parseArgs
// flags, parse.ts) and the interactive menu (menu.ts). Each command's `run`
// calls the exported API function and prints its result. To add a command,
// define it here and append it to `commands`.
import { join } from "node:path";
import { adopt } from "../commands/adopt.ts";
import { deploy, describeMigration } from "../commands/deploy.ts";
import { deployDraft } from "../commands/deploy-draft.ts";
import { discardDraft } from "../commands/discard-draft.ts";
import { disposable } from "../commands/disposable.ts";
import { draft } from "../commands/draft.ts";
import { finalize } from "../commands/finalize.ts";
import { init } from "../commands/init.ts";
import { mark } from "../commands/mark.ts";
import { rebuild } from "../commands/rebuild.ts";
import { recovery } from "../commands/recovery.ts";
import { rehearse } from "../commands/rehearse.ts";
import { restoreSchema } from "../commands/restore-schema.ts";
import { status } from "../commands/status.ts";
import { unfinalize } from "../commands/unfinalize.ts";
import { ValidationFailedError, validate } from "../commands/validate.ts";
import type { AttemptRecord, RecordedMigration } from "../deploy/history.ts";
import {
  describeLockHolder,
  lockHolderName,
  TargetLockedError,
} from "../deploy/lock.ts";
import { MarkMismatchError } from "../deploy/mark.ts";
import {
  PreflightFailedError,
  preflightRefusals,
} from "../deploy/preflight.ts";
import { plural } from "../errors.ts";
import { findUpward, type Project } from "../project.ts";
import type {
  AskOverrideReason,
  Confirm,
  OverwriteOptions,
  Question,
} from "../questions.ts";
import {
  DestructiveNotAcknowledgedError,
  OverwriteNotAcknowledgedError,
} from "../questions.ts";
import type { Override } from "../sql-analysis/index.ts";
import { readDraft, type UnknownDraftFileOptions } from "../store/draft.ts";
import type { ValidationProblem } from "../store/integrity.ts";
import {
  migrationFolderName,
  parseMigrationFolderName,
  readIndex,
} from "../store/migrations.ts";
import {
  DriftError,
  type DriftedObject,
  driftLabel,
} from "../verification/drift.ts";

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
  /** The `--help` text. */
  readonly description: string;
  /**
   * The menu's question for this option, when the `--help` text doesn't read
   * as one on its own. The menu asks `description` without it.
   */
  readonly question?: string;
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
  /**
   * When set, 0 (no migrations) is a valid value too, and the menu offers it
   * below migration 1 with this label. Only rebuild's `--to` takes it.
   */
  readonly zero?: string;
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
  /**
   * Asks for free text at the terminal; undefined if cancelled. Undefined
   * without a terminal (or in CI), like `confirm`.
   */
  readonly ask: ((question: string) => Promise<string | undefined>) | undefined;
}

interface CommandBase {
  readonly name: string;
  readonly group: CommandGroup;
  readonly summary: string;
  readonly options: readonly OptionDefinition[];
  /**
   * For a command that changes a target: the option naming it, and what the
   * change is called (`deployment`). After an interruption the CLI then says
   * what happened to the target (run.ts).
   */
  readonly changesTarget?: { readonly option: string; readonly noun: string };
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
 * and no `initial` on `name` options; except `projectMode`'s option.
 */
export interface DirectoryCommandDefinition extends CommandBase {
  readonly needsProject: false;
  run(
    directory: string,
    values: OptionValues,
    context: CommandContext,
  ): Promise<void>;
  /**
   * An option (e.g. `init --adopt <target>`) that turns the command into a
   * project command: when it is given, the project is loaded and `run`
   * runs instead. The menu asks it (as required) only inside a project,
   * and runs the command without it outside one.
   */
  readonly projectMode?: {
    readonly option: string;
    run(
      project: Project,
      values: OptionValues,
      context: CommandContext,
    ): Promise<void>;
  };
}

export type CommandDefinition =
  | ProjectCommandDefinition
  | DirectoryCommandDefinition;

/** True when the command runs on a project with these option values. */
export function needsProject(
  command: CommandDefinition,
  values: OptionValues,
): boolean {
  return (
    command.needsProject !== false ||
    (command.projectMode !== undefined &&
      values[command.projectMode.option] !== undefined)
  );
}

/** True if `directory` or a folder above it has a `.git` (a folder, or a file in linked worktrees). */
function insideGitWorkTree(directory: string): boolean {
  return findUpward(directory, ".git") !== undefined;
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

const initCommand: DirectoryCommandDefinition = {
  name: "init",
  group: "Start",
  summary:
    "Create a project here, or adopt a database into an initialised project with no migrations yet",
  needsProject: false,
  changesTarget: { option: "adopt", noun: "adoption" },
  options: [
    {
      name: "adopt",
      kind: "target",
      description:
        "Instead, in an initialised project with no migrations yet: turn this target's managed schema into the desired schema and migration 1, recorded on it as marked",
      question:
        "Adopt which target's existing database as migration 1? Its managed schema becomes the desired schema",
    },
  ],
  async run(directory, _values, context) {
    const result = await init({ directory });
    // The absolute path: init runs in the working directory, which
    // displayPath would show as ".".
    context.result(`Initialised a super-deploy project in ${result.root}`);
    // Git before pnpm install, as the template README says: Husky installs
    // the pre-commit hook only into an existing repo.
    const install = insideGitWorkTree(result.root)
      ? "pnpm install"
      : "git init, then pnpm install";
    context.result(
      `Next: ${install}, add CREATE statements under data-model/desired-schema/, then run draft`,
    );
  },
  projectMode: {
    option: "adopt",
    async run(project, values, context) {
      try {
        const result = await adopt(project, {
          target: String(values.adopt),
          overrideReason: overrideReasonCallback(context),
        });
        for (const file of result.files) {
          context.result(
            `Wrote ${context.displayPath(join(project.root, file))}`,
          );
        }
        context.result(
          `Adopted target ${result.target}: migration ${result.migration.folder} in ${context.displayPath(result.migration.path)}, recorded on it as marked (attempt #${result.attemptId})`,
        );
        const { grants, policies } = result.leftOnTarget;
        if (grants + policies > 0) {
          context.result(
            `Left ${plural(grants, "grant")} and ${plural(policies, "policy", "policies")} on target ${result.target} as they are: privileges and row-level security are set up outside super-deploy`,
          );
        }
        for (const override of result.overrides) {
          context.result(
            describeOverride(override, result.migration.path, context),
          );
        }
      } catch (error) {
        if (error instanceof MarkMismatchError) {
          reportMarkMismatch(error, context);
        }
        throw error;
      }
    },
  },
};

/**
 * `init --adopt`'s override reasons, asked at the terminal after listing
 * every object that needs one. Undefined without a terminal: adoption then
 * refuses them.
 */
function overrideReasonCallback(
  context: CommandContext,
): AskOverrideReason | undefined {
  const { ask } = context;
  if (ask === undefined) {
    return undefined;
  }
  return (question) => {
    if (question.index === 0) {
      context.warn(
        `Target ${question.target} has ${plural(question.needed.length, "object")} that need${question.needed.length === 1 ? "s" : ""} an override marker:`,
      );
      for (const item of question.needed) {
        context.warn(`  ${item.object}`);
        for (const finding of item.findings) {
          context.warn(`    ${finding.rule}: ${finding.message}`);
        }
      }
    }
    return ask(`${question.message} (empty cancels the adoption)`);
  };
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
      initial: async (project) =>
        (await readDraft(project.root, project.paths))?.name,
    },
  ],
  async run(project, values, context) {
    const name = typeof values.name === "string" ? values.name : undefined;
    const result = await draft(project, {
      ...(name === undefined ? {} : { name }),
      ...warnUnknownFiles(context),
    });
    const count = plural(result.statements.length, "statement");
    const where = context.displayPath(result.schemaChangePath);
    const what = result.created
      ? `Created draft ${result.name}`
      : result.renamedFrom !== undefined
        ? `Renamed draft ${result.renamedFrom} to ${result.name}`
        : `Regenerated draft ${result.name}`;
    context.result(`${what}: ${count} in ${where}`);
    reportWarnings(
      [
        ...result.toCover.map((item) => item.message),
        ...located(result.unqualifiedNames),
      ],
      context,
    );
    for (const shortfall of result.shortfalls) {
      context.warn(`warning: ${shortfall.message}`);
      for (const difference of shortfall.differences) {
        context.warn(`  ${difference}`);
      }
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
    const result = await rehearse(project, warnUnknownFiles(context));
    reportWarnings(located(result.warnings), context);
    for (const statement of result.destructive) {
      context.warn(
        `destructive: ${statement.file}:${statement.line}: ${statement.message} (finalize needs it acknowledged)`,
      );
    }
    context.result(
      result.recoveryOf === undefined
        ? `Rehearsed draft ${result.name} after ${plural(result.migrationsReplayed, "migration")}: matches the desired schema`
        : `Rehearsed the Recovery draft of migration ${migrationFolderName(result.recoveryOf, result.name)}: it ends in the same structure as the original`,
    );
  },
};

/** One `warning:` line on stderr per message. */
function reportWarnings(
  messages: readonly string[],
  context: CommandContext,
): void {
  for (const message of messages) {
    context.warn(`warning: ${message}`);
  }
}

/** Warnings about a place in a file, each as `<file>:<line>: <message>`. */
function located(
  warnings: readonly { file: string; line: number; message: string }[],
): string[] {
  return warnings.map(
    (warning) => `${warning.file}:${warning.line}: ${warning.message}`,
  );
}

/**
 * Warns about each file in the draft folder that a draft doesn't hold as soon
 * as the command finds it: before any rehearsal or question, so the warning
 * stands even when the command then fails.
 */
function warnUnknownFiles(context: CommandContext): UnknownDraftFileOptions {
  return { onUnknownFile: (file) => reportWarnings([file.message], context) };
}

const finalizeCommand: CommandDefinition = {
  name: "finalize",
  group: "Author",
  summary:
    "Rehearse the draft, then freeze it as the next numbered, read-only, hash-chained migration",
  options: [
    {
      name: "acknowledge-destructive",
      kind: "flag",
      acknowledgement: true,
      description:
        "Finalize without asking when the draft drops structure or deletes data (required without a terminal); recorded in the migration's metadata",
    },
  ],
  async run(project, values, context) {
    const confirm = confirmCallback(context);
    const result = await unlessDeclined(context, () =>
      finalize(project, {
        acknowledgeDestructive: values["acknowledge-destructive"] === true,
        ...(confirm === undefined ? {} : { confirm }),
        ...warnUnknownFiles(context),
      }),
    );
    if (result === undefined) {
      return;
    }
    reportWarnings(
      [...located(result.warnings), ...located(result.unqualifiedNames)],
      context,
    );
    context.result(
      result.recovery === undefined
        ? `Finalized migration ${result.folder} in ${context.displayPath(result.path)}`
        : `Finalized Recovery ${result.recovery} of migration ${result.folder} in ${context.displayPath(result.path)}`,
    );
    for (const override of result.metadata.overrides) {
      context.result(describeOverride(override, result.path, context));
    }
    if (result.destructive.length > 0) {
      context.result(
        `Recorded the acknowledgement of ${plural(result.destructive.length, "destructive statement")} in its metadata.json`,
      );
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
    {
      name: "allow-draft",
      kind: "flag",
      description:
        "Never fail on a draft in progress (an unfinalized draft or undrafted desired-schema changes), even with --strict: only warn (for the pre-commit hook)",
      question:
        "Allow a draft in progress? An unfinalized draft and undrafted desired-schema changes only warn, even when strict",
    },
  ],
  async run(project, values, context) {
    const report = (problem: ValidationProblem) =>
      context.warn(`${problem.severity}: ${problem.message}`);
    try {
      const result = await validate(project, {
        strict: values.strict === true,
        allowDraft: values["allow-draft"] === true,
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
      context.result(
        `Validated ${plural(result.migrations, "migration")}${result.recoveries === 0 ? "" : ` and ${plural(result.recoveries, "Recovery", "Recoveries")}`}`,
      );
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
 * The API's confirm callback: the terminal's yes/no question, listing what
 * would be lost. Undefined without a terminal.
 */
function confirmCallback(context: CommandContext): Confirm | undefined {
  const { confirm } = context;
  if (confirm === undefined) {
    return undefined;
  }
  return (question: Question) =>
    confirm(
      [
        question.message,
        ...(question.kind === "acknowledge-overwrite"
          ? question.paths
          : question.statements.map(
              (statement) =>
                `${statement.file}:${statement.line}: ${statement.message}`,
            )
        ).map((line) => `  ${line}`),
      ].join("\n"),
    );
}

/** The API's overwrite options: the flag, and the terminal's question as the confirm callback. */
function overwriteOptions(
  values: OptionValues,
  context: CommandContext,
): OverwriteOptions {
  const confirm = confirmCallback(context);
  return {
    acknowledgeOverwrite: values["acknowledge-overwrite"] === true,
    ...(confirm === undefined ? {} : { confirm }),
  };
}

/**
 * Runs a command that asks before discarding work or finalizing destructive
 * statements; answering no at the terminal is not a failure: it prints a
 * result line and nothing changes (exit 0).
 */
async function unlessDeclined<T>(
  context: CommandContext,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (
      (error instanceof OverwriteNotAcknowledgedError ||
        error instanceof DestructiveNotAcknowledgedError) &&
      error.declined
    ) {
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
    "Move the newest migration (or its newest Recovery) back into the draft and restore its desired-schema snapshot",
  options: [
    {
      name: "recovery-of",
      kind: "migration",
      description:
        "Move this migration's newest Recovery back into a Recovery draft instead",
      migrations: (project) => indexedMigrations(project, "with-recoveries"),
    },
    acknowledgeOverwriteOption,
  ],
  async run(project, values, context) {
    const recoveryOf = values["recovery-of"];
    const result = await unlessDeclined(context, () =>
      unfinalize(project, {
        ...overwriteOptions(values, context),
        ...(typeof recoveryOf === "string"
          ? { recoveryOf: Number(recoveryOf) }
          : {}),
      }),
    );
    if (result === undefined) {
      return;
    }
    context.result(
      result.recovery === undefined
        ? `Moved migration ${result.folder} back into draft ${result.name} in ${context.displayPath(result.draftPath)}`
        : `Moved Recovery ${result.recovery} of migration ${result.folder} back into a Recovery draft in ${context.displayPath(result.draftPath)}`,
    );
    reportRestore(project, result, context);
    if (result.warning !== undefined) {
      context.warn(`warning: ${result.warning}`);
    }
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
  changesTarget: { option: "target", noun: "deployment" },
  async run(project, values, context) {
    const result = await deploy(project, {
      target: String(values.target),
      onWarning: (warning) => context.warn(`warning: ${warning}`),
    });
    context.result(
      result.deployed.length === 0
        ? `Target ${result.target} is up to date: nothing to deploy`
        : `Deployed ${plural(result.deployed.length, "migration")} to ${result.target}: ${result.deployed.map(describeMigration).join(", ")}`,
    );
  },
};

const statusCommand: CommandDefinition = {
  name: "status",
  group: "Deploy",
  summary:
    "Show the target's pending migrations, recent attempts and drift (exit 1 on drift, on drift not checked or when deploy would refuse)",
  options: [targetOption],
  async run(project, values, context) {
    const report = await status(project, { target: String(values.target) });
    const { preflight } = report;
    reportWarnings(preflight.warnings, context);
    context.result(
      `Target ${report.target}${report.disposable ? " (disposable)" : ""}: ${plural(report.recorded.length, "migration")} recorded, ${report.pending.length} pending`,
    );
    if (report.lockedBy !== undefined) {
      context.result(`Locked by ${describeLockHolder(report.lockedBy)}`);
    }
    const refusals = preflightRefusals(preflight);
    if (refusals.length > 0) {
      context.result("Deploy would refuse:");
      for (const refusal of refusals) {
        context.result(`  ${refusal}`);
      }
    }
    if (report.driftNotChecked === "deployed-draft") {
      context.result(
        `Drift: not checked (the target holds deployed draft ${report.draft?.name}; rebuild resets it)`,
      );
    } else if (report.driftNotChecked === "history-mismatch") {
      context.result(
        "Drift: not checked (the recorded history doesn't match the project's migrations)",
      );
    } else if (
      report.driftNotChecked === "target-locked" &&
      report.lockedBy !== undefined
    ) {
      context.result(
        `Drift: not checked (the target is locked by ${lockHolderName(report.lockedBy)})`,
      );
    } else if (report.drift !== undefined && report.drift.length > 0) {
      context.result(
        "Drift (the target differs from its recorded migrations):",
      );
      for (const line of driftListing(report.drift)) {
        context.result(line);
      }
    }
    if (report.pending.length > 0) {
      context.result("Pending:");
      for (const migration of report.pending) {
        context.result(`  ${describeMigration(migration)}`);
      }
    }
    if (report.attempts.length > 0) {
      context.result("Recent attempts:");
      for (const attempt of report.attempts) {
        context.result(`  ${describeAttempt(attempt, report.recorded)}`);
      }
    }
    // Exit 0 only when drift was checked and found none and nothing would
    // make deploy refuse (pending migrations are fine), so a pipeline can
    // gate deploy on status and a scheduled status alerts on drift and on
    // drift going unchecked. The error says why.
    if (report.drift !== undefined && report.drift.length > 0) {
      throw new DriftError(report.target, report.drift, {
        command: "status",
        pending: report.pending.length,
      });
    }
    if (report.drift === undefined) {
      // Unchecked while another command holds the target lock, or for a
      // history mismatch, itself a refusal.
      throw report.driftNotChecked === "target-locked" &&
        report.lockedBy !== undefined
        ? new TargetLockedError(report.target, report.lockedBy)
        : new PreflightFailedError(report.target, preflight);
    }
    if (refusals.length > 0) {
      throw new PreflightFailedError(report.target, preflight);
    }
  },
};

const recoveryCommand: CommandDefinition = {
  name: "recovery",
  group: "Recover",
  summary:
    "Start a Recovery of a migration: replacement scripts and seed data for targets that haven't run it",
  options: [
    {
      name: "migration",
      kind: "migration",
      description: "The migration to recover",
      required: true,
      migrations: indexedMigrations,
    },
  ],
  async run(project, values, context) {
    const result = await recovery(project, {
      migration: Number(values.migration),
    });
    context.result(
      `Created a Recovery draft of migration ${result.folder} in ${context.displayPath(result.draftPath)} (it becomes Recovery ${result.recovery} when finalized)`,
    );
    context.result(
      "Next: fix its scripts, add seed data that reproduces the failure, then rehearse, finalize and deploy",
    );
  },
};

const markCommand: CommandDefinition = {
  name: "mark",
  group: "Recover",
  summary:
    "Record the target's next pending migration as deployed after fixing the target by hand, if it matches a replica exactly; asks you to type YES",
  options: [targetOption],
  changesTarget: { option: "target", noun: "mark" },
  async run(project, values, context) {
    try {
      const result = await mark(project, { target: String(values.target) });
      context.result(
        `Marked migration ${result.marked.folder} as deployed on target ${result.target} (attempt #${result.attemptId})`,
      );
    } catch (error) {
      if (error instanceof MarkMismatchError) {
        reportMarkMismatch(error, context);
      }
      throw error;
    }
  },
};

const disposableCommand: CommandDefinition = {
  name: "disposable",
  group: "Disposable",
  summary:
    "Flag the target as disposable (or not) in its own history schema; asks you to type YES",
  changesTarget: { option: "target", noun: "flag change" },
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

/** The objects a MarkMismatchError lists, on stderr. */
function reportMarkMismatch(
  error: MarkMismatchError,
  context: CommandContext,
): void {
  context.warn(
    `The target differs from a replica of its migrations up to ${error.migration}:`,
  );
  for (const line of driftListing(error.objects)) {
    context.warn(line);
  }
}

/**
 * Each drifted object, then its catalog lines, each saying which side it is
 * on (`driftLabel`), as `status` and `mark` list them.
 */
function driftListing(objects: readonly DriftedObject[]): string[] {
  return objects.flatMap((drifted) => [
    `  ${drifted.object}:`,
    ...drifted.differences.map(
      ({ side, line }) => `    ${driftLabel(drifted.change, side)}: ${line}`,
    ),
  ]);
}

const deployDraftCommand: CommandDefinition = {
  name: "deploy-draft",
  group: "Disposable",
  summary:
    "Try the unfinalized draft on a disposable target, in one transaction; asks you to type YES",
  changesTarget: { option: "target", noun: "draft's deployment" },
  options: [
    targetOption,
    {
      name: "with-seed",
      kind: "flag",
      description:
        "Load the draft's seed data first (it may clash with data already on the target)",
    },
  ],
  async run(project, values, context) {
    const result = await deployDraft(project, {
      target: String(values.target),
      withSeed: values["with-seed"] === true,
    });
    const what =
      result.recoveryOf === undefined
        ? `draft ${result.name}`
        : `the Recovery draft of migration ${result.recoveryOf}`;
    context.result(
      `Deployed ${what} to ${result.target} on top of ${result.baseMigration ?? "no recorded migration"}, ${result.seedData ? "with" : "without"} seed data`,
    );
  },
};

/**
 * The finalized migrations in index.json (only those with Recoveries, if
 * asked), for the menu's migration questions.
 */
async function indexedMigrations(
  project: Project,
  only?: "with-recoveries",
): Promise<MigrationChoice[]> {
  const index = await readIndex(project.paths);
  return index.ok
    ? index.entries
        .filter(
          (entry) => only === undefined || (entry.recoveries ?? []).length > 0,
        )
        .flatMap((entry) => parseMigrationFolderName(entry.folder) ?? [])
    : [];
}

const rebuildCommand: CommandDefinition = {
  name: "rebuild",
  group: "Disposable",
  summary:
    "Wipe a disposable target and replay migrations 1 to N, without seed data; asks you to type YES",
  changesTarget: { option: "target", noun: "rebuild" },
  options: [
    targetOption,
    {
      name: "to",
      kind: "migration",
      description: "The last migration to replay, or 0 for none",
      required: true,
      migrations: indexedMigrations,
      zero: "(none: no migrations)",
    },
  ],
  async run(project, values, context) {
    const result = await rebuild(project, {
      target: String(values.target),
      to: Number(values.to),
    });
    context.result(
      result.deployed.length === 0
        ? `Rebuilt ${result.target} with no migrations`
        : `Rebuilt ${result.target} with ${plural(result.deployed.length, "migration")}: ${result.deployed.map(describeMigration).join(", ")}`,
    );
  },
};

/**
 * One line of `status`'s "Recent attempts". A deploy that succeeded with no
 * range found nothing pending: it is recorded (it ran the checks) but says so,
 * so it doesn't read as a deploy whose migrations are missing. The migrations
 * the target records as this attempt's (`recorded`) that ran as a Recovery
 * are named: `migration 4 (Recovery 1)`, `migrations 3-5 (migration 4 as
 * Recovery 1)`. A failed attempt, or one whose rows a later rebuild replaced,
 * records none.
 */
function describeAttempt(
  attempt: AttemptRecord,
  recorded: readonly RecordedMigration[],
): string {
  const recoveries = recorded.filter(
    (migration) =>
      migration.attemptId === attempt.id && migration.recovery !== undefined,
  );
  const variants =
    recoveries.length === 0
      ? ""
      : attempt.fromMigration === attempt.toMigration
        ? ` (Recovery ${recoveries[0]?.recovery})`
        : ` (${recoveries.map((m) => `migration ${m.number} as Recovery ${m.recovery}`).join(", ")})`;
  const range =
    attempt.fromMigration === undefined
      ? attempt.command === "deploy" && attempt.outcome === "succeeded"
        ? ", nothing to deploy,"
        : ""
      : attempt.fromMigration === attempt.toMigration
        ? ` migration ${attempt.fromMigration}${variants}`
        : ` migrations ${attempt.fromMigration}-${attempt.toMigration}${variants}`;
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
  recoveryCommand,
  markCommand,
  disposableCommand,
  deployDraftCommand,
  rebuildCommand,
];
