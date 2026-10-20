// Questions as callbacks. A command that is about to discard work asks its
// caller through `confirm` (the CLI asks yes/no, default no, at a terminal;
// the menu does the same; scripts answer however they like). With neither
// `confirm` nor the acknowledgement flag it refuses, so nothing is lost when
// there is nobody to ask.
import { OverwriteNotAcknowledgedError } from "./errors.ts";

/** Asked before a command overwrites or deletes work (`--acknowledge-overwrite` skips it). */
export interface OverwriteQuestion {
  readonly kind: "acknowledge-overwrite";
  readonly command: "unfinalize" | "restore-schema" | "discard-draft";
  /** One line for people, ending in a question mark. */
  readonly message: string;
  /** Project-relative paths (forward slashes) that would be deleted or overwritten. */
  readonly paths: readonly string[];
}

/** Every question a command can ask. Ticket 11 adds the destructive acknowledgement. */
export type Question = OverwriteQuestion;

/** Answers a yes/no question: true goes ahead, false refuses and nothing changes. */
export type Confirm = (question: Question) => boolean | Promise<boolean>;

export interface OverwriteOptions {
  /** Go ahead without asking (`--acknowledge-overwrite`). */
  readonly acknowledgeOverwrite?: boolean;
  /** Asked before discarding work. Without it (and without `acknowledgeOverwrite`) the command refuses. */
  readonly confirm?: Confirm;
}

/**
 * Resolves when the command may discard what `question` lists: there is
 * nothing to discard, it was acknowledged, or `confirm` said yes. Otherwise
 * throws OverwriteNotAcknowledgedError.
 */
export async function acknowledgeOverwrite(
  options: OverwriteOptions,
  question: OverwriteQuestion,
): Promise<void> {
  if (question.paths.length === 0 || options.acknowledgeOverwrite === true) {
    return;
  }
  if (options.confirm === undefined) {
    throw new OverwriteNotAcknowledgedError(question, false);
  }
  if (!(await options.confirm(question))) {
    throw new OverwriteNotAcknowledgedError(question, true);
  }
}
