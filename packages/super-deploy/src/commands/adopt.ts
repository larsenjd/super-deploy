// `init --adopt <target>`: bring an existing database under management. Its
// managed schema becomes the project's desired schema and migration
// 00001-adopt, which is recorded on the target as marked (its scripts never
// run there) after `mark`'s replica check.
//
// Adoption needs the target's connection, so it runs in a project that is
// already initialised (`init`, then the target added to
// super-deploy.config.ts) and still empty: no finalized migrations, no draft
// and no desired-schema SQL files. The target must record no migrations and
// have the managed schema (a missing one is almost always a mistyped
// managedSchema; an existing empty one is adopted), and its deploy role must
// own that schema and everything in it (deploy/ownership.ts) and be able to
// create the history schema if the target has none (deploy/preflight.ts),
// all checked before anything is rehearsed.
//
// Steps, and what each one guarantees:
//   1. Read the target (never writing to it): pg-delta generates the
//      statements that build it from nothing, on a throwaway database with
//      the target's locale; the managed schema's statements become
//      desired-schema files (sql-analysis/adoption.ts). Grants, policies
//      and row-level security stay on the target as they are and are never
//      written (ADR-0006); the result counts the grants and policies.
//   2. Refuse, listing everything at once, if anything there is unsupported:
//      objects a desired schema can't create at all (the catalog check's
//      `other` kind, an extension once for all its members; virtual
//      generated columns, which pg-delta renders STORED; serial columns,
//      once each, though the differ renders a sequence and its OWNED BY),
//      every desired-schema rule (or ordering) violation in
//      the generated files, every statement referencing a declared external
//      schema where PostgreSQL resolves it at CREATE (rehearsals don't
//      contain external schemas, so it could never load), and, when those
//      pass, every object the files don't reproduce exactly (loaded on a
//      throwaway database and compared with the target like the drift
//      check; a statement the throwaway database refuses is listed by its
//      object, never by a file that was never written). Nothing is written
//      before this passes. The refusal's advice follows the rules broken:
//      an undeclared schema in a PL/pgSQL body goes into externalSchemas,
//      risk rules without the callback need a terminal, anything else needs
//      the target changed.
//      Statements that break only risk rules (dynamic SQL, denylisted
//      calls) are the exception when the caller answers override reasons
//      (`overrideReason`): the checks treat them as marked, and once nothing
//      else is refused, and the target's connection is closed, a reason is
//      asked for each. It goes into an override marker above the statement
//      (an empty answer cancels). Without the callback they are refused.
//      With it, a refusal of anything else names them as `overridesNeeded`.
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
import {
  CommitOutcomeUnknownError,
  withLockedTarget,
} from "../deploy/engine.ts";
import { readRecordedMigrations, schemaExists } from "../deploy/history.ts";
import { markNextPending, readMarkableMigrations } from "../deploy/mark.ts";
import { requireOwnership } from "../deploy/ownership.ts";
import { requireHistorySchemaCreatable } from "../deploy/preflight.ts";
import {
  connectTarget,
  resolveTarget,
  targetDatabaseRequest,
  targetTimeouts,
} from "../deploy/target.ts";
import { differ } from "../differ/index.ts";
import { plural, SuperDeployError } from "../errors.ts";
import { throwIfInterrupted } from "../interruption.ts";
import type { Project } from "../project.ts";
import type { AskOverrideReason } from "../questions.ts";
import {
  DesiredSchemaLoadError,
  ensureManagedSchema,
  externalSchemaExplanation,
  loadDesiredSchema,
  withThrowawayDatabase,
} from "../rehearsal/throwaway.ts";
import {
  type AdoptedFile,
  adoptedDesiredSchema,
  adoptedObject,
  catalogObjectFinding,
  desiredSchemaAnalysis,
  externalSchemaReferences,
  isOverridable,
  isSequenceStatement,
  type OverrideCandidate,
  type OverrideNeeded,
  oneLine,
  overrideCandidates,
  type ParsedStatement,
  type RuleContext,
  type SqlFile,
  SqlRuleViolationError,
  serialColumnFinding,
  undeclaredSchemaOf,
  virtualGeneratedColumnFinding,
  withOverrideMarkers,
  withoutOverrideHint,
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
import {
  type CatalogFact,
  catalogFacts,
  isVirtualGeneratedColumn,
} from "../verification/catalog.ts";
import { type DriftChange, driftBetween } from "../verification/drift.ts";
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
  /**
   * What the managed schema has that adoption left on the target as it is,
   * outside super-deploy (ADR-0006).
   */
  readonly leftOnTarget: LeftOnTarget;
}

