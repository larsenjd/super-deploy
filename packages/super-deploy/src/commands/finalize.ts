// `finalize`: rehearse the draft, then freeze it as the next numbered
// migration: the draft's files, metadata and a desired-schema snapshot,
// read-only, hashed and chained in the index.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pgDeltaDiffer } from "../differ/pg-delta.ts";
import { SuperDeployError } from "../errors.ts";
import type { Project } from "../project.ts";
import { draftMetadataFileName } from "../store/draft.ts";
import {
  chainHash,
  type HashedFile,
  migrationContentHash,
} from "../store/hashing.ts";
import {
  makeReadOnly,
  maxMigrationNumber,
  metadataFileName,
  migrationFolderName,
  readHashedFiles,
  readIndex,
  snapshotFolderName,
  writeIndex,
} from "../store/migrations.ts";
import { parserName, parserVersion, toolVersion } from "../version.ts";
import { rehearseCurrentDraft } from "./rehearse.ts";

/**
 * metadata.json of a finalized migration. Deliberately no timestamps or
 * usernames: git records who and when. Tickets 10 and 11 add overrides and
 * the destructive acknowledgement.
 */
export interface MigrationMetadata {
  readonly tool: { readonly name: string; readonly version: string };
  readonly differ: { readonly name: string; readonly version: string };
  readonly parser: { readonly name: string; readonly version: string };
  readonly rehearsalServer: { readonly version: string };
}

export interface FinalizeResult {
  readonly number: number;
  readonly name: string;
  /** Folder name, e.g. `00001-add-customers`. */
  readonly folder: string;
  /** Absolute path of the migration folder. */
  readonly path: string;
  readonly contentHash: string;
  readonly chainHash: string;
  readonly metadata: MigrationMetadata;
}

export async function finalize(project: Project): Promise<FinalizeResult> {
  const { root, paths } = project;
  const rehearsed = await rehearseCurrentDraft(project, "finalize");
  const number = rehearsed.migrations.length + 1;
  if (number > maxMigrationNumber) {
    throw new SuperDeployError(
      "migration-integrity",
      `Migration numbers stop at ${maxMigrationNumber}`,
    );
  }
  const folder = migrationFolderName(number, rehearsed.draft.name);

  const metadata: MigrationMetadata = {
    tool: { name: "super-deploy", version: toolVersion },
    differ: { name: pgDeltaDiffer.name, version: pgDeltaDiffer.version },
    parser: { name: parserName, version: parserVersion },
    rehearsalServer: { version: rehearsed.serverVersion },
  };
  const files: HashedFile[] = [
    ...(await readHashedFiles(
      root,
      paths.draft,
      (path) => path !== draftMetadataFileName,
    )),
    ...rehearsed.desiredSchema.map((file) => ({
      path: `${snapshotFolderName}/${file.path}`,
      text: file.text,
    })),
    { path: metadataFileName, text: `${JSON.stringify(metadata, null, 2)}\n` },
  ];
  const contentHash = migrationContentHash(folder, files);
  const previous = rehearsed.migrations.at(-1)?.chainHash ?? "";
  const entry = {
    folder,
    contentHash,
    chainHash: chainHash(previous, contentHash),
  };

  // Written under a temporary name, then renamed, so a half-written folder
  // never looks like a migration (validate reports a leftover one).
  const path = join(paths.migrations, folder);
  const staging = join(paths.migrations, `.finalizing-${folder}`);
  await rm(staging, { recursive: true, force: true });
  for (const file of files) {
    const target = join(staging, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.text);
  }
  await makeReadOnly(staging);
  await rename(staging, path);

  const index = await readIndex(paths);
  await writeIndex(paths, [...(index.ok ? index.entries : []), entry]);
  await rm(paths.draft, { recursive: true, force: true });

  return {
    number,
    name: rehearsed.draft.name,
    path,
    metadata,
    ...entry,
  };
}
