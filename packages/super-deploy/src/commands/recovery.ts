// `recovery --migration N`: start a Recovery of migration N, for targets that
// haven't run it yet (typically because it failed on their data). The
// Recovery draft carries N's schema change unchanged (it is never
// regenerated) and starts from the scripts and seed data of N's newest
// variant (its newest Recovery, else the original), for the developer to
// change. `finalize` freezes it as N's next Recovery once its rehearsal
// proves it ends in the same structure as the original.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DraftExistsError, UnknownMigrationError } from "../errors.ts";
import type { Project } from "../project.ts";
import { writeDraftMetadata } from "../store/draft.ts";
import { verifiedMigrations } from "../store/integrity.ts";
import { projectRelative } from "../store/layout.ts";
import {
  exists,
  recoveryFileNames,
  schemaChangeFileName,
} from "../store/migrations.ts";
import { draftName } from "./discard-draft.ts";

export interface RecoveryOptions {
  /** The number of the migration to recover. */
  migration: number;
}

export interface RecoveryResult {
  /** The migration's number. */
  readonly migration: number;
  /** The migration's folder name, e.g. `00002-require-email`. */
  readonly folder: string;
  /** The number finalize will give the Recovery (K in "Recovery K"). */
  readonly recovery: number;
  /** The variant the scripts and seed data were copied from: undefined for the original, K for Recovery K. */
  readonly copiedFrom: number | undefined;
  /** Absolute path of the draft folder. */
  readonly draftPath: string;
  /** Project-relative paths of the files written into the draft, sorted. */
  readonly files: readonly string[];
}

export async function recovery(
  project: Project,
  options: RecoveryOptions,
): Promise<RecoveryResult> {
  const { root, paths } = project;
  if (await exists(paths.draft)) {
    throw new DraftExistsError(
      `start a Recovery of migration ${options.migration}`,
      await draftName(project),
    );
  }
  const migrations = await verifiedMigrations(root, paths);
  const migration = migrations.find((m) => m.number === options.migration);
  if (migration === undefined) {
    throw new UnknownMigrationError(
      options.migration,
      migrations.at(-1)?.number,
    );
  }
  const newest = migration.recoveries.at(-1);
  const source = newest?.path ?? migration.path;

  await mkdir(paths.draft, { recursive: true });
  const files: string[] = [];
  const copy = async (from: string, name: string) => {
    const target = join(paths.draft, name);
    // Byte for byte, but writable (the draft is for editing).
    await writeFile(target, await readFile(from));
    files.push(projectRelative(root, target));
  };
  await copy(join(migration.path, schemaChangeFileName), schemaChangeFileName);
  for (const name of recoveryFileNames) {
    if (await exists(join(source, name))) {
      await copy(join(source, name), name);
    }
  }
  await writeDraftMetadata(paths, {
    name: migration.name,
    recoveryOf: migration.number,
  });
  files.push(projectRelative(root, paths.draftMetadata));
  return {
    migration: migration.number,
    folder: migration.folder,
    recovery: migration.recoveries.length + 1,
    copiedFrom: newest?.number,
    draftPath: paths.draft,
    files: files.sort(),
  };
}
