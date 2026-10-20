// `init --adopt <target>`: bring an existing database under management. Its
// managed schema becomes the project's desired schema and migration
// 00001-adopt, which is recorded on the target as marked (its scripts never
// run there) after `mark`'s replica check.
//
// Adoption needs the target's connection, so it runs in a project that is
// already initialised (`init`, then the target added to
// super-deploy.config.ts) and still empty: no finalized migrations, no draft
// and no desired-schema SQL files. The target must record no migrations.
//
// Steps, and what each one guarantees:
//   1. Read the target (never writing to it): pg-delta generates the
//      statements that build it from nothing, on a throwaway database with
//      the target's locale; the managed schema's statements become
//      desired-schema files (sql-analysis/adoption.ts).
//   2. Refuse, listing everything at once, if anything there is unsupported:
//      objects a desired schema can't create at all (the catalog check's
//      `other` kind), every desired-schema rule (or ordering) violation in
//      the generated files, and, when those pass, every object the files
//      don't reproduce exactly (loaded on a throwaway database and compared
//      with the target like the drift check). Nothing is written before
//      this passes.
//      Statements that break only risk rules (dynamic SQL, denylisted
//      calls) are the exception when the caller answers override reasons
//      (`overrideReason`): the checks treat them as marked, and once nothing
//      else is refused, and the target's connection is closed, a reason is
//      asked for each. It goes into an override marker above the statement
//      (an empty answer cancels). Without the callback they are refused.
//   3. Write the files, then the ordinary `draft` (named `adopt`) and
//      `finalize`, which rehearse migration 1 against the desired schema.
//   4. Under the target lock, `markNextPending` (deploy/mark.ts) runs mark's
//      replica check and records migration 1 as marked. No guard: like
//      deploy, adoption may run in CI.
// If steps 3-4 fail, every file adoption wrote is removed again, so the
// project is as it was; except when the target's COMMIT outcome is unknown
// (the record may be there: the next status or deploy settles it).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import { withLockedTarget } from "../deploy/engine.ts";
import { readRecordedMigrations } from "../deploy/history.ts";
import { markNextPending, readMarkableMigrations } from "../deploy/mark.ts";
import {
  connectTarget,
  resolveTarget,
  targetDatabaseRequest,
} from "../deploy/target.ts";
import { differ } from "../differ/index.ts";
import {
  AdoptCancelledError,
  AdoptConflictError,
  AdoptUnsupportedError,
  CommitOutcomeUnknownError,
  SqlRuleViolationError,
  type UnsupportedObject,
} from "../errors.ts";
import { throwIfInterrupted } from "../interruption.ts";
import type { Project } from "../project.ts";
import type { AskOverrideReason, OverrideNeeded } from "../questions.ts";
import {
  ensureManagedSchema,
  loadDesiredSchema,
  withThrowawayDatabase,
} from "../rehearsal/throwaway.ts";
import {
  type AdoptedFile,
  adoptedDesiredSchema,
  catalogObjectFinding,
  desiredSchemaAnalysis,
  type OverrideCandidate,
  oneLine,
  overrideCandidates,
  type ParsedStatement,
  type SqlFile,
  withOverrideMarkers,
} from "../sql-analysis/index.ts";
import type { Override } from "../sql-analysis/overrides.ts";
import { isSqlFile } from "../store/desired-schema.ts";
import { projectRelative } from "../store/layout.ts";
import {
  exists,
  indexFileName,
  listFiles,
  makeWritable,
  readIndex,
} from "../store/migrations.ts";
import { catalogFacts } from "../verification/catalog.ts";
import {
  type DriftChange,
  driftBetween,
  targetTimeouts,
} from "../verification/drift.ts";
import { draft } from "./draft.ts";
import { finalize } from "./finalize.ts";

/** The draft name, so migration 1 is `00001-adopt`. */
const migrationName = "adopt";

export interface AdoptOptions {
  /** The target's name in config. */
  target: string;
  /**
   * Asked for the reason to write into the override marker of each object
   * that breaks only risk rules, once nothing else is refused. Without it
   * such objects are refused like anything else V1 doesn't support.
   */
  overrideReason?: AskOverrideReason | undefined;
}

