// `validate [--strict] [--allow-draft]`: database-free checks for the
// pre-commit hook and CI.
// Errors: the migrations index, folder names and numbering, content hashes
// and the hash chains (migrations and their Recoveries); rule violations in
// the desired schema, in every finalized migration's and Recovery's
// deploy-time files and seed data, and in the draft's; a Recovery draft
// whose schema change is no longer its migration's.
// Warnings: an unfinalized draft, a file in the draft folder that a draft
// doesn't hold (store/draft.ts), and desired-schema changes not yet drafted.
// Notices: a migration whose schema change was edited by hand
// (store/hand-edit.ts). Never a failure, even under `strict`: the migration
// was rehearsed, and its HAND-EDITED.md is for reviewers.
// `strict` turns warnings into failures.
// The first and the last are a draft in progress (the codes in `draftInProgress`):
// `allowDraft` keeps them warnings even under `strict`, so the template's
// hook lets a draft be committed for review while CI (`--strict` alone)
// refuses it until it is finalized. Any other warning, such as one a later
// check adds, still fails under `strict`.
//
// Read-only state: git does not store it, so a fresh checkout has writable
// finalized files. A writable file whose migration still verifies is made
// read-only again and listed in `readOnlyRestored`; integrity itself rests
// on the hashes, which catch any edit.

import { join, posix } from "node:path";
import { SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import { readSeededUnit, seededFiles } from "../rehearsal/seed-data.ts";
import {
  describeViolation,
  desiredSchemaAnalysis,
  type Override,
  type RuleViolation,
  type SqlFile,
  SqlRuleViolationError,
} from "../sql-analysis/index.ts";
import {
  readDesiredSchema,
  readDesiredSchemaFiles,
} from "../store/desired-schema.ts";
import {
  type DraftMetadata,
  readDraft,
  unknownDraftFiles,
} from "../store/draft.ts";
import { handEditReportFileName } from "../store/hand-edit.ts";
import { desiredSchemaHash, InvalidEncodingError } from "../store/hashing.ts";
import {
  checkMigrations,
  type IntegrityReport,
  summarise,
  type ValidationProblem,
} from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  exists,
  makeReadOnly,
  schemaChangeFileName,
  snapshotFolderName,
  writableFiles,
} from "../store/migrations.ts";
import { analyseReplayUnit } from "./check-rules.ts";
import { RecoverySchemaChangeEditedError } from "./recovery.ts";
import { requireOriginalSchemaChange } from "./rehearse.ts";

export interface ValidateOptions {
  /** Fail on warnings too (the pre-commit hook and CI use this). */
  strict?: boolean;
  /**
   * Never fail on a draft in progress: an unfinalized draft and undrafted
   * desired-schema changes stay warnings, even under `strict`.
   */
  allowDraft?: boolean;
}

/** The warnings `allowDraft` never fails on: a draft in progress. */
const draftInProgress: ReadonlySet<string> = new Set([
  "unfinalized-draft",
  "undrafted-changes",
]);

export interface ValidationReport {
  /** How many finalized migrations were checked. */
  readonly migrations: number;
  /** How many finalized Recoveries (of all migrations) were checked. */
  readonly recoveries: number;
  /** Warnings and notices found (a passing report never has errors). */
  readonly problems: readonly ValidationProblem[];
  /** Project-relative paths of finalized files that were writable and were made read-only again. */
  readonly readOnlyRestored: readonly string[];
  /**
   * Every override marker accepted: in the finalized migrations, the desired
   * schema and the draft, in that order. Paths are project-relative.
   */
  readonly overrides: readonly Override[];
}

