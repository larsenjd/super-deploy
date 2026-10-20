// One set of command definitions drives both direct CLI mode (util.parseArgs
// flags) and the interactive menu (ticket 05). Each command's `run` calls the
// exported API function and prints its result.
import { deploy } from "../commands/deploy.ts";
import { draft } from "../commands/draft.ts";
import { finalize } from "../commands/finalize.ts";
import { rehearse } from "../commands/rehearse.ts";
import { status } from "../commands/status.ts";
import { validate } from "../commands/validate.ts";
import type { AttemptRecord } from "../deploy/history.ts";
import { ValidationFailedError, type ValidationProblem } from "../errors.ts";
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

const targetOption: OptionDefinition = {
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
    const result = await deploy(project, { target: String(values.target) });
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
    context.result(
      `Target ${report.target}${report.disposable ? " (disposable)" : ""}: ${plural(report.recorded.length, "migration")} recorded, ${report.pending.length} pending`,
    );
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export const commands: readonly CommandDefinition[] = [
  draftCommand,
  rehearseCommand,
  finalizeCommand,
  validateCommand,
  deployCommand,
  statusCommand,
];
