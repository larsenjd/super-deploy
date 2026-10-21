// What a command that changes a target left it at when its transaction there
// rolled back, and the one sentence every report of that uses: a file
// PostgreSQL refused (SqlFileFailedError, QA 174), a session that ended
// (TargetSessionEndedError, QA 142), and the CLI's closing line after an
// interruption (QA 110). One noun per command, so the same rollback reads the
// same wherever it is reported; deploy-draft's always says no draft was
// deployed.

import { migrationFolderName } from "../store/migrations.ts";
import type { RecordedMigration } from "./history.ts";

/** A command that changes a target, as its attempt records it. */
export type TargetCommand =
  | "deploy"
  | "deploy-draft"
  | "init --adopt"
  | "mark"
  | "disposable"
  | "rebuild";

/** What `command`'s change to a target is called, e.g. `deployment`. */
export function commandNoun(command: TargetCommand): string {
  switch (command) {
    case "deploy":
      return "deployment";
    case "deploy-draft":
      return "draft's deployment";
    case "init --adopt":
      return "adoption";
    case "mark":
      return "mark";
    case "disposable":
      return "flag change";
    case "rebuild":
      return "rebuild";
  }
}

/** What the target still records after a rollback. */
export interface RecordedPosition {
  /** Folder of the newest migration it records, e.g. `00003-add-email`; undefined when it records none. */
  readonly lastRecorded: string | undefined;
}

/** A command's transaction on a target rolled back: the target is unchanged. */
export interface TargetRollback {
  readonly command: TargetCommand;
  readonly target: string;
  /**
   * What the target still records; undefined when it couldn't be read, or
   * isn't told (rebuild's wipe).
   */
  readonly recorded: RecordedPosition | undefined;
}

/** Where `recorded` (in number order) leaves the target. */
export function recordedPosition(
  recorded: readonly Pick<RecordedMigration, "number" | "name">[],
): RecordedPosition {
  const last = recorded.at(-1);
  return {
    lastRecorded:
      last === undefined
        ? undefined
        : migrationFolderName(last.number, last.name),
  };
}

/**
 * E.g. `The deployment rolled back: target qa is unchanged, still at
 * migration 00003-add-email.`
 */
export function rolledBackSentence(rollback: TargetRollback): string {
  const { command, target, recorded } = rollback;
  const position =
    recorded === undefined
      ? ""
      : recorded.lastRecorded === undefined
        ? ", with no migration recorded"
        : `, still at migration ${recorded.lastRecorded}`;
  const draft = command === "deploy-draft" ? " (no draft deployed)" : "";
  return `The ${commandNoun(command)} rolled back: target ${target} is unchanged${position}${draft}.`;
}
