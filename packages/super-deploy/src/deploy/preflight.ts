// The deploy pre-flight: read-only checks on the target, after the lock and
// before any rehearsal, that catch what would otherwise fail mid-transaction
// or weaken safety (spec "Deployment engine"):
//   - the deploy role can create the history schema, if the target has none
//     yet: it needs CREATE on the database. `withLockedTarget` and
//     `init --adopt` refuse up front with HistorySchemaNotCreatableError
//     (there is nowhere to log an attempt yet), so deploy never gets this
//     far without it; `status` lists it with the others
//   - the deploy role owns the managed schema and everything in it, or is a
//     member of their owner (deploy/ownership.ts)
//   - the deploy role is not superuser and holds none of the predefined roles
//     that reach outside the database (a warning, never a refusal)
//   - what the target's history schema records matches the repo, and the
//     target holds no draft (deploy-draft's), which is not a migration
// Each history mismatch's message ends with the way out: a recorded migration
// or Recovery that the repo lacks or has differently is restored from version
// control (see `restore`). deploy, status and mark all show these messages.
// `status` runs the same checks and reports them.
//
// Declared external schemas are not checked: setting them up on each target
// is the DBA's job, and a routine reading a missing one fails only when it
// runs (ticket 06).

import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import {
  type FinalizedMigration,
  indexFileName,
  migrationFolderName,
  recoveriesFolderName,
  recoveryFolderName,
} from "../store/migrations.ts";
import {
  type DeployedDraft,
  type RecordedMigration,
  readDeployedDraft,
  readTargetSettings,
} from "./history.ts";
import {
  type NotOwnedObject,
  notOwnedMessage,
  objectsNotOwned,
} from "./ownership.ts";
import { lastRecordedNumber } from "./pending.ts";

/** One way the target's recorded history disagrees with the repo. */
export interface HistoryMismatch {
  /** The migration number concerned. */
  readonly number: number;
  /**
   * `not-in-repo` (the target records a migration the repo doesn't have),
   * `not-recorded` (a gap: a later migration is recorded but this one isn't),
   * `name`, `content-hash` or `chain-hash` (recorded differently),
   * `recovery` (the target ran a Recovery the repo doesn't have, or has
   * with a different chain hash), `draft` (deploy-draft left a draft on the
   * target; `number` is the one it would get). A draft is not a finalized
   * migration, so the target's structure is no longer that of its recorded
   * migrations: only `rebuild` resets it.
   */
  readonly reason:
    | "draft"
    | "not-in-repo"
    | "not-recorded"
    | "name"
    | "content-hash"
    | "chain-hash"
    | "recovery";
  readonly message: string;
}

/** What the pre-flight found on a target. */
export interface PreflightFindings {
  /**
   * The target has no history schema and the deploy role can't create it.
   * Undefined when it has one or can create it. Refuses a deployment.
   */
  readonly historySchemaNotCreatable: HistorySchemaNotCreatable | undefined;
  /**
   * The managed schema and the objects in it whose owner the deploy role
   * isn't a member of, schema first. Empty when the target has no managed
   * schema yet. Refuses a deployment.
   */
  readonly notOwned: readonly NotOwnedObject[];
  /** Recorded migrations that don't match the repo, by number. Refuses a deployment. */
  readonly historyMismatches: readonly HistoryMismatch[];
  /** Why the deploy role is more privileged than a deployment needs. Never refuses. */
  readonly warnings: readonly string[];
}

/** The target has no history schema, and the deploy role lacks CREATE on its database to create one. */
export interface HistorySchemaNotCreatable {
  /** The deploy role (the session's current role). */
  readonly role: string;
  readonly database: string;
  readonly historySchema: string;
  /** The statement that lets the deploy role create it, e.g. `GRANT CREATE ON DATABASE shop TO deployer`. */
  readonly fix: string;
}

/** Predefined roles that reach outside the database, and what they allow. */
const privilegedRoles: Readonly<Record<string, string>> = {
  pg_execute_server_program: "run programs on the database server",
  pg_read_server_files: "read files on the database server",
  pg_signal_backend: "cancel or terminate other sessions",
  pg_write_server_files: "write files on the database server",
};

export interface PreflightInput {
  readonly targetName: string;
  /** The project's finalized migrations, in order. */
  readonly migrations: readonly FinalizedMigration[];
  /** What the target records, in number order. */
  readonly recorded: readonly RecordedMigration[];
}

