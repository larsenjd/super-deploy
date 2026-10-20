// Seed data: INSERTs in a draft folder that reproduce a target's problem
// data, so the draft's rehearsals prove its scripts handle it. Loaded just
// before the pre-migration script, only when rehearsing its own draft (draft,
// rehearse, finalize) and, later, by `deploy-draft --with-seed`. Never loaded
// when finalized migrations are replayed or deployed, nor in deployment
// rehearsals: readReplayUnit does not read it. Finalize freezes it with the
// migration as an audit record.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeHashedText } from "../store/hashing.ts";
import { projectRelative } from "../store/layout.ts";
import { exists, seedDataFileName } from "../store/migrations.ts";
import { type ReplayUnit, readReplayUnit } from "./replay.ts";

/** A draft (or Recovery) folder's deploy-time files with the seed data that goes before them. */
export interface SeededUnit {
  /**
   * The folder's seed data as a unit of its own, so it ends at a boundary
   * like data already committed on a target; undefined when there is none.
   */
  readonly seedData: ReplayUnit | undefined;
  /** The folder's deploy-time files, in the order they run. */
  readonly migration: ReplayUnit;
}

/**
 * Reads a draft (or migration, or Recovery) folder's seed data and
 * deploy-time files; for a Recovery folder `schemaChangeFolder` is its
 * migration's (see readReplayUnit).
 */
export async function readSeededUnit(
  root: string,
  folder: string,
  label: string,
  schemaChangeFolder: string = folder,
): Promise<SeededUnit> {
  const absolute = join(folder, seedDataFileName);
  let seedData: ReplayUnit | undefined;
  if (await exists(absolute)) {
    const file = projectRelative(root, absolute);
    seedData = {
      label: `${label} seed data`,
      files: [{ file, sql: decodeHashedText(await readFile(absolute), file) }],
    };
  }
  return {
    seedData,
    migration: await readReplayUnit(root, folder, label, schemaChangeFolder),
  };
}

/** The units a rehearsal replays: the seed data, then the migration. */
export function seededUnits(seeded: SeededUnit): ReplayUnit[] {
  return seeded.seedData === undefined
    ? [seeded.migration]
    : [seeded.seedData, seeded.migration];
}

/**
 * Every file in run order as one unit, for the rules: the seed data is
 * checked as `seed-data`, before the pre-migration script.
 */
export function seededFiles(seeded: SeededUnit): ReplayUnit {
  return {
    label: seeded.migration.label,
    files: seededUnits(seeded).flatMap((unit) => unit.files),
  };
}
