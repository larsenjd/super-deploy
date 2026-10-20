// Questions as callbacks. A command that is about to discard work asks its
// caller through `confirm` (the CLI asks yes/no, default no, at a terminal;
// the menu does the same; scripts answer however they like). With neither
// `confirm` nor the acknowledgement flag it refuses, so nothing is lost when
// there is nobody to ask.
import { SuperDeployError } from "./errors.ts";
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

/**
 * A command would discard work and was not allowed to: nobody could be asked
 * and `acknowledgeOverwrite` wasn't set, or the question was answered no.
 * Nothing was changed.
 */
export class OverwriteNotAcknowledgedError extends SuperDeployError {
  readonly code = "overwrite-not-acknowledged";
  readonly question: OverwriteQuestion;
  /** True when the question was asked and answered no. */
  readonly declined: boolean;

  constructor(question: OverwriteQuestion, declined: boolean) {
    super(
      declined
        ? `${question.message} Answered no: nothing changed`
        : `${question.message} Refused without a terminal: pass --acknowledge-overwrite to delete or overwrite ${question.paths.join(", ")}`,
    );
    this.question = question;
    this.declined = declined;
  }
}

/**
 * `finalize` found statements that drop structure or delete data, and they
 * were not acknowledged: no `acknowledgeDestructive`, and `confirm` was
 * missing or answered no. Nothing was changed.
 */
export class DestructiveNotAcknowledgedError extends SuperDeployError {
  readonly code = "destructive-not-acknowledged";
  readonly question: DestructiveQuestion;
  /** True when the question was asked and answered no. */
  readonly declined: boolean;

  constructor(question: DestructiveQuestion, declined: boolean) {
    const statements = question.statements
      .map((s) => `${s.file}:${s.line}: ${s.message}`)
      .join("; ");
    super(
      declined
        ? `${question.message} Answered no: nothing changed`
        : `${question.message} ${statements}. Refused without a terminal: pass --acknowledge-destructive to finalize it anyway`,
    );
    this.question = question;
    this.declined = declined;
  }
}
