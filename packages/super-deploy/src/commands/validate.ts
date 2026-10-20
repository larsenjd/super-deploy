// `validate [--strict]`: database-free checks for the pre-commit hook.
// Errors: the migrations index, folder names and numbering, content hashes
// and the hash chain; rule violations in the desired schema, in every
// finalized migration's deploy-time files and seed data, and in the draft's.
// Warnings: an unfinalized draft, and desired-schema
// changes not yet drafted. `strict` turns warnings into failures.
//
// Read-only state: git does not store it, so a fresh checkout has writable
// finalized files. A writable file whose migration still verifies is made
// read-only again and listed in `readOnlyRestored`; integrity itself rests
// on the hashes, which catch any edit.
import { join } from "node:path";
import {
  InvalidEncodingError,
  type RuleViolation,
  SqlRuleViolationError,
  ValidationFailedError,
  type ValidationProblem,
} from "../errors.ts";
import type { Project } from "../project.ts";
import { readSeededUnit, seededFiles } from "../rehearsal/seed-data.ts";
import {
  desiredSchemaAnalysis,
  type Override,
  type SqlFile,
} from "../sql-analysis/index.ts";
import {
  readDesiredSchema,
  readDesiredSchemaFiles,
} from "../store/desired-schema.ts";
import { readDraft } from "../store/draft.ts";
import { desiredSchemaHash } from "../store/hashing.ts";
import { checkMigrations, type IntegrityReport } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  makeReadOnly,
  snapshotFolderName,
  writableFiles,
} from "../store/migrations.ts";
import { analyseReplayUnit } from "./check-rules.ts";

export interface ValidateOptions {
  /** Fail on warnings too (the pre-commit hook uses this). */
  strict?: boolean;
}

export interface ValidationReport {
  /** How many finalized migrations were checked. */
  readonly migrations: number;
  /** Warnings found (a passing report never has errors). */
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
  const { root, paths } = project;
  const integrity = await checkMigrations(root, paths);
  const problems: ValidationProblem[] = [...integrity.problems];
  const display = (absolute: string) => projectRelative(root, absolute);
  const warn = (code: string, message: string, path: string) => {
    problems.push({ severity: "warning", code, message, path });
  };

  const draft = await readDraft(paths);
  if (draft !== undefined) {
    warn(
      "unfinalized-draft",
      `Draft ${draft.name} is not finalized yet`,
      display(paths.draft),
    );
  }
  try {
    const current = desiredSchemaHash(
      await readDesiredSchemaFiles(root, paths.desiredSchema),
    );
    const newest = integrity.migrations.at(-1);
    const where = display(paths.desiredSchema);
    if (draft !== undefined) {
      if (draft.desiredSchemaHash !== current) {
        warn(
          "undrafted-changes",
          `The desired schema has changed since draft ${draft.name} was generated; run draft again`,
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

  const rules = await ruleProblems(project, draft?.name, integrity);
  problems.push(...rules.problems);

  if (problems.some((p) => p.severity === "error" || strict)) {
    throw new ValidationFailedError(problems, strict);
  }

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
    problems,
    readOnlyRestored,
    overrides: rules.overrides,
  };
}

/**
 * Rule violations as errors, and the overrides accepted: every finalized
 * migration's deploy-time files and seed data (only when the migrations
 * verify, so the files are the ones finalized), the desired schema, and the
 * draft's files.
 */
async function ruleProblems(
  project: Project,
  draftName: string | undefined,
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
  const collect = (analysis: {
    violations: readonly RuleViolation[];
    overrides: readonly Override[];
  }) => {
    violations.push(...analysis.violations);
    overrides.push(...analysis.overrides);
  };
  try {
    const snapshot = (path: string) =>
      readDesiredSchema(root, join(path, snapshotFolderName));
    let previous: SqlFile[] = [];
    if (integrity.problems.length === 0) {
      for (const migration of integrity.migrations) {
        const own = await snapshot(migration.path);
        collect(
          await analyseReplayUnit(
            seededFiles(
              await readSeededUnit(root, migration.path, migration.folder),
            ),
            { ...rules, schemas: [previous, own] },
          ),
        );
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
    if (draftName !== undefined) {
      collect(
        await analyseReplayUnit(
          seededFiles(
            await readSeededUnit(root, paths.draft, `draft ${draftName}`),
          ),
          { ...rules, schemas: [previous, desired] },
        ),
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
      message: `${violation.file}:${violation.line}: ${violation.message} [${violation.rule}]`,
      path: violation.file,
      line: violation.line,
      rule: violation.rule,
    });
  }
  return { problems, overrides };
}