export interface AdoptResult {
  readonly target: string;
  /** The attempt that recorded migration 1 on the target. */
  readonly attemptId: number;
  /** Migration 1, now recorded on the target as marked. */
  readonly migration: {
    readonly number: number;
    readonly name: string;
    /** `00001-adopt`. */
    readonly folder: string;
    /** Absolute path of the migration folder. */
    readonly path: string;
  };
  /** The desired-schema files written, project-relative, in the order written. */
  readonly files: readonly string[];
  /** Migration 1's overrides, as in its metadata (paths relative to its folder). */
  readonly overrides: readonly Override[];
}

/**
 * Refuses with UnknownTargetError, AdoptConflictError (the project or the
 * target isn't empty) or AdoptUnsupportedError (listing everything V1
 * doesn't support) before writing anything.
 */
export async function adopt(
  project: Project,
  options: AdoptOptions,
): Promise<AdoptResult> {
  const target = resolveTarget(project, options.target);
  await requireEmptyProject(project, target.name);
  const read = await readTarget(
    project,
    target,
    options.overrideReason !== undefined,
  );
  const reasons =
    options.overrideReason === undefined
      ? []
      : await askReasons(
          project,
          target.name,
          read.candidates,
          options.overrideReason,
        );
  const files = markOverrides(project, read.files, read.candidates, reasons);
  throwIfInterrupted(project.signal);

  const index = await readFile(
    join(project.paths.migrations, indexFileName),
    "utf8",
  ).catch(() => undefined);
  const written = await writeAdoptedFiles(project, files, index);
  try {
    await draft(project, { name: migrationName });
    const finalized = await finalize(project);
    const migrations = await readMarkableMigrations(project);
    const attemptId = await withLockedTarget(
      project,
      target.name,
      "init --adopt",
      async (locked) => {
        await markNextPending(project, locked, migrations);
        return locked.attempt.id;
      },
    );
    return {
      target: target.name,
      attemptId,
      migration: {
        number: finalized.number,
        name: finalized.name,
        folder: finalized.folder,
        path: finalized.path,
      },
      files: written.map((path) => projectRelative(project.root, path)),
      overrides: finalized.metadata.overrides,
    };
  } catch (error) {
    if (!(error instanceof CommitOutcomeUnknownError)) {
      await undoAdoption(project, written, index);
    }
    throw error;
  }
}

async function requireEmptyProject(
  project: Project,
  target: string,
): Promise<void> {
  const { root, paths } = project;
  const reasons: string[] = [];
  const index = await readIndex(paths);
  const migrationFiles = (await listFiles(paths.migrations)).filter(
    (path) => path !== indexFileName,
  );
  if (!index.ok || index.entries.length > 0 || migrationFiles.length > 0) {
    reasons.push(
      `the project already has migrations in ${projectRelative(root, paths.migrations)}`,
    );
  }
  if (await exists(paths.draft)) {
    reasons.push(
      `the project already has a draft in ${projectRelative(root, paths.draft)}`,
    );
  }
  const desired = (await listFiles(paths.desiredSchema)).filter(isSqlFile);
  if (desired.length > 0) {
    reasons.push(
      `the desired schema already has ${desired.map((path) => projectRelative(root, join(paths.desiredSchema, path))).join(", ")}`,
    );
  }
  if (reasons.length > 0) {
    throw new AdoptConflictError(target, reasons);
  }
}

/**
 * Steps 1 and 2: the desired-schema files for the target's managed schema,
 * without override markers, or AdoptUnsupportedError. Only reads the
 * target. With `markable`, the statements that break only risk rules are
 * checked as if marked and returned as `candidates` (in file order), else
 * refused.
 */