/** Resolves to the report when validation passes; throws ValidationFailedError otherwise. */
export async function validate(
  project: Project,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const strict = options.strict ?? false;
  const allowDraft = options.allowDraft ?? false;
  const { root, paths } = project;
  const integrity = await checkMigrations(root, paths);
  const problems: ValidationProblem[] = [...integrity.problems];
  const display = (absolute: string) => projectRelative(root, absolute);
  for (const migration of integrity.migrations) {
    const report = join(migration.path, handEditReportFileName);
    if (await exists(report)) {
      problems.push({
        severity: "notice",
        code: "hand-edited-schema-change",
        message: `Migration ${migration.folder}'s schema change was edited by hand after draft generated it: ${display(report)} shows the diff`,
        path: display(report),
      });
    }
  }
  const warn = (code: string, message: string, path: string) => {
    problems.push({ severity: "warning", code, message, path });
  };

  const draft = await readDraft(root, paths);
  // A Recovery draft (of migration N) never covers desired-schema changes.
  const recoveryOf =
    draft?.recoveryOf === undefined
      ? undefined
      : integrity.migrations[draft.recoveryOf - 1];
  if (draft !== undefined) {
    warn(
      "unfinalized-draft",
      `Draft ${draft.name}${draft.recoveryOf === undefined ? "" : ` (a Recovery of migration ${recoveryOf?.folder ?? draft.recoveryOf})`} is not finalized yet`,
      display(paths.draft),
    );
  }
  for (const unknown of await unknownDraftFiles(root, paths)) {
    warn("unknown-draft-file", unknown.message, unknown.file);
  }
  if (draft?.recoveryOf !== undefined) {
    problems.push(
      ...(await recoveryDraftProblems(project, draft.recoveryOf, integrity)),
    );
  }
  const covering = draft?.recoveryOf === undefined ? draft : undefined;
  try {
    const current = desiredSchemaHash(
      await readDesiredSchemaFiles(root, paths.desiredSchema),
    );
    const newest = integrity.migrations.at(-1);
    const where = display(paths.desiredSchema);
    if (covering !== undefined) {
      if (covering.desiredSchemaHash !== current) {
        warn(
          "undrafted-changes",
          `The desired schema has changed since draft ${covering.name} was generated; run draft again`,
          where,
        );
      }
    } else if (newest === undefined) {
      if (current !== desiredSchemaHash([])) {
        warn(
          "undrafted-changes",
          "The desired schema has no migration or draft yet; run draft",
          where,
        );
      }
    } else if (integrity.problems.length === 0) {
      const snapshot = desiredSchemaHash(
        await readDesiredSchemaFiles(
          root,
          join(newest.path, snapshotFolderName),
        ),
      );
      if (snapshot !== current) {
        warn(
          "undrafted-changes",
          `The desired schema differs from migration ${newest.folder}'s snapshot and no draft covers it; run draft`,
          where,
        );
      }
    }
  } catch (error) {
    if (!(error instanceof InvalidEncodingError)) {
      throw error;
    }
    problems.push({
      severity: "error",
      code: "invalid-encoding",
      message: error.message,
      path: error.file,
    });
  }

  const rules = await ruleProblems(project, draft, integrity);
  problems.push(...rules.problems);

  const fails = (problem: ValidationProblem) =>
    problem.severity === "error" ||
    (problem.severity === "warning" &&
      strict &&
      !(allowDraft && draftInProgress.has(problem.code)));
  if (problems.some(fails)) {
    throw new ValidationFailedError(problems, problems.filter(fails), strict);
  }

  // Recoveries live inside their migration's folder, so this covers them.
  const readOnlyRestored: string[] = [];
  for (const migration of integrity.migrations) {
    const writable = await writableFiles(migration.path);
    if (writable.length > 0) {
      await makeReadOnly(migration.path);
      readOnlyRestored.push(
        ...writable.map((path) =>
          projectRelative(root, join(migration.path, path)),
        ),
      );
    }
  }
  return {
    migrations: integrity.migrations.length,
    recoveries: integrity.migrations.reduce(
      (count, migration) => count + migration.recoveries.length,
      0,
    ),
    problems,
    readOnlyRestored,
    overrides: rules.overrides,
  };
}

/** A Recovery draft must recover an existing migration and keep its schema change. */
async function recoveryDraftProblems(
  project: Project,
  number: number,
  integrity: IntegrityReport,
): Promise<ValidationProblem[]> {
  const migration = integrity.migrations[number - 1];
  const path = projectRelative(project.root, project.paths.draftMetadata);
  if (migration === undefined) {
    return [
      {
        severity: "error",
        code: "unknown-migration",
        message: `${path} recovers migration ${number}, which the project doesn't have`,
        path,
      },
    ];
  }
  try {
    await requireOriginalSchemaChange(project, migration);
    return [];
  } catch (error) {
    if (!(error instanceof RecoverySchemaChangeEditedError)) {
      throw error;
    }
    return [
      {
        severity: "error",
        code: error.code,
        message: error.message,
        path: error.file,
      },
    ];
  }
}

/**
 * Rule violations as errors, and the overrides accepted: every finalized
 * migration's and Recovery's deploy-time files and seed data (only when the
 * migrations verify, so the files are the ones finalized), the desired
 * schema, and the draft's files. A Recovery runs its migration's schema
 * change, which is checked (and its overrides listed) with the migration.
 */
