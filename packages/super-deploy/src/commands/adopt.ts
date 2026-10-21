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
// managedSchema: the refusal lists the target's schemas, and the rename one
// needs whose name isn't lowercase; an existing empty one is adopted, with a
// warning naming the other schemas that hold objects, in case managedSchema
// was forgotten). Its deploy role must
// own that schema and everything in it (deploy/ownership.ts) and be able to
// create the history schema if the target has none (deploy/preflight.ts),
// and a schema with the history schema's name must be super-deploy's or
// empty and the deploy role's (a DBA may pre-create it instead of granting
// CREATE on the database): all are refused in step 2's one refusal, with
// everything unsupported, so a DBA fixes everything in one round.
//
// Steps, and what each one guarantees:
//   1. Read the target (never writing to it): pg-delta generates the
//      statements that build it from nothing, on a throwaway database with
//      the target's locale; the managed schema's statements become
//      desired-schema files (sql-analysis/adoption.ts). Grants, policies
//      and row-level security stay on the target as they are and are never
//      written (ADR-0006); the result counts the grants, policies, tables
//      with row-level security on (and forced), and the deploy role's
//      default privileges, which a new target won't have, and names the
//      objects in other schemas that depend on managed ones (`rebuild`'s
//      `dependentsOutside`): rehearsals lack them, so a migration changing
//      or dropping what they use fails only at deploy.
//      Reading needs no privilege on the managed schema (pg-delta and the
//      catalog check read only the catalogs), so a target whose objects
//      all belong to a superuser is read, and refused once, like any other.
//   2. Refuse, listing everything at once, if the deploy role doesn't own
//      something there (except what is refused as unsupported anyway: no
//      one should re-own an object only to drop it) or can't create the
//      history schema, if a schema of that name isn't one super-deploy can
//      use, or if anything there is unsupported:
//      objects a desired schema can't create at all (the catalog check's
//      `other` kind, an extension once for all its members; virtual
//      generated columns, which pg-delta renders STORED; serial columns,
//      once each, though the differ renders a sequence and its OWNED BY;
//      comments on view and materialized-view columns, which the differ
//      doesn't generate, each with the COMMENT ... IS NULL removing it),
//      every desired-schema rule (or ordering) violation in
//      the generated files, every statement referencing a declared external
//      schema where PostgreSQL resolves it at CREATE (rehearsals don't
//      contain external schemas, so it could never load), and, when those
//      pass, every object the files don't reproduce exactly (loaded on a
//      throwaway database and compared with the target like the drift
//      check; a statement the throwaway database refuses is listed by its
//      object, never by a file that was never written). Every entry is named
//      by its object, as the catalog check names it (`namedOnTarget`: the
//      statement's object found on the target by name), never by a
//      statement's text; one the catalogs can't find keeps adoptedObject's
//      name. Nothing is written
//      before this passes. The refusal's advice follows the rules broken:
//      an undeclared schema in a PL/pgSQL body goes into externalSchemas,
//      risk rules without the callback need a terminal, ownership and
//      CREATE need the fixes it lists run as a superuser, anything else
//      needs the target changed.
//      Statements that break only risk rules (dynamic SQL, denylisted
//      calls) are the exception when the caller answers override reasons
//      (`overrideReason`): the checks treat them as marked, and once nothing
//      else is refused, and the target's connection is closed, a reason is
//      asked for each. It goes into an override marker above the statement
//      (an empty answer cancels). Either way a refusal names them as
//      `overridesNeeded`, once per object with all its rules, never among
//      what V1 doesn't support; without the callback they are refused once
//      nothing else is, for want of a terminal.
//   3. Write the files, then the ordinary `draft` (named `adopt`) and
//      `finalize`, which rehearse migration 1 against the desired schema.
//   4. Under the target lock, `markNextPending` (deploy/mark.ts) runs mark's
//      ownership and replica checks and records migration 1 as marked. No guard: like
//      deploy, adoption may run in CI.
// If steps 3-4 fail, every file adoption wrote is removed again, so the
// project is as it was; except when the target's COMMIT outcome is unknown
// (the record may be there: the next status or deploy settles it).
//
// Undoing a successful adoption is documented, not a command: the README's
// "Starting an adoption over". The refusals point there when what is in the
// way is an earlier adoption: the project's migration 1 is 00001-adopt, or
// the target records only migration 1, marked, named adopt.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "../adapters/types.ts";
import type { ResolvedTarget } from "../config/config.ts";
import {
  CommitOutcomeUnknownError,
  withLockedTarget,
} from "../deploy/engine.ts";
import { readRecordedMigrations } from "../deploy/history.ts";
import { markNextPending, readMarkableMigrations } from "../deploy/mark.ts";
import {
  fixScript,
  type NotOwnedObject,
  notOwnedFixer,
  notOwnedListing,
  notOwnedMessage,
  objectsNotOwnedAt,
} from "../deploy/ownership.ts";
import {
  type ForeignHistorySchema,
  foreignHistorySchema,
  foreignHistorySchemaMessage,
  type HistorySchemaNotCreatable,
  historySchemaNotCreatable,
  historySchemaNotCreatableMessage,
} from "../deploy/preflight.ts";
import {
  connectTarget,
  resolveTarget,
  targetDatabaseRequest,
  targetTimeouts,
} from "../deploy/target.ts";
import { dependentsOutside } from "../deploy/wipe.ts";
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
  adoptedObjectReference,
  type CatalogReference,
  catalogObjectFinding,
  desiredSchemaAnalysis,
  externalSchemaReferences,
  isSequenceStatement,
  type OverrideCandidate,
  type OverrideNeeded,
  oneLine,
  overrideCandidates,
  type ParsedStatement,
  parseSqlFile,
  type RuleContext,
  type RuleViolation,
  type SqlFile,
  SqlRuleViolationError,
  serialColumnFinding,
  viewColumnCommentFinding,
  virtualGeneratedColumnFinding,
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
  migrationFolderName,
  readIndex,
} from "../store/migrations.ts";
import {
  type CatalogFact,
  catalogFacts,
  isVirtualGeneratedColumn,
  type ObjectAddress,
  objectNames,
  referencedObjectNames,
} from "../verification/catalog.ts";
import {
  type DriftChange,
  type DriftedObject,
  driftBetween,
} from "../verification/drift.ts";
import { draft } from "./draft.ts";
import { finalize } from "./finalize.ts";

