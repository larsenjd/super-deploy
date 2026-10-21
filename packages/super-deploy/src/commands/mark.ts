// `mark --target X`: after someone has fixed a target by hand, record its
// next pending migration as deployed (marked, original variant) without
// running it, but only if the deploy role owns the target's managed schema
// and everything in it (deploy/ownership.ts: objects applied by hand are
// often someone else's) and the schema matches a replica of its migrations
// up to that one (deploy/mark.ts). A guarded command (guard/guard.ts):
// terminal-only, YES typed exactly, a manual attempt under the OS username,
// the target lock.
//
// The ownership and replica checks run twice: before asking (preconditions,
// so a target that fails them is refused without asking) and again under the
// lock, right before recording (`markNextPending`), because neither the
// target's structure nor its owners are part of the guard's fingerprint, and
// either may have changed while the person read the screen.
//
// The confirmation names the migration's pre- and post-migration scripts,
// which never run on the target (`skippedScripts`): the replica check sees
// structure, not data, so a backfill made by no one goes unnoticed.
import { basename } from "node:path";
import {
  markNextPending,
  nextToMark,
  readMarkableMigrations,
  requireReplicaMatch,
} from "../deploy/mark.ts";
import { requireOwnership } from "../deploy/ownership.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";
import type { MigrationWithUnit } from "../rehearsal/replica.ts";
import { schemaChangeFileName } from "../store/migrations.ts";

export interface MarkOptions {
  /** The target's name in config. */
  target: string;
}

export interface MarkResult {
  readonly target: string;
  /** The manual attempt that recorded it. */
  readonly attemptId: number;
  /** The migration now recorded as marked. */
  readonly marked: {
    readonly number: number;
    readonly name: string;
    /** e.g. `00002-add-orders`. */
    readonly folder: string;
  };
}

/**
 * Terminal-only: shows the migration and the target's details at this
 * process's terminal and goes ahead only when the person there types YES.
 * Refuses with TerminalRequiredError in CI or without a terminal on stdin
 * and stdout (before touching the target), and NotConfirmedError for any
 * other answer. No option skips that.
 *
 * Also refuses with NothingToMarkError, HistoryMismatchError, NotOwnedError
 * (the deploy role doesn't own the managed schema or something in it) or
 * MarkMismatchError (the target doesn't match the replica).
 */
export async function mark(
  project: Project,
  options: MarkOptions,
): Promise<MarkResult> {
  return runGuarded<readonly MigrationWithUnit[], MarkResult>(project, {
    command: "mark",
    target: options.target,
    async check(view, session) {
      // After the guard's terminal check, so CI is refused first.
      const migrations = await readMarkableMigrations(project);
      const next = nextToMark(
        { name: view.target.name, disposable: view.disposable },
        migrations,
        view.recorded,
        view.draft,
      );
      await requireOwnership(
        session,
        view.target.name,
        project.config.managedSchema,
      );
      await requireReplicaMatch(project, view.target, session, {
        migrations,
        recorded: view.recorded,
        next,
      });
      return {
        action: `Mark migration ${next.folder} as deployed on target ${view.target.name}`,
        details: [
          `The target matches a replica of migrations up to ${next.folder} (column order aside), and the deploy role owns everything in its managed schema.`,
          ...skippedScripts(next),
        ],
        plan: migrations,
      };
    },
    async run(locked, migrations) {
      // The guard has checked that the recorded migrations are unchanged, so
      // this is the migration shown.
      const marked = await markNextPending(project, locked, migrations);
      return {
        target: locked.target.name,
        attemptId: locked.attempt.id,
        marked: {
          number: marked.number,
          name: marked.name,
          folder: marked.folder,
        },
      };
    },
  });
}

/**
 * What marking leaves unrun. The replica check compares structure only, so a
 * pre- or post-migration script's data changes are the one thing it can't
 * check: each is named, with what to do about it (QA 175).
 */
function skippedScripts(migration: MigrationWithUnit): string[] {
  const scripts = migration.unit.files
    .map(({ file }) => basename(file))
    .filter((name) => name !== schemaChangeFileName);
  const recorded = "only the target's history schema records it, as marked.";
  return scripts.length === 0
    ? [`Its schema change is not run: ${recorded}`]
    : [
        `Its schema change and scripts are not run: ${recorded}`,
        ...scripts.map(
          (name) =>
            `${migration.folder}/${name} will not run: make the changes it makes by hand before typing YES`,
        ),
      ];
}
