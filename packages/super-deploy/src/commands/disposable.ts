// `disposable --target X --set yes|no`: flags a target as disposable (or not)
// in its own history schema, never in config, so editing the config can never
// make production disposable. A guarded command (guard/guard.ts):
// terminal-only, YES typed exactly, a manual attempt, the target lock.
import { historyTable } from "../deploy/history.ts";
import { runGuarded } from "../guard/guard.ts";
import type { Project } from "../project.ts";

export interface DisposableOptions {
  /** The target's name in config. */
  target: string;
  /** True marks it disposable, false marks it not disposable. */
  set: boolean;
}

export interface DisposableResult {
  readonly target: string;
  /** The target's flag afterwards. */
  readonly disposable: boolean;
  /** False when the target already had that value (nothing was asked or written). */
  readonly changed: boolean;
  /** The manual attempt that changed it; undefined when nothing changed. */
  readonly attemptId: number | undefined;
}

/**
 * Terminal-only: shows the target's details at this process's terminal and
 * goes ahead only when the person there types YES. Refuses with
 * TerminalRequiredError in CI or without a terminal on stdin and stdout
 * (before touching the target), and NotConfirmedError for any other answer.
 * No option skips that.
 */
export async function disposable(
  project: Project,
  options: DisposableOptions,
): Promise<DisposableResult> {
  const { historySchema } = project.config;
  return runGuarded<undefined, DisposableResult>(project, {
    command: "disposable",
    target: options.target,
    async check(view) {
      if (view.disposable === options.set) {
        return {
          nothingToDo: {
            target: view.target.name,
            disposable: options.set,
            changed: false,
            attemptId: undefined,
          },
        };
      }
      return {
        action: options.set
          ? `Mark target ${view.target.name} as disposable`
          : `Mark target ${view.target.name} as not disposable`,
        details: [
          options.set
            ? "deploy-draft and rebuild will then be allowed to wipe it and load seed data"
            : "deploy-draft and rebuild will then refuse it",
        ],
        plan: undefined,
      };
    },
    async run({ target, session, attempt }) {
      await session.query(
        `UPDATE ${historyTable(historySchema, "settings")} SET disposable = $1`,
        [options.set],
      );
      return {
        target: target.name,
        disposable: options.set,
        changed: true,
        attemptId: attempt.id,
      };
    },
  });
}