/** The draft name, so migration 1 is `00001-adopt`. */
const migrationName = "adopt";
const adoptedFolder = migrationFolderName(1, migrationName);

/**
 * Where a refusal points when what is in the way looks like an earlier
 * adoption: the README section on undoing one, valid only while the target
 * records nothing but its adoption.
 */
const startOver =
  'to start the adoption over, see "Starting an adoption over" in README.md';

export interface AdoptOptions {
  /** The target's name in config. */
  target: string;
  /**
   * Asked for the reason to write into the override marker of each object
   * that breaks only risk rules, once nothing else is refused. Without it
   * such objects are refused, as `overridesNeeded`, for want of a terminal.
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
  /**
   * The objects outside the managed and history schemas that depend on the
   * managed schema, as `rebuild` describes them (`view
   * reporting.item_view`), sorted. Rehearsals don't have them, so a
   * migration that changes or drops what they use fails at deploy.
   */
  readonly dependentsOutside: readonly string[];
  /**
   * How many objects of the managed schema it adopted: tables, views,
   * sequences, routines and types (not what goes with them, such as indexes
   * and constraints).
   */
  readonly objects: number;
  /**
   * When it adopted no objects: `Adopted 0 objects from schema public`,
   * naming the target's other schemas that hold objects, if any (a
   * forgotten managedSchema).
   */
  readonly warning: string | undefined;
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
  /** The managed schema's tables with row-level security enabled. */
  readonly rowLevelSecurity: number;
  /** Of those, the ones that force it on their owner too. */
  readonly forcedRowLevelSecurity: number;
  /**
   * The deploy role's default-privilege rules (`ALTER DEFAULT PRIVILEGES`),
   * in the managed schema or global; not other roles'.
   */
  readonly defaultPrivileges: number;
}

/**
 * Refuses with UnknownTargetError, AdoptConflictError (the project or the
 * target isn't empty, or the target has no managed schema) or
 * AdoptUnsupportedError (listing everything V1 doesn't support, what the
 * deploy role doesn't own, and its lacking CREATE on the database for the
 * history schema) before writing anything.
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
      { command: "init --adopt" },
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
      dependentsOutside: read.dependentsOutside,
      objects: read.objects,
      warning: read.warning,
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
    const adopted = index.ok && index.entries[0]?.folder === adoptedFolder;
    reasons.push(
      `the project already has migrations in ${projectRelative(root, paths.migrations)}${adopted ? ` (${startOver})` : ""}`,
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
 * target. The statements that break only risk rules are checked as if
 * marked and returned as `candidates` (in file order); an
 * AdoptUnsupportedError lists them as `overridesNeeded`. Without
 * `withOverrides` (no callback to ask their reasons) they are refused too,
 * once nothing else is.
 */
