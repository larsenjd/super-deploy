// Questions as callbacks. A command that is about to discard work asks its
// caller through `confirm` (the CLI asks yes/no, default no, at a terminal;
// the menu does the same; scripts answer however they like). With neither
// `confirm` nor the acknowledgement flag it refuses, so nothing is lost when
// there is nobody to ask.
import {
  DestructiveNotAcknowledgedError,
  OverwriteNotAcknowledgedError,
} from "./errors.ts";
import type { OverrideNeeded } from "./sql-analysis/adoption-overrides.ts";
import type { DestructiveStatement } from "./sql-analysis/destructive.ts";

export type { OverrideNeeded };

/** Asked before a command overwrites or deletes work (`--acknowledge-overwrite` skips it). */
export interface OverwriteQuestion {
  readonly kind: "acknowledge-overwrite";
  readonly command: "unfinalize" | "restore-schema" | "discard-draft";
  /** One line for people, ending in a question mark. */
  readonly message: string;
  /** Project-relative paths (forward slashes) that would be deleted or overwritten. */
  readonly paths: readonly string[];
}

/**
 * Asked before `finalize` freezes a draft that drops structure or deletes
 * data (`--acknowledge-destructive` skips it). The answer is recorded in the
 * migration's metadata with the statements.
 */
export interface DestructiveQuestion {
  readonly kind: "acknowledge-destructive";
  readonly command: "finalize";
  /** One line for people, ending in a question mark. */
  readonly message: string;
  /** The destructive statements, in the order they run (draft paths). */
  readonly statements: readonly DestructiveStatement[];
}

/** Every yes/no question a command can ask. */
export type Question = OverwriteQuestion | DestructiveQuestion;

/**
 * Asked by `init --adopt` once nothing else is refused, for each object in
 * `needed` in turn (this one is `needed[index]`): the reason written into
 * its override marker (`-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>`). Not a
 * yes/no Question: it is answered with text.
 */
export interface OverrideReasonQuestion extends OverrideNeeded {
  readonly target: string;
  /** One line for people, ending in a question mark. */
  readonly message: string;
  /** Every object a reason is asked for, in the order asked. */
  readonly needed: readonly OverrideNeeded[];
  readonly index: number;
}

/**
 * Answers an OverrideReasonQuestion with the reason (kept to one line).
 * An empty answer (or undefined) cancels the adoption.
 */
export type AskOverrideReason = (
  question: OverrideReasonQuestion,
) => string | undefined | Promise<string | undefined>;

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

export interface DestructiveOptions {
  /** Go ahead without asking (`--acknowledge-destructive`). */
  readonly acknowledgeDestructive?: boolean;
  /** Asked before finalizing destructive statements. Without it (and without `acknowledgeDestructive`) the command refuses. */
  readonly confirm?: Confirm;
}

/**
 * Resolves when `question` lists no statements, the acknowledgement was
 * given, or `confirm` said yes. Otherwise throws
 * DestructiveNotAcknowledgedError.
 */
export async function acknowledgeDestructive(
  options: DestructiveOptions,
  question: DestructiveQuestion,
): Promise<void> {
  if (
    question.statements.length === 0 ||
    options.acknowledgeDestructive === true
  ) {
    return;
  }
  if (options.confirm === undefined) {
    throw new DestructiveNotAcknowledgedError(question, false);
  }
  if (!(await options.confirm(question))) {
    throw new DestructiveNotAcknowledgedError(question, true);
  }
}
