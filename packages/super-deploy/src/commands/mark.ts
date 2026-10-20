// `mark --target X`: after someone has fixed a target by hand, record its
// next pending migration as deployed (marked, original variant) without
// running it, but only if the target's managed schema matches a replica of
// its migrations up to that one (deploy/mark.ts). A guarded command
// (guard/guard.ts): terminal-only, YES typed exactly, a manual attempt under
// the OS username, the target lock.
//
// The replica check runs twice: before asking (a precondition, so a target
// that doesn't match is refused without asking) and again under the lock,
// right before recording, because the target's structure isn't part of the
// guard's fingerprint and may have changed while the person read the screen.
import {
  markNextPending,
  nextToMark,
  readMarkableMigrations,
  requireReplicaMatch,
} from "../deploy/mark.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";
import type { MigrationWithUnit } from "../rehearsal/replica.ts";

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
 * Also refuses with NothingToMarkError, HistoryMismatchError or
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
        view.target.name,
        migrations,
        view.recorded,
        view.draft,
      );
      await requireReplicaMatch(project, view.target, session, {
        migrations,
        recorded: view.recorded,
        next,
      });
      return {
        action: `Mark migration ${next.folder} as deployed on target ${view.target.name}`,
        details: [
          `The target matches a replica of migrations up to ${next.folder} (column order and ownership aside).`,
          "Its scripts are not run: only the target's history schema records it, as marked.",
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