async function readTarget(
  project: Project,
  target: ResolvedTarget,
  { withOverrides }: { withOverrides: boolean },
): Promise<{
  files: AdoptedFile[];
  candidates: OverrideCandidate[];
  leftOnTarget: LeftOnTarget;
  dependentsOutside: string[];
  objects: number;
  warning: string | undefined;
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
      const [first] = recorded;
      const onlyAdoption =
        recorded.length === 1 &&
        first?.recordedHow === "marked" &&
        first.number === 1 &&
        first.name === migrationName;
      throw new AdoptConflictError(target.name, [
        `it already records ${plural(recorded.length, "migration")} in its history schema "${config.historySchema}"${onlyAdoption ? `, only its adoption (${startOver})` : ""}`,
      ]);
    }
    const schemas = await userSchemas(session, config.historySchema);
    const managed = schemas.find(
      (schema) => schema.name === config.managedSchema,
    );
    if (managed === undefined) {
      throw new AdoptConflictError(target.name, [
        missingManagedSchema(config.managedSchema, schemas),
      ]);
    }
    // Later migrations alter what is adopted: the deploy role must own it.
    // Marking creates the history schema, after everything is written. Both
    // are refused together with everything unsupported, in one refusal.
    const notOwned = await objectsNotOwnedAt(session, config.managedSchema);
    const foreign = await foreignHistorySchema(session, config.historySchema);
    const historySchema = await historySchemaNotCreatable(
      session,
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

    const found: Found[] = (
      await catalogFacts(session, config.managedSchema, {
        settings: targetTimeouts(target),
      })
    ).flatMap(unsupportedFact);
    const serial = serialColumnFinding();
    found.push(
      ...serials.map(({ column }) => ({
        object: `serial column ${column}`,
        rule: serial.rule,
        reason: serial.message,
      })),
    );
    found.push(
      ...(await viewColumnComments(session, config.managedSchema)).map(
        ({ object, fix }) => {
          const finding = viewColumnCommentFinding(
            `; remove it on the target: ${fix}`,
          );
          return { object, rule: finding.rule, reason: finding.message };
        },
      ),
    );
    const candidates = await overrideCandidates(
      sqlFiles(project, files),
      context,
    );
    const overrides: OverridesToAsk = {
      needed: overridesNeeded(candidates),
      askable: withOverrides,
    };
    const analysed = await analyse(
      project,
      withCheckingMarkers(project, files, candidates),
      context,
      serials.map((serial) => serial.sequence),
    );
    found.push(...analysed.unsupported);
    found.push(
      ...(
        await externalSchemaReferences(sqlFiles(project, files), context)
      ).map(({ object, reference, schemas }) => ({
        object,
        reference,
        rule: "outside-managed-schema",
        reason: `It references ${externalSchemaExplanation(schemas)}`,
      })),
    );
    const unsupported = await namedOnTarget(
      session,
      config.managedSchema,
      found,
    );
    const notOwnedSupported = await ownedIfSupported(
      session,
      notOwned,
      unsupported,
    );
    if (
      unsupported.length > 0 ||
      notOwnedSupported.length > 0 ||
      foreign !== undefined ||
      historySchema !== undefined
    ) {
      throw new AdoptUnsupportedError(
        target.name,
        {
          objects: unsupported,
          notOwned: notOwnedSupported,
          foreignHistorySchema: foreign,
          historySchemaNotCreatable: historySchema,
        },
        overrides,
      );
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
    ).catch(async (error: unknown) => {
      if (!(error instanceof DesiredSchemaLoadError)) {
        throw error;
      }
      throw new AdoptUnsupportedError(
        target.name,
        {
          objects: await namedOnTarget(session, config.managedSchema, [
            refusedStatement(error, analysed.statements, config.managedSchema),
          ]),
        },
        overrides,
      );
    });
    if (differences.length > 0) {
      throw new AdoptUnsupportedError(
        target.name,
        {
          objects: differences.map((drifted) => ({
            object: drifted.object,
            rule: "not-reproduced",
            reason: `${notReproduced[drifted.change]}: ${notReproducedLines(drifted)}`,
          })),
        },
        overrides,
      );
    }
    if (!withOverrides && candidates.length > 0) {
      throw new AdoptUnsupportedError(target.name, { objects: [] }, overrides);
    }
    const objects = objectCount(managed);
    return {
      files,
      candidates,
      leftOnTarget: await countLeftOnTarget(session, config.managedSchema),
      dependentsOutside: await dependentsOutside(
        session,
        config.managedSchema,
        config.historySchema,
      ),
      objects,
      warning:
        objects === 0
          ? emptyManagedSchemaWarning(
              config.managedSchema,
              schemas.filter((schema) => schema !== managed),
            )
          : undefined,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * The objects the deploy role doesn't own, except those also refused as
 * unsupported (named alike, as the catalog check names objects): nobody
 * should give the deploy role an object only to drop it.
 */
async function ownedIfSupported(
  session: Session,
  notOwned: readonly { notOwned: NotOwnedObject; address: ObjectAddress }[],
  unsupported: readonly UnsupportedObject[],
): Promise<NotOwnedObject[]> {
  if (notOwned.length === 0) {
    return [];
  }
  const refused = new Set(unsupported.map(({ object }) => object));
  const names = await objectNames(
    session,
    notOwned.map(({ address }) => address),
  );
  return notOwned
    .filter((_, index) => !refused.has(names[index] ?? ""))
    .map((item) => item.notOwned);
}

/**
 * A schema on the target that isn't PostgreSQL's own or the history schema,
 * with how many objects of each kind it holds. Objects that go with another
 * one aren't counted (a table's indexes, constraints and identity or serial
 * sequence, a table's row type, array types), nor extension members.
 */
interface UserSchema {
  /** As in the catalog, e.g. `MyApp`. */
  readonly name: string;
  /** Quoted where SQL needs it, e.g. `"MyApp"`, `shop`. */
  readonly quoted: string;
  /** Tables (partitioned and foreign ones too), views, sequences, routines and types. */
  readonly counts: Readonly<Record<ObjectKind, number>>;
}

const objectKinds = ["table", "view", "sequence", "function", "type"] as const;
type ObjectKind = (typeof objectKinds)[number];

/**
 * The target's schemas, sorted, leaving out `pg_*` (the catalog, TOAST and
 * temporary schemas), `information_schema` and the history schema.
 */
async function userSchemas(
  session: Session,
  historySchema: string,
): Promise<UserSchema[]> {
  const { rows } = await session.query<{
    name: string;
    quoted: string;
    kind: ObjectKind | null;
    count: number;
  }>(
    `WITH n AS (
       SELECT oid, nspname FROM pg_catalog.pg_namespace
        WHERE pg_catalog.left(nspname, 3) <> 'pg_' AND nspname <> 'information_schema' AND nspname <> $1),
     objects AS (
       SELECT 'pg_class'::pg_catalog.regclass AS class, c.oid, c.relnamespace AS schema,
              CASE WHEN c.relkind IN ('v', 'm') THEN 'view' WHEN c.relkind = 'S' THEN 'sequence' ELSE 'table' END AS kind
         FROM pg_catalog.pg_class c WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
       UNION ALL
       SELECT 'pg_proc'::pg_catalog.regclass, p.oid, p.pronamespace, 'function' FROM pg_catalog.pg_proc p
       UNION ALL
       SELECT 'pg_type'::pg_catalog.regclass, t.oid, t.typnamespace, 'type'
         FROM pg_catalog.pg_type t LEFT JOIN pg_catalog.pg_class r ON r.oid = t.typrelid
        WHERE t.typtype IN ('d', 'e', 'r', 'm') OR r.relkind = 'c'),
     counted AS (
       SELECT o.schema, o.kind, count(*)::int AS count FROM objects o
        WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_depend d
                           WHERE d.classid = o.class AND d.objid = o.oid AND d.deptype IN ('a', 'e', 'i'))
        GROUP BY o.schema, o.kind)
     SELECT n.nspname AS name, pg_catalog.quote_ident(n.nspname) AS quoted, counted.kind, coalesce(counted.count, 0) AS count
       FROM n LEFT JOIN counted ON counted.schema = n.oid
      ORDER BY n.nspname COLLATE "C"`,
    [historySchema],
  );
  const schemas = new Map<
    string,
    { name: string; quoted: string; counts: Record<ObjectKind, number> }
  >();
  for (const { name, quoted, kind, count } of rows) {
    let schema = schemas.get(name);
    if (schema === undefined) {
      const counts = { table: 0, view: 0, sequence: 0, function: 0, type: 0 };
      schema = { name, quoted, counts };
      schemas.set(name, schema);
    }
    if (kind !== null) {
      schema.counts[kind] = count;
    }
  }
  return [...schemas.values()];
}

/** How many objects the schema holds, of every kind. */
function objectCount(schema: UserSchema): number {
  return objectKinds.reduce((sum, kind) => sum + schema.counts[kind], 0);
}

/**
 * The warning for adopting an empty managed schema: it adopted nothing,
 * and which other schemas hold objects (a forgotten managedSchema).
 */
function emptyManagedSchemaWarning(
  managedSchema: string,
  others: readonly UserSchema[],
): string {
  const holding = others
    .filter((schema) => objectCount(schema) > 0)
    .map(
      (schema) =>
        `schema ${schema.quoted} holds ${objectKinds
          .filter((kind) => schema.counts[kind] > 0)
          .map((kind) => plural(schema.counts[kind], kind))
          .join(", ")}`,
    );
  const adopted = `Adopted 0 objects from schema ${managedSchema}`;
  return holding.length === 0
    ? adopted
    : `${adopted}; ${holding.join("; ")}: is managedSchema right?`;
}

/**
 * Why a missing managed schema is refused: the schemas the target has, and
 * for one that differs only in case (managedSchema is lowercase), the rename.
 */
function missingManagedSchema(
  managedSchema: string,
  schemas: readonly UserSchema[],
): string {
  const has =
    schemas.length === 0
      ? "the target has no schemas besides the system ones"
      : `the target has ${schemas.length === 1 ? "schema" : "schemas"} ${schemas.map((schema) => schema.quoted).join(", ")}`;
  const otherCase = schemas.find(
    (schema) => schema.name.toLowerCase() === managedSchema,
  );
  const rename =
    otherCase === undefined
      ? []
      : [
          `managedSchema must be lowercase: rename schema ${otherCase.quoted} first (ALTER SCHEMA ${otherCase.quoted} RENAME TO ${managedSchema}), and the application's references to it`,
        ];
  return [
    `its managed schema "${managedSchema}" does not exist (check managedSchema in super-deploy.config.ts)`,
    has,
    ...rename,
  ].join("; ");
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
 * What the managed schema has outside super-deploy (LeftOnTarget): grants,
 * policies, row-level security, and the session's role's default
 * privileges there or global. A grant is
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
               JOIN pg_catalog.pg_class c ON c.oid = p.polrelid JOIN n ON c.relnamespace = n.oid)::int AS policies,
            (SELECT count(*) FROM pg_catalog.pg_class c JOIN n ON c.relnamespace = n.oid
              WHERE c.relrowsecurity)::int AS "rowLevelSecurity",
            (SELECT count(*) FROM pg_catalog.pg_class c JOIN n ON c.relnamespace = n.oid
              WHERE c.relrowsecurity AND c.relforcerowsecurity)::int AS "forcedRowLevelSecurity",
            (SELECT count(*) FROM pg_catalog.pg_default_acl d
              WHERE d.defaclrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                AND (d.defaclnamespace = 0 OR d.defaclnamespace IN (SELECT oid FROM n)))::int AS "defaultPrivileges"`,
    [managedSchema],
  );
  return (
    rows[0] ?? {
      grants: 0,
      policies: 0,
      rowLevelSecurity: 0,
      forcedRowLevelSecurity: 0,
      defaultPrivileges: 0,
    }
  );
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

/**
 * The comments on view and materialized-view columns in the managed schema,
 * each named as the catalog check names it, with the statement removing it.
 * pg-delta doesn't generate them (QA 127), so the desired schema can't
 * reproduce them.
 */
async function viewColumnComments(
  session: Session,
  managedSchema: string,
): Promise<{ object: string; fix: string }[]> {
  const { rows } = await session.query<ObjectAddress & { fix: string }>(
    `SELECT d.classoid::pg_catalog.oid::text AS class, d.objoid::text AS obj, d.objsubid AS sub,
            pg_catalog.format('COMMENT ON COLUMN %I.%I.%I IS NULL', n.nspname, c.relname, a.attname) AS fix
       FROM pg_catalog.pg_description d
       JOIN pg_catalog.pg_class c ON c.oid = d.objoid AND c.relkind IN ('v', 'm')
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
      WHERE d.classoid = 'pg_catalog.pg_class'::pg_catalog.regclass
        AND d.objsubid > 0 AND n.nspname = $1
      ORDER BY c.relname, a.attnum`,
    [managedSchema],
  );
  const names = await objectNames(session, rows);
  return rows.map(({ fix }, index) => ({
    object: names[index] ?? fix,
    fix,
  }));
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
 * A drifted object's catalog lines, `; `-separated. A changed object's say
 * which side each is on; the reason already names a one-sided object's.
 */
function notReproducedLines(drifted: DriftedObject): string {
  return drifted.differences
    .map(({ side, line }) =>
      drifted.change !== "changed"
        ? line
        : `${side === "target" ? "on the target" : "generated"}: ${line}`,
    )
    .join("; ");
}

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
  unsupported: Found[];
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
    const unsupported: Found[] = [];
    for (const violation of error.violations) {
      if (!(await isSequenceStatement(violation.statement, serialSequences))) {
        // Declaring a schema allows it only in PL/pgSQL bodies: a reference
        // bound at CREATE would then be refused as an external one.
        const schema =
          violation.reference?.where === "plpgsql-body"
            ? violation.reference.schema
            : undefined;
        unsupported.push({
          ...(await statementObject(violation, context.managedSchema)),
          rule: violation.rule,
          reason: violation.message,
          ...(schema === undefined ? {} : { schemaToDeclare: schema }),
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
): Found {
  const statement = statements
    .filter(({ file, line }) => file === error.file && line <= error.line)
    .reduce<ParsedStatement | undefined>(
      (last, next) =>
        last === undefined || next.line > last.line ? next : last,
      undefined,
    );
  return {
    ...(statement === undefined
      ? { object: "the generated desired schema" }
      : {
          object: adoptedObject(statement, managedSchema),
          reference: adoptedObjectReference(statement, managedSchema),
        }),
    rule: "not-reproduced",
    reason: `PostgreSQL refused to create it: ${error.detail}${error.hint === undefined ? "" : `. Hint: ${error.hint}`}`,
  };
}

/**
 * What a rule violation's statement creates, as `adoptedObject` names it
 * and as the target's catalogs find it; its file for a statement that
 * doesn't parse (never expected from the differ).
 */
async function statementObject(
  violation: RuleViolation,
  managedSchema: string,
): Promise<Pick<Found, "object" | "reference">> {
  const parsed = await parseSqlFile({
    path: violation.file,
    text: violation.statement,
  });
  const [statement] = parsed.ok ? parsed.statements : [];
  return statement === undefined
    ? { object: violation.file }
    : {
        object: adoptedObject(statement, managedSchema),
        reference: adoptedObjectReference(statement, managedSchema),
      };
}

/** An entry as found: `reference` finds its object on the target to name it. */
interface Found extends UnsupportedObject {
  readonly reference?: CatalogReference | undefined;
}

/**
 * The entries as the refusal lists them: each one whose object the target
 * has named as the catalog check names objects (`table app.users`,
 * `trigger ct on table app.base`), the others as found.
 */
async function namedOnTarget(
  session: Session,
  managedSchema: string,
  found: readonly Found[],
): Promise<UnsupportedObject[]> {
  const references = found.flatMap(({ reference }) =>
    reference === undefined ? [] : [reference],
  );
  const names =
    references.length === 0
      ? []
      : await referencedObjectNames(session, managedSchema, references);
  let next = 0;
  return found.map(({ reference, ...entry }) => {
    if (reference === undefined) {
      return entry;
    }
    const name = names[next++];
    return name === undefined ? entry : { ...entry, object: name };
  });
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
   * The object as PostgreSQL describes it, qualified (`table app.users`,
   * `statistics object app.st`, `column v of table app.people`), or, for
   * one the target's catalogs can't find by name, as an override marker
   * names it (`function load_staging(text)`). Never a statement's text.
   */
  readonly object: string;
  /** The rule id that refuses it, e.g. `unsupported-object`. */
  readonly rule: string;
  /** Why, in the rules' words. */
  readonly reason: string;
  /**
   * For an `undeclared-schema` reference that declaring the schema in
   * externalSchemas would allow (one in a PL/pgSQL body): the schema.
   */
  readonly schemaToDeclare?: string;
}

/** Everything `init --adopt` refuses a target for, found without writing. */
export interface AdoptRefusal {
  /** What V1 doesn't support (or can't reproduce). */
  readonly objects: readonly UnsupportedObject[];
  /**
   * The managed schema and the objects in it that the deploy role doesn't
   * own, schema first; not those `objects` lists, which can't be adopted
   * whoever owns them.
   */
  readonly notOwned?: readonly NotOwnedObject[];
  /** A schema with the history schema's name that super-deploy didn't make and can't use. */
  readonly foreignHistorySchema?: ForeignHistorySchema | undefined;
  /** The deploy role can't create the history schema marking needs. */
  readonly historySchemaNotCreatable?: HistorySchemaNotCreatable | undefined;
}

/** The objects that break only risk rules, and whether adoption can ask their reasons. */
export interface OverridesToAsk {
  readonly needed: readonly OverrideNeeded[];
  /** Adoption has an override-reason callback (a terminal, in the CLI). */
  readonly askable: boolean;
}

/**
 * `init --adopt` refused the target, listing everything it found at once:
 * objects in its managed schema that V1 doesn't support (or can't
 * reproduce), objects the deploy role doesn't own, the deploy role lacking
 * CREATE on the database for the history schema, and the objects that need
 * an override reason (asked once nothing else is refused, and only with an
 * override-reason callback). Nothing was written anywhere.
 */
export class AdoptUnsupportedError extends SuperDeployError {
  readonly code = "adopt-unsupported";
  readonly target: string;
  /**
   * What V1 doesn't support; empty when only the deploy role's ownership,
   * its CREATE on the database or override reasons are refused.
   */
  readonly objects: readonly UnsupportedObject[];
  /**
   * The managed schema and the objects in it whose owner the deploy role
   * doesn't have the privileges of, each with its fix; never one `objects`
   * lists.
   */
  readonly notOwned: readonly NotOwnedObject[];
  /**
   * A schema with the history schema's name that super-deploy didn't make:
   * what it holds, or its owner.
   */
  readonly foreignHistorySchema: ForeignHistorySchema | undefined;
  /** The deploy role can't create the history schema; with the grant that fixes it. */
  readonly historySchemaNotCreatable: HistorySchemaNotCreatable | undefined;
  /**
   * The objects that break only risk rules (never in `objects`), each once
   * with all its rules. With an override-reason callback their reasons will
   * be asked once nothing else is refused; without one, they are refused
   * for want of a terminal.
   */
  readonly overridesNeeded: readonly OverrideNeeded[];

  /**
   * What to do before adopting again, each piece once, e.g. `change the
   * target first, then adopt again`. The message ends with these too.
   */
  readonly advice: readonly string[];

  /**
   * The refusal as lines for people, the way the CLI prints it: every object
   * with its rule and reason, the objects the deploy role doesn't own and
   * what it lacks, the fixes for those as a script, then the objects that
   * need an override reason. `summary` follows them.
   */
  readonly details: readonly string[];

  /** The message without what `details` lists: how much, and the advice. */
  readonly summary: string;

  constructor(
    target: string,
    refusal: AdoptRefusal,
    overrides: OverridesToAsk = { needed: [], askable: true },
  ) {
    const { objects } = refusal;
    const notOwned = refusal.notOwned ?? [];
    const foreign = refusal.foreignHistorySchema;
    const historySchema = refusal.historySchemaNotCreatable;
    const { needed, askable } = overrides;
    const fixes = [
      ...notOwned.map(({ fix }) => fix),
      ...(historySchema === undefined ? [] : [historySchema.fix]),
    ];
    const advice = adoptionAdvice(objects, {
      fixes: fixes.length > 0,
      historySchema: foreign?.historySchema,
      terminal: !askable && needed.length > 0,
    });
    const nothingWritten = `Nothing was written; ${advice.join("; ")}`;
    const things = `${plural(objects.length, "thing")} V1 doesn't support`;
    const s = needed.length === 1 ? "s" : "";
    const reasonsNeeded = `${plural(needed.length, "object")} need${s} an override reason`;
    // Only without a callback are the override reasons themselves refused.
    const refusedNeeded = askable ? [] : needed;
    const later =
      askable && needed.length > 0
        ? [
            `Once nothing else is refused, adoption will ask an override reason for ${plural(needed.length, "object")} that ${needed.length === 1 ? "breaks" : "break"} only risk rules: ${needed.map((item) => item.object).join(", ")}`,
          ]
        : [];
    const reasons = [
      ...(objects.length === 0
        ? []
        : [`its managed schema has ${things}: ${shown(objects)}`]),
      ...(notOwned.length === 0
        ? []
        : [
            `the deploy role doesn't own everything in the managed schema: ${notOwned.map(notOwnedMessage).join("; ")}`,
          ]),
      ...(foreign === undefined ? [] : [foreignHistorySchemaMessage(foreign)]),
      ...(historySchema === undefined
        ? []
        : [historySchemaNotCreatableMessage(historySchema)]),
      ...(refusedNeeded.length === 0
        ? []
        : [
            `${reasonsNeeded}, asked only in a terminal: ${refusedNeeded.map((item) => item.object).join(", ")}`,
          ]),
    ];
    const counted = [
      ...(objects.length === 0 ? [] : [`its managed schema has ${things}`]),
      ...(notOwned.length === 0
        ? []
        : [
            `the deploy role doesn't own ${plural(notOwned.length, "object")} in the managed schema`,
          ]),
      ...(foreign === undefined
        ? []
        : [
            `its history schema "${foreign.historySchema}" isn't super-deploy's`,
          ]),
      ...(historySchema === undefined
        ? []
        : [
            `${notOwned.length === 0 ? "the deploy role " : ""}lacks CREATE on the database`,
          ]),
      ...(refusedNeeded.length === 0 ? [] : [reasonsNeeded]),
    ];
    // Refused for nothing but the override reasons: for want of a terminal.
    const refused =
      counted.length === 1 && refusedNeeded.length > 0
        ? `Cannot adopt target ${target} without a terminal`
        : `Cannot adopt target ${target}`;
    super(
      [`${refused}: ${reasons.join("; ")}`, nothingWritten, ...later].join(
        ". ",
      ),
    );
    this.target = target;
    this.objects = objects;
    this.notOwned = notOwned;
    this.foreignHistorySchema = foreign;
    this.historySchemaNotCreatable = historySchema;
    this.overridesNeeded = needed;
    this.advice = advice;
    this.details = [
      ...(objects.length === 0
        ? []
        : [
            `Target ${target} has ${things}:`,
            ...objects.flatMap(({ object, rule, reason }) => [
              `  ${object}`,
              `    ${rule}: ${reason}`,
            ]),
          ]),
      ...(notOwned.length === 0 ? [] : notOwnedListing(target, notOwned)),
      ...(foreign === undefined
        ? []
        : [`Target ${target}: ${foreignHistorySchemaMessage(foreign)}`]),
      ...(historySchema === undefined
        ? []
        : [
            `The deploy role ${historySchema.role} needs CREATE on database ${historySchema.database} to create the history schema "${historySchema.historySchema}"`,
          ]),
      ...(fixes.length === 0
        ? []
        : fixScript(
            historySchema === undefined
              ? notOwnedFixer
              : notOwned.length === 0
                ? "a superuser or as the database's owner"
                : "a superuser",
            fixes,
          )),
      ...(refusedNeeded.length === 0
        ? []
        : [
            `Target ${target} has ${plural(needed.length, "object")} that need${s} an override reason, asked only in a terminal:`,
            ...overrideListing(refusedNeeded),
          ]),
      ...later,
    ];
    this.summary = `${refused}: ${listing(counted)}, listed above. ${nothingWritten}`;
  }
}