/** Runs every check on `session` (read-only queries, no transaction). */
export async function preflightChecks(
  session: Session,
  project: Pick<Project, "config">,
  input: PreflightInput,
): Promise<PreflightFindings> {
  return {
    historySchemaNotCreatable: await historySchemaNotCreatable(
      session,
      project.config.historySchema,
    ),
    notOwned: await objectsNotOwned(session, project.config.managedSchema),
    historyMismatches: historyMismatches(
      input.migrations,
      input.recorded,
      await readDeployedDraft(session, project.config.historySchema),
      {
        name: input.targetName,
        disposable: (
          await readTargetSettings(session, project.config.historySchema)
        ).disposable,
      },
    ),
    warnings: await deployRoleWarnings(session, input.targetName),
  };
}

/**
 * Each reason the findings refuse a deployment, as a line for people:
 * the history schema, ownership, then history mismatches. Empty when they don't refuse (warnings never do).
 */
export function preflightRefusals(findings: PreflightFindings): string[] {
  return [
    ...(findings.historySchemaNotCreatable === undefined
      ? []
      : [historySchemaNotCreatableMessage(findings.historySchemaNotCreatable)]),
    ...findings.notOwned.map(notOwnedMessage),
    ...findings.historyMismatches.map((mismatch) => mismatch.message),
  ];
}

/** True when the findings refuse a deployment (warnings never do). */
export function refusesDeployment(findings: PreflightFindings): boolean {
  return preflightRefusals(findings).length > 0;
}

/**
 * Whether the deploy role can't create the history schema `historySchema`:
 * the target has none, and the session's current role lacks CREATE on the
 * database. Read-only.
 */
export async function historySchemaNotCreatable(
  session: Session,
  historySchema: string,
): Promise<HistorySchemaNotCreatable | undefined> {
  const { rows } = await session.query<{
    role: string;
    database: string;
    fix: string;
  }>(
    `SELECT current_user AS role, pg_catalog.current_database() AS database,
            pg_catalog.format('GRANT CREATE ON DATABASE %I TO %I', pg_catalog.current_database(), current_user) AS fix
      WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = $1)
        AND NOT pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE')`,
    [historySchema],
  );
  const [row] = rows;
  return row === undefined ? undefined : { ...row, historySchema };
}

/** The refusal's line: what the deploy role needs, and the fix. */
export function historySchemaNotCreatableMessage(
  finding: HistorySchemaNotCreatable,
): string {
  return `the deploy role ${finding.role} needs CREATE on database ${finding.database} to create the history schema "${finding.historySchema}" (fix: ${finding.fix})`;
}

/**
 * Throws HistorySchemaNotCreatableError if the target has no history schema
 * and the deploy role can't create it.
 */
export async function requireHistorySchemaCreatable(
  session: Session,
  target: string,
  historySchema: string,
): Promise<void> {
  const finding = await historySchemaNotCreatable(session, historySchema);
  if (finding !== undefined) {
    throw new HistorySchemaNotCreatableError(target, finding);
  }
}

/**
 * How the recorded history disagrees with the repo: every recorded migration
 * must be the repo's migration of that number (same name, content and chain
 * hashes), with no gaps; a recorded Recovery must be the repo's Recovery of
 * that number (same chain hash), so its replica can replay it; and no draft
 * may be deployed on top of them.
 */