async function ruleProblems(
  project: Project,
  draft: DraftMetadata | undefined,
  integrity: IntegrityReport,
): Promise<{ problems: ValidationProblem[]; overrides: Override[] }> {
  const { root, paths, config } = project;
  const violations: RuleViolation[] = [];
  const overrides: Override[] = [];
  const problems: ValidationProblem[] = [];
  const rules = {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
  };
  const collect = (
    analysis: {
      violations: readonly RuleViolation[];
      overrides: readonly Override[];
    },
    include: (file: string) => boolean = () => true,
  ) => {
    violations.push(...analysis.violations.filter(({ file }) => include(file)));
    overrides.push(...analysis.overrides.filter(({ file }) => include(file)));
  };
  const notSchemaChange = (file: string) =>
    posix.basename(file) !== schemaChangeFileName;
  try {
    const snapshot = (path: string) =>
      readDesiredSchema(root, join(path, snapshotFolderName));
    let previous: SqlFile[] = [];
    // The snapshots on either side of each migration, for a Recovery draft.
    const around = new Map<number, { before: SqlFile[]; after: SqlFile[] }>();
    if (integrity.problems.length === 0) {
      for (const migration of integrity.migrations) {
        const own = await snapshot(migration.path);
        const context = { ...rules, schemas: [previous, own] };
        collect(
          await analyseReplayUnit(
            seededFiles(
              await readSeededUnit(root, migration.path, migration.folder),
            ),
            context,
          ),
        );
        for (const recovery of migration.recoveries) {
          collect(
            await analyseReplayUnit(
              seededFiles(
                await readSeededUnit(
                  root,
                  recovery.path,
                  `${migration.folder} ${recovery.folder}`,
                  migration.path,
                ),
              ),
              context,
            ),
            notSchemaChange,
          );
        }
        around.set(migration.number, { before: previous, after: own });
        previous = own;
      }
    }
    const desired = await readDesiredSchema(root, paths.desiredSchema);
    try {
      collect({
        violations: [],
        ...(await desiredSchemaAnalysis(desired, rules)),
      });
    } catch (error) {
      if (!(error instanceof SqlRuleViolationError)) {
        throw error;
      }
      violations.push(...error.violations);
    }
    // A draft is checked between the newest snapshot and the desired schema;
    // a Recovery draft against its migration's snapshots. A Recovery draft's
    // copy of the schema change is the migration's (checked with it) unless
    // edited, which recoveryDraftProblems reports.
    const draftSides =
      draft?.recoveryOf === undefined
        ? { before: previous, after: desired }
        : around.get(draft.recoveryOf);
    if (draft !== undefined && draftSides !== undefined) {
      collect(
        await analyseReplayUnit(
          seededFiles(
            await readSeededUnit(root, paths.draft, `draft ${draft.name}`),
          ),
          { ...rules, schemas: [draftSides.before, draftSides.after] },
        ),
        draft.recoveryOf === undefined ? undefined : notSchemaChange,
      );
    }
  } catch (error) {
    if (!(error instanceof InvalidEncodingError)) {
      throw error;
    }
    // The desired-schema check above already reports this file's encoding.
    if (!error.file.startsWith(projectRelative(root, paths.desiredSchema))) {
      problems.push({
        severity: "error",
        code: "invalid-encoding",
        message: error.message,
        path: error.file,
      });
    }
  }
  for (const violation of violations) {
    problems.push({
      severity: "error",
      code: "sql-rule-violation",
      message: describeViolation(violation),
      path: violation.file,
      line: violation.line,
      rule: violation.rule,
    });
  }
  return { problems, overrides };
}

/**
 * `validate` found errors, or warnings under `--strict`. The message counts
 * and leads with the findings that fail the run: not the warnings that
 * don't (without `--strict`, or a draft in progress with `--allow-draft`),
 * though `problems` lists them too.
 */
export class ValidationFailedError extends SuperDeployError {
  readonly code = "validation-failed";
  /** Every finding, errors and warnings, in report order. */
  readonly problems: readonly ValidationProblem[];
  readonly strict: boolean;

  constructor(
    problems: readonly ValidationProblem[],
    failing: readonly ValidationProblem[],
    strict: boolean,
  ) {
    const errors = failing.filter((p) => p.severity === "error").length;
    const warnings = failing.length - errors;
    const counts = [
      errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : "",
      warnings > 0
        ? `${warnings} warning${warnings === 1 ? "" : "s"}${strict ? " (--strict)" : ""}`
        : "",
    ]
      .filter((part) => part !== "")
      .join(", ");
    super(`Validation failed with ${counts}: ${summarise(failing)}`);
    this.problems = problems;
    this.strict = strict;
  }
}