/**
 * Objects that need an override reason as lines for people, the way the
 * CLI lists them: each object, then each rule it breaks with its message.
 */
export function overrideListing(needed: readonly OverrideNeeded[]): string[] {
  return needed.flatMap(({ object, findings }) => [
    `  ${object}`,
    ...findings.map(({ rule, message }) => `    ${rule}: ${message}`),
  ]);
}

/** Up to five objects' names, `; `-separated, then how many more. */
function shown(objects: readonly UnsupportedObject[]): string {
  const more = objects.length > 5 ? `; and ${objects.length - 5} more` : "";
  return `${objects
    .slice(0, 5)
    .map((o) => o.object)
    .join("; ")}${more}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listing(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The advice for a refusal: a PL/pgSQL body's reference to an undeclared
 * schema needs it in externalSchemas; anything else its objects break needs
 * the target changed; `fixes` (the deploy role's ownership or CREATE is
 * refused) need running as a superuser; `historySchema` (a schema of that
 * name super-deploy didn't make) needs it dropped or another name;
 * `terminal` (override reasons are needed without a callback to ask them)
 * needs a terminal.
 */
function adoptionAdvice(
  objects: readonly UnsupportedObject[],
  {
    fixes,
    historySchema,
    terminal,
  }: {
    fixes: boolean;
    historySchema: string | undefined;
    terminal: boolean;
  },
): string[] {
  const schemas = new Set(
    objects.flatMap(({ schemaToDeclare }) =>
      schemaToDeclare === undefined ? [] : [schemaToDeclare],
    ),
  );
  const changeTarget = objects.some(
    ({ schemaToDeclare }) => schemaToDeclare === undefined,
  );
  const changeTheTarget = "change the target first, then adopt again";
  const advice = [
    ...(changeTarget ? [changeTheTarget] : []),
    ...(fixes ? ["run the fixes as a superuser"] : []),
    ...(historySchema === undefined
      ? []
      : [
          `drop the schema "${historySchema}" or set another historySchema in super-deploy.config.ts`,
        ]),
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
  if (advice.length === 1 && fixes) {
    return ["run the fixes as a superuser, then adopt again"];
  }
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
