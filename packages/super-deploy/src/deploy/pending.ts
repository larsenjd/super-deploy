// Which of the project's migrations a target has still to run.
import type { RecordedMigration } from "./history.ts";

/** The highest migration number the target records, 0 if none. */
export function lastRecordedNumber(
  recorded: readonly Pick<RecordedMigration, "number">[],
): number {
  return Math.max(0, ...recorded.map((migration) => migration.number));
}

/**
 * The project's migrations after the last one the target records, in order.
 * Whether the recorded ones match the repo (hashes, numbering) is checked by
 * the deploy pre-flight (ticket 13).
 */
export function pendingMigrations<M extends { readonly number: number }>(
  migrations: readonly M[],
  recorded: readonly Pick<RecordedMigration, "number">[],
): M[] {
  const last = lastRecordedNumber(recorded);
  return migrations.filter((migration) => migration.number > last);
}
