// `validate [--strict]`: database-free checks for the pre-commit hook.
// Errors: the migrations index, folder names and numbering, content hashes
// and the hash chain. Warnings: an unfinalized draft, and desired-schema
// changes not yet drafted. `strict` turns warnings into failures.
//
// Read-only state: git does not store it, so a fresh checkout has writable
// finalized files. A writable file whose migration still verifies is made
// read-only again and listed in `readOnlyRestored`; integrity itself rests
// on the hashes, which catch any edit.
import { join } from "node:path";
import {
  InvalidEncodingError,
  ValidationFailedError,
  type ValidationProblem,
} from "../errors.ts";
import type { Project } from "../project.ts";
import { readDesiredSchemaFiles } from "../store/desired-schema.ts";
import { readDraft } from "../store/draft.ts";
import { desiredSchemaHash } from "../store/hashing.ts";
import { checkMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  makeReadOnly,
  snapshotFolderName,
  writableFiles,
} from "../store/migrations.ts";

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
  };
}