export function historyMismatches(
  migrations: readonly FinalizedMigration[],
  recorded: readonly RecordedMigration[],
  draft: DeployedDraft | undefined,
  holder: DraftHolder,
): HistoryMismatch[] {
  const repo = new Map(migrations.map((m) => [m.number, m]));
  const recordedNumbers = new Set(recorded.map((r) => r.number));
  const last = lastRecordedNumber(recorded);
  const mismatches: HistoryMismatch[] = [];
  for (const migration of migrations) {
    if (migration.number < last && !recordedNumbers.has(migration.number)) {
      mismatches.push({
        number: migration.number,
        reason: "not-recorded",
        message: `the target doesn't record migration ${migration.folder}, but records the later migration ${last}`,
      });
    }
  }
  for (const entry of recorded) {
    const ours = repo.get(entry.number);
    const theirs = migrationFolderName(entry.number, entry.name);
    if (ours === undefined) {
      mismatches.push({
        number: entry.number,
        reason: "not-in-repo",
        message: `the target records migration ${theirs}, which the repo doesn't have: ${restore(theirs)}`,
      });
    } else if (ours.name !== entry.name) {
      mismatches.push({
        number: entry.number,
        reason: "name",
        message: `the target records migration ${entry.number} as ${theirs}, but the repo's is ${ours.folder}: ${restore(theirs, ` in place of ${ours.folder}`)}`,
      });
    } else if (ours.contentHash !== entry.contentHash) {
      mismatches.push({
        number: entry.number,
        reason: "content-hash",
        message: `the target records migration ${ours.folder} with content hash ${entry.contentHash}, but the repo's is ${ours.contentHash}: ${restore(ours.folder)}`,
      });
    } else if (ours.chainHash !== entry.chainHash) {
      mismatches.push({
        number: entry.number,
        reason: "chain-hash",
        message: `the target records migration ${ours.folder} with chain hash ${entry.chainHash}, but the repo's is ${ours.chainHash}, so ${earlierChange(entry.number, repo, recorded)}`,
      });
    } else if (entry.recovery !== undefined) {
      const k = entry.recovery;
      const recovery = ours.recoveries[k - 1];
      const folder = `${ours.folder}/${recoveriesFolderName}/${recoveryFolderName(k)}`;
      if (recovery === undefined) {
        mismatches.push({
          number: entry.number,
          reason: "recovery",
          message: `the target records migration ${ours.folder} with Recovery ${k}, which the repo doesn't have: ${restore(folder, "", keepRecovery)}`,
        });
      } else if (recovery.chainHash !== entry.recoveryChainHash) {
        mismatches.push({
          number: entry.number,
          reason: "recovery",
          message: `the target records migration ${ours.folder} Recovery ${k} with chain hash ${entry.recoveryChainHash ?? "(none)"}, but the repo's is ${recovery.chainHash}: ${restore(folder, "", keepRecovery)}`,
        });
      }
    }
  }
  if (draft !== undefined) {
    mismatches.push(draftMismatch(draft, recorded, holder));
  }
  return mismatches.sort((a, b) => a.number - b.number);
}

/** Why a refusal says to restore what a target recorded. */
const keepRecorded =
  "a migration a target has recorded must never change, so put new changes in a new migration";
const keepRecovery =
  "a Recovery a target has run must never change, so put new changes in a new Recovery";

/**
 * The way out of a mismatch: restore `folder` (in the migrations directory)
 * as the target recorded it, and why (`why`: a migration's reason, or a
 * Recovery's).
 */
function restore(folder: string, where = "", why = keepRecorded): string {
  return `restore ${folder} (and ${indexFileName}) from version control${where} (${why})`;
}

/**
 * The way out of a chain-hash mismatch on migration `number` whose content
 * hash matches: a migration before it changed. Names the first recorded one
 * whose chain hash differs from the repo's (it changed, or the repo lacks
 * it), when there is one.
 */
function earlierChange(
  number: number,
  repo: ReadonlyMap<number, FinalizedMigration>,
  recorded: readonly RecordedMigration[],
): string {
  const first = recorded.find(
    (entry) =>
      entry.number < number &&
      repo.get(entry.number)?.chainHash !== entry.chainHash,
  );
  return first === undefined
    ? `a migration up to it changed: restore those (and ${indexFileName}) from version control (${keepRecorded})`
    : `an earlier migration changed, first ${migrationFolderName(first.number, first.name)}: restore it (and ${indexFileName}) from version control (${keepRecorded})`;
}

function draftMismatch(
  draft: DeployedDraft,
  recorded: readonly RecordedMigration[],
  holder: DraftHolder,
): HistoryMismatch {
  return {
    number: (draft.baseMigration ?? 0) + 1,
    reason: "draft",
    message: `the target holds ${describeHeldDraft(draft, recorded, holder)}`,
  };
}

/**
 * The target's deployed draft when it is the only history mismatch: its
 * recorded migrations match the project's, and only the draft is in the way.
 */
export function onlyHeldDraft(
  mismatches: readonly HistoryMismatch[],
  draft: DeployedDraft | undefined,
): DeployedDraft | undefined {
  return draft !== undefined &&
    mismatches.length > 0 &&
    mismatches.every((mismatch) => mismatch.reason === "draft")
    ? draft
    : undefined;
}

