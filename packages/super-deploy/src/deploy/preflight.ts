// The deploy pre-flight: read-only checks on the target, after the lock and
// before any rehearsal, that catch what would otherwise fail mid-transaction
// or weaken safety (spec "Deployment engine"):
//   - every role the deployment grants to exists (rehearsals create missing
//     roles on their own server, but nothing creates roles on targets)
//   - every declared external schema exists
//   - the deploy role is not superuser and holds none of the predefined roles
//     that reach outside the database (a warning, never a refusal)
//   - what the target's history schema records matches the repo, and the
//     target holds no draft (deploy-draft's), which is not a migration
// `status` runs the same checks and reports them.

import { join } from "node:path";
import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
import { rolesNamedInFiles } from "../sql-analysis/index.ts";
import { readDesiredSchema } from "../store/desired-schema.ts";
import {
  type FinalizedMigration,
  migrationFolderName,
  snapshotFolderName,
} from "../store/migrations.ts";
import {
  type DeployedDraft,
  type RecordedMigration,
  readDeployedDraft,
} from "./history.ts";
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
   * Roles the newest migration's desired schema or a pending migration grants
   * to (or names in a policy) that the target lacks, sorted. Refuses a deployment.
   */
  readonly missingRoles: readonly string[];
  /** Declared external schemas the target lacks, in config order. Refuses a deployment. */
  readonly missingExternalSchemas: readonly string[];
  /** Recorded migrations that don't match the repo, by number. Refuses a deployment. */
  readonly historyMismatches: readonly HistoryMismatch[];
  /** Why the deploy role is more privileged than a deployment needs. Never refuses. */
  readonly warnings: readonly string[];
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
  /** The pending migrations' deploy-time files, in order. */
  readonly pending: readonly ReplayUnit[];
}

/** Runs every check on `session` (read-only queries, no transaction). */
export async function preflightChecks(
  session: Session,
  project: Pick<Project, "root" | "config">,
  input: PreflightInput,
): Promise<PreflightFindings> {
  return {
    missingRoles: await missing(
      session,
      "SELECT rolname AS name FROM pg_catalog.pg_roles WHERE rolname = ANY($1::text[])",
      await deploymentRoles(project.root, input.migrations, input.pending),
    ),
    missingExternalSchemas: await missing(
      session,
      "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname = ANY($1::text[])",
      project.config.externalSchemas,
    ),
    historyMismatches: historyMismatches(
      input.migrations,
      input.recorded,
      await readDeployedDraft(session, project.config.historySchema),
    ),
    warnings: await deployRoleWarnings(session, input.targetName),
  };
}

/** True when the findings refuse a deployment (warnings never do). */
export function refusesDeployment(findings: PreflightFindings): boolean {
  return (
    findings.missingRoles.length > 0 ||
    findings.missingExternalSchemas.length > 0 ||
    findings.historyMismatches.length > 0
  );
}

/**
 * Every role a deployment of `pending` needs on the target: the roles named
 * in the newest migration's desired-schema snapshot and in the pending
 * migrations' deploy-time files (a pending migration may grant to a role a
 * later one revokes again).
 */
async function deploymentRoles(
  root: string,
  migrations: readonly FinalizedMigration[],
  pending: readonly ReplayUnit[],
): Promise<string[]> {
  const newest = migrations.at(-1);
  const snapshot =
    newest === undefined
      ? []
      : await readDesiredSchema(root, join(newest.path, snapshotFolderName));
  return rolesNamedInFiles([
    ...snapshot,
    ...pending.flatMap((unit) =>
      unit.files.map(({ file, sql }) => ({ path: file, text: sql })),
    ),
  ]);
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
        message: `the target records migration ${theirs}, which the repo doesn't have`,
      });
    } else if (ours.name !== entry.name) {
      mismatches.push({
        number: entry.number,
        reason: "name",
        message: `the target records migration ${entry.number} as ${theirs}, but the repo's is ${ours.folder}`,
      });
    } else if (ours.contentHash !== entry.contentHash) {
      mismatches.push({
        number: entry.number,
        reason: "content-hash",
        message: `the target records migration ${ours.folder} with content hash ${entry.contentHash}, but the repo's is ${ours.contentHash}`,
      });
    } else if (ours.chainHash !== entry.chainHash) {
      mismatches.push({
        number: entry.number,
        reason: "chain-hash",
        message: `the target records migration ${ours.folder} with chain hash ${entry.chainHash}, but the repo's is ${ours.chainHash}`,
      });
    } else if (entry.recovery !== undefined) {
      const k = entry.recovery;
      const recovery = ours.recoveries[k - 1];
      if (recovery === undefined) {
        mismatches.push({
          number: entry.number,
          reason: "recovery",
          message: `the target records migration ${ours.folder} with Recovery ${k}, which the repo doesn't have`,
        });
      } else if (recovery.chainHash !== entry.recoveryChainHash) {
        mismatches.push({
          number: entry.number,
          reason: "recovery",
          message: `the target records migration ${ours.folder} Recovery ${k} with chain hash ${entry.recoveryChainHash ?? "(none)"}, but the repo's is ${recovery.chainHash}`,
        });
      }
    }
  }
  if (draft !== undefined) {
    mismatches.push(draftMismatch(draft, recorded));
  }
  return mismatches.sort((a, b) => a.number - b.number);
}

function draftMismatch(
  draft: DeployedDraft,
  recorded: readonly RecordedMigration[],
): HistoryMismatch {
  const base = recorded.find((entry) => entry.number === draft.baseMigration);
  const where =
    base === undefined
      ? "before any migration"
      : `on top of ${migrationFolderName(base.number, base.name)}`;
  const reset =
    draft.baseMigration === undefined
      ? "rebuild --to N"
      : `rebuild --to ${draft.baseMigration}`;
  return {
    number: (draft.baseMigration ?? 0) + 1,
    reason: "draft",
    message: `the target holds draft ${draft.name} (deployed by attempt #${draft.attemptId} ${where}, ${draft.seedData ? "with" : "without"} seed data), not a finalized migration: reset it with ${reset}`,
  };
}

/** The names in `wanted` that `sql` (selecting `name` for `$1`) doesn't return, in order. */
async function missing(
  session: Session,
  sql: string,
  wanted: readonly string[],
): Promise<string[]> {
  if (wanted.length === 0) {
    return [];
  }
  const { rows } = await session.query<{ name: string }>(sql, [wanted]);
  const found = new Set(rows.map((row) => row.name));
  return wanted.filter((name) => !found.has(name));
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
 * The deploy pre-flight refused the target: a role the deployment grants to
 * or a declared external schema is missing, or its recorded history doesn't
 * match the repo. Nothing was rehearsed or changed; the attempt is logged as
 * failed.
 */
export class PreflightFailedError extends SuperDeployError {
  readonly code = "preflight-failed";
  readonly target: string;
  readonly findings: PreflightFindings;

  constructor(target: string, findings: PreflightFindings) {
    const roles = findings.missingRoles.map(
      (role) =>
        `role "${role}" does not exist (the desired schema grants to it; create it on the target)`,
    );
    const schemas = findings.missingExternalSchemas.map(
      (schema) =>
        `external schema "${schema}" does not exist (it is declared in externalSchemas)`,
    );
    const history = findings.historyMismatches.map(
      (mismatch) => mismatch.message,
    );
    super(
      `Target ${target} failed the deploy pre-flight checks: ${[...roles, ...schemas, ...history].join("; ")}`,
    );
    this.target = target;
    this.findings = findings;
  }
}