export interface LeftOnTarget {
  /**
   * Roles granted privileges on the managed schema or an object in it, one
   * per object (or column) and role; not the owner's or the deploy role's
   * own, nor PostgreSQL's defaults.
   */
  readonly grants: number;
  /** Row-level security policies on the managed schema's tables. */
  readonly policies: number;
}

/**
 * Refuses with UnknownTargetError, AdoptConflictError (the project or the
 * target isn't empty, or the target has no managed schema), NotOwnedError
 * (the deploy role doesn't own the managed schema or something in it),
 * HistorySchemaNotCreatableError (the target has no history schema and the
 * deploy role lacks CREATE on the database) or AdoptUnsupportedError
 * (listing everything V1 doesn't support) before writing anything.
 */
export async function adopt(
  project: Project,
  options: AdoptOptions,
): Promise<AdoptResult> {
  const target = resolveTarget(project, options.target);
  await requireEmptyProject(project, target.name);
  const read = await readTarget(project, target, {
    withOverrides: options.overrideReason !== undefined,
  });
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

  const before = await projectBefore(project);
  const written = await writeAdoptedFiles(project, files, before);
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
      leftOnTarget: read.leftOnTarget,
    };
  } catch (error) {
    if (!(error instanceof CommitOutcomeUnknownError)) {
      await undoAdoption(project, written, before);
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
 * target. `withOverrides`: the statements that break only risk rules are
 * checked as if marked and returned as `candidates` (in file order), and an
 * AdoptUnsupportedError lists them as `overridesNeeded`; otherwise they are
 * refused like anything else.
 */
async function readTarget(
  project: Project,
  target: ResolvedTarget,
  { withOverrides }: { withOverrides: boolean },
): Promise<{
  files: AdoptedFile[];
  candidates: OverrideCandidate[];
  leftOnTarget: LeftOnTarget;
}> {
  const { config } = project;
  const context: RuleContext = {
    managedSchema: config.managedSchema,
    externalSchemas: config.externalSchemas,
  };
  const session = await connectTarget(target, project.signal);
  try {
    const recorded = await readRecordedMigrations(
      session,
      config.historySchema,
    );
    if (recorded.length > 0) {
      throw new AdoptConflictError(target.name, [
        `it already records ${plural(recorded.length, "migration")} in its history schema "${config.historySchema}"`,
      ]);
    }
    if (!(await schemaExists(session, config.managedSchema))) {
      throw new AdoptConflictError(target.name, [
        `its managed schema "${config.managedSchema}" does not exist (check managedSchema in super-deploy.config.ts)`,
      ]);
    }
    // Later migrations alter what is adopted: the deploy role must own it.
    await requireOwnership(session, target.name, config.managedSchema);
    // Marking creates the history schema, after everything is written.
    await requireHistorySchemaCreatable(
      session,
      target.name,
      config.historySchema,
    );
    // The differ reads definitions that wait for table locks: never longer
    // than the target allows.
    await session.execute(
      targetTimeouts(target)
        .map((statement) => statement.replace(/^SET LOCAL /, "SET "))
        .join(";\n"),
    );
    const request = await targetDatabaseRequest(session);
    const serials = await serialColumns(session, config.managedSchema);
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
        columnOrder: await columnOrder(session, config.managedSchema),
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
    ).flatMap(unsupportedFact);
    const serial = serialColumnFinding();
    unsupported.push(
      ...serials.map(({ column }) => ({
        object: `serial column ${column}`,
        rule: serial.rule,
        reason: serial.message,
      })),
    );
    const candidates = withOverrides
      ? await overrideCandidates(sqlFiles(project, files), context)
      : [];
    const needed = withOverrides ? overridesNeeded(candidates) : undefined;
    const analysed = await analyse(
      project,
      withCheckingMarkers(project, files, candidates),
      context,
      serials.map((serial) => serial.sequence),
    );
    unsupported.push(...analysed.unsupported);
    unsupported.push(
      ...(
        await externalSchemaReferences(sqlFiles(project, files), context)
      ).map(({ object, schemas }) => ({
        object,
        rule: "outside-managed-schema",
        reason: `It references ${externalSchemaExplanation(schemas)}`,
      })),
    );
    if (unsupported.length > 0) {
      throw new AdoptUnsupportedError(target.name, unsupported, needed);
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
    ).catch((error: unknown) => {
      if (!(error instanceof DesiredSchemaLoadError)) {
        throw error;
      }
      throw new AdoptUnsupportedError(
        target.name,
        [refusedStatement(error, analysed.statements, config.managedSchema)],
        needed,
      );
    });
    if (differences.length > 0) {
      throw new AdoptUnsupportedError(
        target.name,
        differences.map((drifted) => ({
          object: drifted.object,
          rule: "not-reproduced",
          reason: `${notReproduced[drifted.change]}: ${drifted.differences.join("; ")}`,
        })),
        needed,
      );
    }
    return {
      files,
      candidates,
      leftOnTarget: await countLeftOnTarget(session, config.managedSchema),
    };
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * A target object the generated desired schema can't express, refused for
 * what it is: kind `other`, and virtual generated columns (pg-delta renders
 * them STORED, so the rules never see them).
 */
function unsupportedFact(fact: CatalogFact): UnsupportedObject[] {
  const finding =
    fact.kind === "other"
      ? catalogObjectFinding(fact)
      : isVirtualGeneratedColumn(fact)
        ? virtualGeneratedColumnFinding()
        : undefined;
  return finding === undefined
    ? []
    : [{ object: fact.object, rule: finding.rule, reason: finding.message }];
}

/**
 * The grants and policies in the managed schema (LeftOnTarget). A grant is
 * an ACL item that isn't in the object's default ACL (acldefault, plus
 * PUBLIC's USAGE on schema public) and isn't to its owner or the session's
 * role, counted once per object, column and grantee.
 */
async function countLeftOnTarget(
  session: Session,
  managedSchema: string,
): Promise<LeftOnTarget> {
  const { rows } = await session.query<LeftOnTarget>(
    `WITH n AS (SELECT oid, nspowner, nspacl FROM pg_catalog.pg_namespace WHERE nspname = $1),
     acls(object, subobject, owner, acl, defaults) AS (
       -- A new database's public schema also grants PUBLIC USAGE.
       SELECT 'n'::text || n.oid, 0, n.nspowner, n.nspacl,
              pg_catalog.acldefault('n', n.nspowner)
                || CASE WHEN $1 = 'public' THEN ARRAY[pg_catalog.makeaclitem(0, n.nspowner, 'USAGE', false)] ELSE '{}' END
         FROM n
       UNION ALL
       SELECT 'c' || c.oid, 0, c.relowner, c.relacl,
              pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner)
         FROM pg_catalog.pg_class c JOIN n ON c.relnamespace = n.oid
       UNION ALL
       SELECT 'c' || c.oid, a.attnum, c.relowner, a.attacl, NULL
         FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN n ON c.relnamespace = n.oid
       UNION ALL
       SELECT 'p' || p.oid, 0, p.proowner, p.proacl, pg_catalog.acldefault('f', p.proowner)
         FROM pg_catalog.pg_proc p JOIN n ON p.pronamespace = n.oid
       UNION ALL
       SELECT 't' || t.oid, 0, t.typowner, t.typacl, pg_catalog.acldefault('T', t.typowner)
         FROM pg_catalog.pg_type t JOIN n ON t.typnamespace = n.oid
     ),
     grants AS (
       SELECT DISTINCT acls.object, acls.subobject, e.grantee
         FROM acls, pg_catalog.aclexplode(acls.acl) e
        WHERE e.grantee <> acls.owner
          AND e.grantee NOT IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(acls.defaults) d
                           WHERE d.grantee = e.grantee AND d.privilege_type = e.privilege_type)
     )
     SELECT (SELECT count(*) FROM grants)::int AS grants,
            (SELECT count(*) FROM pg_catalog.pg_policy p
               JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN n ON c.relnamespace = n.oid)::int AS policies`,
    [managedSchema],
  );
  return rows[0] ?? { grants: 0, policies: 0 };
}

/** Each table's column names in the managed schema, in the target's order. */
async function columnOrder(
  session: Session,
  managedSchema: string,
): Promise<Record<string, string[]>> {
  const { rows } = await session.query<{ table: string; columns: string[] }>(
    `SELECT c.relname AS table, array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
      WHERE c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
      GROUP BY c.relname`,
    [managedSchema],
  );
  return Object.fromEntries(rows.map((row) => [row.table, row.columns]));
}

/**
 * The managed schema's serial columns: each sequence a table column owns
 * (pg_depend deptype 'a'; an identity column's is 'i'), with the column as
 * `schema.table.column`. OWNED BY keeps both in one schema.
 */
async function serialColumns(
  session: Session,
  managedSchema: string,
): Promise<{ sequence: string; column: string }[]> {
  const { rows } = await session.query<{ sequence: string; column: string }>(
    `SELECT s.relname AS sequence,
            pg_catalog.format('%s.%s.%s', n.nspname, t.relname, a.attname) AS column
       FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_class s ON s.oid = d.objid AND s.relkind = 'S'
       JOIN pg_catalog.pg_namespace n ON n.oid = s.relnamespace
       JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
       JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND d.deptype = 'a' AND n.nspname = $1
      ORDER BY 2`,
    [managedSchema],
  );
  return rows;
}

/** One reason per candidate, in order; an empty answer cancels. */
async function askReasons(
  project: Project,
  target: string,
  candidates: readonly OverrideCandidate[],
  ask: AskOverrideReason,
): Promise<string[]> {
  const needed = overridesNeeded(candidates);
  const reasons: string[] = [];
  for (const [index, item] of needed.entries()) {
    const answer = await ask({
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

/** The candidates as their callers see them: without where markers go. */
function overridesNeeded(
  candidates: readonly OverrideCandidate[],
): OverrideNeeded[] {
  return candidates.map(({ object, rules, findings, file }) => ({
    object,
    rules,
    findings,
    file,
  }));
}

/**
 * The files with a marker above each candidate whose reason says it is only
 * there for the checks: they treat the candidates as marked before any
 * reason is asked. These files are never written.
 */
function withCheckingMarkers(
  project: Project,
  files: readonly AdoptedFile[],
  candidates: readonly OverrideCandidate[],
): AdoptedFile[] {
  return markOverrides(
    project,
    files,
    candidates,
    candidates.map(
      () => "checking only: the reason is asked once nothing else is refused",
    ),
  );
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

/**
 * The generated files through the desired-schema rules and ordering. The
 * statements about `serialSequences` aren't listed: their serial column is.
 */
async function analyse(
  project: Project,
  files: readonly AdoptedFile[],
  context: RuleContext,
  serialSequences: readonly string[],
): Promise<{
  statements: readonly ParsedStatement[];
  unsupported: UnsupportedObject[];
}> {
  try {
    const { statements } = await desiredSchemaAnalysis(
      sqlFiles(project, files),
      context,
    );
    return { statements, unsupported: [] };
  } catch (error) {
    if (!(error instanceof SqlRuleViolationError)) {
      throw error;
    }
    const unsupported: UnsupportedObject[] = [];
    for (const violation of error.violations) {
      if (!(await isSequenceStatement(violation.statement, serialSequences))) {
        unsupported.push({
          object: firstLine(violation.statement) || violation.file,
          rule: violation.rule,
          reason: withoutOverrideHint(violation.message),
        });
      }
    }
    return { statements: [], unsupported };
  }
}

/**
 * A generated statement the throwaway database refused, as an adoption
 * refusal: named by its object, since its file was never written. The
 * statement is the last one in the error's file starting at or above its
 * line.
 */
function refusedStatement(
  error: DesiredSchemaLoadError,
  statements: readonly ParsedStatement[],
  managedSchema: string,
): UnsupportedObject {
  const statement = statements
    .filter(({ file, line }) => file === error.file && line <= error.line)
    .reduce<ParsedStatement | undefined>(
      (last, next) =>
        last === undefined || next.line > last.line ? next : last,
      undefined,
    );
  return {
    object:
      statement === undefined
        ? "the generated desired schema"
        : adoptedObject(statement, managedSchema),
    rule: "not-reproduced",
    reason: `PostgreSQL refused to create it: ${error.detail}${error.hint === undefined ? "" : `. Hint: ${error.hint}`}`,
  };
}

function firstLine(statement: string): string {
  const line = statement.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** What undoing adoption restores: the project as adoption found it. */
interface ProjectBefore {
  /** The migrations index's text, or undefined if there was none. */
  readonly index: string | undefined;
  /** The desired-schema and migrations directories the project lacked. */
  readonly missingDirectories: readonly string[];
}

async function projectBefore(project: Project): Promise<ProjectBefore> {
  const { paths } = project;
  const missingDirectories: string[] = [];
  for (const path of [paths.desiredSchema, paths.migrations]) {
    if (!(await exists(path))) {
      missingDirectories.push(path);
    }
  }
  return {
    index: await readFile(join(paths.migrations, indexFileName), "utf8").catch(
      () => undefined,
    ),
    missingDirectories,
  };
}

/** Writes the files (absolute paths returned); never overwrites one. */
async function writeAdoptedFiles(
  project: Project,
  files: readonly AdoptedFile[],
  before: ProjectBefore,
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
    await undoAdoption(project, written, before);
    throw error;
  }
  return written;
}

/**
 * Puts the project back as adoption found it: without the files adoption
 * wrote, a draft or any migration folder (it had none), with its index as
 * it was, and without the directories adoption created.
 */
async function undoAdoption(
  project: Project,
  written: readonly string[],
  { index, missingDirectories }: ProjectBefore,
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
  for (const path of missingDirectories) {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * `init --adopt` needs a project with no migrations, draft or desired
 * schema yet, and a target that records no migrations and has the managed
 * schema; nothing was written.
 */
export class AdoptConflictError extends SuperDeployError {
  readonly code = "adopt-conflict";
  readonly target: string;
  /** Each reason, e.g. `the project already has a draft`. */
  readonly reasons: readonly string[];

  constructor(target: string, reasons: readonly string[]) {
    super(
      `Cannot adopt target ${target}: ${reasons.join("; ")}. Nothing was written`,
    );
    this.target = target;
    this.reasons = reasons;
  }
}

/** Something V1 doesn't support, found by `init --adopt`. */
export interface UnsupportedObject {
  /**
   * The object as PostgreSQL describes it (`statistics object st`), or the
   * first line of the statement the target's schema needs.
   */
  readonly object: string;
  /** The rule id that refuses it, e.g. `unsupported-object`. */
  readonly rule: string;
  /** Why, in the rules' words. */
  readonly reason: string;
}

/**
 * `init --adopt` found objects in the target's managed schema that V1
 * doesn't support (or can't reproduce); nothing was written anywhere.
 */
export class AdoptUnsupportedError extends SuperDeployError {
  readonly code = "adopt-unsupported";
  readonly target: string;
  /** Every one found; never empty. */
  readonly objects: readonly UnsupportedObject[];
  /**
   * With an override-reason callback: the objects that break only risk
   * rules, whose reasons will be asked once nothing else is refused (they
   * aren't in `objects`). Empty without the callback.
   */
  readonly overridesNeeded: readonly OverrideNeeded[];

  /**
   * What to do before adopting again, each piece once, e.g. `change the
   * target first, then adopt again`. The message ends with these too.
   */
  readonly advice: readonly string[];

  /**
   * The refusal as lines for people, the way the CLI prints it: every object
   * with its rule and reason, then the override reasons still to be asked.
   * `summary` follows them.
   */
  readonly details: readonly string[];

  /** The message without the objects `details` lists: their count and the advice. */
  readonly summary: string;

  /**
   * `overridesNeeded`: undefined when adoption had no override-reason
   * callback, so objects that break only risk rules are among `objects`.
   */
  constructor(
    target: string,
    objects: readonly UnsupportedObject[],
    overridesNeeded?: readonly OverrideNeeded[],
  ) {
    const shown = objects
      .slice(0, 5)
      .map((o) => o.object)
      .join("; ");
    const more = objects.length > 5 ? `; and ${objects.length - 5} more` : "";
    const advice = adoptionAdvice(objects, overridesNeeded !== undefined);
    const needed = overridesNeeded ?? [];
    const things = `${plural(objects.length, "thing")} V1 doesn't support`;
    const refused = `Cannot adopt target ${target}: its managed schema has ${things}`;
    const nothingWritten = `Nothing was written; ${advice.join("; ")}`;
    const later =
      needed.length === 0
        ? []
        : [
            `Once nothing else is refused, adoption will ask an override reason for ${plural(needed.length, "object")} that ${needed.length === 1 ? "breaks" : "break"} only risk rules: ${needed.map((item) => item.object).join(", ")}`,
          ];
    super([`${refused}: ${shown}${more}`, nothingWritten, ...later].join(". "));
    this.target = target;
    this.objects = objects;
    this.overridesNeeded = needed;
    this.advice = advice;
    this.details = [
      `Target ${target} has ${things}:`,
      ...objects.flatMap(({ object, rule, reason }) => [
        `  ${object}`,
        `    ${rule}: ${reason}`,
      ]),
      ...later,
    ];
    this.summary = `${refused}, listed above. ${nothingWritten}`;
  }
}

/**
 * The advice for a refusal, by the rules its objects break: a PL/pgSQL
 * body's reference to an undeclared schema needs it in externalSchemas; a
 * risk rule, without the override-reason callback (`askingOverrides`),
 * needs a terminal; anything else needs the target changed.
 */
function adoptionAdvice(
  objects: readonly UnsupportedObject[],
  askingOverrides: boolean,
): string[] {
  let changeTarget = false;
  let terminal = false;
  const schemas = new Set<string>();
  for (const { rule, reason } of objects) {
    const schema =
      rule === "undeclared-schema" ? undeclaredSchemaOf(reason) : undefined;
    if (schema !== undefined) {
      schemas.add(schema);
    } else if (isOverridable(rule)) {
      terminal ||= !askingOverrides;
    } else {
      changeTarget = true;
    }
  }
  const changeTheTarget = "change the target first, then adopt again";
  const advice = [
    ...(changeTarget ? [changeTheTarget] : []),
    ...(schemas.size > 0
      ? [
          `declare ${[...schemas]
            .sort()
            .map((schema) => `"${schema}"`)
            .join(", ")} in externalSchemas in super-deploy.config.ts`,
        ]
      : []),
    ...(terminal
      ? [
          "run adoption in a terminal to give an override reason for each object that breaks only risk rules",
        ]
      : []),
  ];
  return advice.length > 0 ? advice : [changeTheTarget];
}

/**
 * `init --adopt` asked for an override reason and got none (an empty
 * answer); nothing was written anywhere.
 */
export class AdoptCancelledError extends SuperDeployError {
  readonly code = "adopt-cancelled";
  readonly target: string;
  /** What the reason was asked for, e.g. `function load_staging(text)`. */
  readonly object: string;

  constructor(target: string, object: string) {
    super(
      `Adoption of target ${target} cancelled: no override reason given for ${object}. Nothing was written`,
    );
    this.target = target;
    this.object = object;
  }
}