/**
 * The target a deployed draft is on, as the way out names it: rebuild, the
 * only way to clear the draft, runs only on a disposable target.
 */
export interface DraftHolder {
  readonly name: string;
  readonly disposable: boolean;
}

/**
 * The draft a target holds, for a message whose subject is the target:
 * "draft <name> (deployed by attempt #N on top of <migration>, with(out)
 * seed data), not a finalized migration: reset it with rebuild --to <N>",
 * and on a target no longer disposable "flag it disposable again (disposable
 * --target X --set yes), then reset it with ..." (QA 167).
 */
export function describeHeldDraft(
  draft: DeployedDraft,
  recorded: readonly RecordedMigration[],
  holder: DraftHolder,
): string {
  const base = recorded.find((entry) => entry.number === draft.baseMigration);
  const where =
    base === undefined
      ? "before any migration"
      : `on top of ${migrationFolderName(base.number, base.name)}`;
  const reset = `rebuild --to ${draft.baseMigration ?? 0}`;
  const flag = holder.disposable
    ? ""
    : `flag it disposable again (disposable --target ${holder.name} --set yes), then `;
  return `draft ${draft.name} (deployed by attempt #${draft.attemptId} ${where}, ${draft.seedData ? "with" : "without"} seed data), not a finalized migration: ${flag}reset it with ${reset}`;
}

/**
 * Warnings for the session's login role and, when an adapter switched role,
 * the current role: superuser, or a member of a predefined role that reaches
 * outside the database.
 */
async function deployRoleWarnings(
  session: Session,
  targetName: string,
): Promise<string[]> {
  const { rows } = await session.query<{
    rolname: string;
    rolsuper: boolean;
    privileged: string[];
  }>(
    `SELECT r.rolname, r.rolsuper,
            ARRAY(SELECT p FROM unnest($1::text[]) AS p
                   WHERE pg_catalog.pg_has_role(r.oid, p, 'MEMBER') ORDER BY 1) AS privileged
       FROM pg_catalog.pg_roles r
      WHERE r.rolname IN (session_user, current_user)
      ORDER BY r.rolname`,
    [Object.keys(privilegedRoles)],
  );
  return rows.flatMap(({ rolname, rolsuper, privileged }) => {
    const who = `The deploy role "${rolname}" on target ${targetName}`;
    if (rolsuper) {
      return [
        `${who} is a superuser: deploy with a role that isn't, so deploy-time SQL can't reach beyond the database`,
      ];
    }
    if (privileged.length === 0) {
      return [];
    }
    const allows = privileged.map((name) => privilegedRoles[name]).join(", ");
    return [
      `${who} holds ${privileged.join(", ")} (it can ${allows}): deploy with a role that doesn't`,
    ];
  });
}

/**
 * The deploy pre-flight refused the target: the deploy role can't create
 * the history schema or doesn't own the managed schema or something in it, or its recorded history doesn't
 * match the repo. Nothing was rehearsed or changed; the attempt is logged as
 * failed. The CLI's `status` also throws it, after its report, to exit 1.
 */
export class PreflightFailedError extends SuperDeployError {
  readonly code = "preflight-failed";
  readonly target: string;
  readonly findings: PreflightFindings;

  constructor(target: string, findings: PreflightFindings) {
    super(
      `Target ${target} failed the deploy pre-flight checks: ${preflightRefusals(findings).join("; ")}`,
    );
    this.target = target;
    this.findings = findings;
  }
}

/**
 * A command that records on the target (deploy, mark, init --adopt, ...)
 * refused before doing anything: the target has no history schema yet and
 * the deploy role lacks CREATE on the database to create it. Nothing was
 * written, and no attempt was logged (there is nowhere to log it yet).
 */
export class HistorySchemaNotCreatableError extends SuperDeployError {
  readonly code = "history-schema-not-creatable";
  readonly target: string;
  readonly finding: HistorySchemaNotCreatable;

  constructor(target: string, finding: HistorySchemaNotCreatable) {
    super(
      `Cannot create the history schema on target ${target}: ${historySchemaNotCreatableMessage(finding)}`,
    );
    this.target = target;
    this.finding = finding;
  }
}