async function readTarget(
  project: Project,
  target: ResolvedTarget,
  markable: boolean,
): Promise<{ files: AdoptedFile[]; candidates: OverrideCandidate[] }> {
  const { config } = project;
  const session = await connectTarget(target);
  try {
    const recorded = await readRecordedMigrations(
      session,
      config.historySchema,
    );
    if (recorded.length > 0) {
      throw new AdoptConflictError(target.name, [
        `it already records ${recorded.length} migration${recorded.length === 1 ? "" : "s"} in its history schema "${config.historySchema}"`,
      ]);
    }
    // The differ reads definitions that wait for table locks: never longer
    // than the target allows.
    await session.execute(
      targetTimeouts(target)
        .map((statement) => statement.replace(/^SET LOCAL /, "SET "))
        .join(";\n"),
    );
    const request = await targetDatabaseRequest(session);
    const statements = await withThrowawayDatabase(
      config.rehearsal,
      request,
      async (empty) => {
        await ensureManagedSchema(empty, config.managedSchema);
        return differ.diff(empty, session);
      },
    );
    const files = await adoptedDesiredSchema(
      statements.map((statement) => statement.sql),
      {
        managedSchema: config.managedSchema,
        schemaRoles: await schemaRoles(session, config.managedSchema),
        header: [
          `Adopted from target ${target.name} by super-deploy init --adopt.`,
          "This is the desired schema now: change it, then run draft.",
        ],
      },
    );

    const unsupported = (
      await catalogFacts(session, config.managedSchema, {
        settings: targetTimeouts(target),
      })
    )
      .filter((fact) => fact.kind === "other")
      .map((fact): UnsupportedObject => {
        const { rule, message } = catalogObjectFinding(fact);
        return { object: fact.object, rule, reason: message };
      });
    const candidates = markable
      ? await overrideCandidates(sqlFiles(project, files), {
          managedSchema: config.managedSchema,
          externalSchemas: config.externalSchemas,
        })
      : [];
    const analysed = await analyse(
      project,
      markOverrides(
        project,
        files,
        candidates,
        candidates.map(() => "asked once nothing else is refused"),
      ),
    );
    unsupported.push(...analysed.unsupported);
    if (unsupported.length > 0) {
      throw new AdoptUnsupportedError(target.name, unsupported);
    }

    const differences = await withThrowawayDatabase(
      config.rehearsal,
      request,
      async (desired) => {
        await loadDesiredSchema(
          desired,
          analysed.statements,
          config.managedSchema,
          config.externalSchemas,
        );
        return driftBetween(session, desired, config.managedSchema, {
          target,
        });
      },
    );
    if (differences.length > 0) {
      throw new AdoptUnsupportedError(
        target.name,
        differences.map((drifted) => ({
          object: drifted.object,
          rule: "not-reproduced",
          reason: `${notReproduced[drifted.change]}: ${drifted.differences.join("; ")}`,
        })),
      );
    }
    return { files, candidates };
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * The managed schema's owner and the deploy role: their privileges on the
 * schema are target setup, not the desired schema's (verification/catalog.ts).
 */
async function schemaRoles(
  session: Session,
  managedSchema: string,
): Promise<string[]> {
  const { rows } = await session.query<{ role: string }>(
    `SELECT current_user AS role
     UNION SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = $1`,
    [managedSchema],
  );
  return rows.map((row) => row.role);
}

/** One reason per candidate, in order; an empty answer cancels. */
async function askReasons(
  project: Project,
  target: string,
  candidates: readonly OverrideCandidate[],
  ask: AskOverrideReason,
): Promise<string[]> {
  const needed: OverrideNeeded[] = candidates.map((candidate) => ({
    object: candidate.object,
    rules: candidate.rules,
    findings: candidate.violations
      .map(({ rule, message }) => ({ rule, message }))
      .filter(
        (finding, at, all) =>
          all.findIndex(
            (other) =>
              other.rule === finding.rule && other.message === finding.message,
          ) === at,
      ),
    file: candidate.file,
  }));
  const reasons: string[] = [];
  for (const [index, item] of needed.entries()) {
    const answer = await ask({
      kind: "override-reason",
      command: "init --adopt",
      target,
      ...item,
      message: `Reason to override ${item.rules.join(", ")} for ${item.object}?`,
      needed,
      index,
    });
    throwIfInterrupted(project.signal);
    const reason = oneLine(answer ?? "");
    if (reason === "") {
      throw new AdoptCancelledError(target, item.object);
    }
    reasons.push(reason);
  }
  return reasons;
}

/** The files with a marker above each candidate (`reasons` in the same order). */
function markOverrides(
  project: Project,
  files: readonly AdoptedFile[],
  candidates: readonly OverrideCandidate[],
  reasons: readonly string[],
): AdoptedFile[] {
  const paths = sqlFiles(project, files).map((file) => file.path);
  return files.map((file, index) => {
    const markers = candidates.flatMap((candidate, at) =>
      candidate.file === paths[index]
        ? [{ line: candidate.line, reason: reasons[at] ?? "" }]
        : [],
    );
    return markers.length === 0
      ? file
      : { ...file, text: withOverrideMarkers(file.text, markers) };
  });
}

/** The generated files as the rules see them: project-relative paths. */
function sqlFiles(project: Project, files: readonly AdoptedFile[]): SqlFile[] {
  return files.map((file) => ({
    path: projectRelative(
      project.root,
      join(project.paths.desiredSchema, file.path),
    ),
    text: file.text,
  }));
}

/** Why a drifted object isn't reproduced by the generated desired schema. */
const notReproduced: Readonly<Record<DriftChange, string>> = {
  extra: "The desired schema generated from the target can't create it",
  missing:
    "The desired schema generated from the target creates it, but the target has no such object",
  changed:
    "The desired schema generated from the target creates it differently",
};

/** The generated files through the desired-schema rules and ordering. */
async function analyse(
  project: Project,
  files: readonly AdoptedFile[],
): Promise<{
  statements: readonly ParsedStatement[];
  unsupported: UnsupportedObject[];
}> {
  const { config } = project;
  try {
    const { statements } = await desiredSchemaAnalysis(
      sqlFiles(project, files),
      {
        managedSchema: config.managedSchema,
        externalSchemas: config.externalSchemas,
      },
    );
    return { statements, unsupported: [] };
  } catch (error) {
    if (!(error instanceof SqlRuleViolationError)) {
      throw error;
    }
    return {
      statements: [],
      unsupported: error.violations.map((violation) => ({
        object: firstLine(violation.statement) || violation.file,
        rule: violation.rule,
        reason: violation.message,
      })),
    };
  }
}

function firstLine(statement: string): string {
  const line = statement.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Writes the files (absolute paths returned); never overwrites one. */
async function writeAdoptedFiles(
  project: Project,
  files: readonly AdoptedFile[],
  index: string | undefined,
): Promise<string[]> {
  const written: string[] = [];
  await mkdir(project.paths.desiredSchema, { recursive: true });
  try {
    for (const file of files) {
      const path = join(project.paths.desiredSchema, file.path);
      await writeFile(path, file.text, { flag: "wx" });
      written.push(path);
    }
  } catch (error) {
    await undoAdoption(project, written, index);
    throw error;
  }
  return written;
}

/**
 * Puts the project back as adoption found it: without the files adoption
 * wrote, a draft or any migration folder (it had none), and with its index
 * as it was (`index`: its text, or undefined if there was none).
 */
async function undoAdoption(
  project: Project,
  written: readonly string[],
  index: string | undefined,
): Promise<void> {
  const { paths } = project;
  for (const path of written) {
    await rm(path, { force: true });
  }
  await rm(paths.draft, { recursive: true, force: true });
  const folders = new Set(
    (await listFiles(paths.migrations))
      .filter((path) => path !== indexFileName)
      .map((path) => path.split("/")[0] as string),
  );
  for (const folder of folders) {
    await makeWritable(join(paths.migrations, folder));
    await rm(join(paths.migrations, folder), { recursive: true, force: true });
  }
  const indexPath = join(paths.migrations, indexFileName);
  if (index === undefined) {
    await rm(indexPath, { force: true });
  } else {
    await writeFile(indexPath, index);
  }
}
