// The one draft: draft/draft.json holds its name (editable) and the hash of
// the desired schema it was generated from (written by `draft`, used by
// `validate` to warn about undrafted changes); draft/schema-change.sql is the
// generated schema change.
//
// A Recovery draft (created by `recovery --migration N`) has
// `"recoveryOf": N` in draft.json and the name of migration N; its
// schema-change.sql is a copy of migration N's, never regenerated, and its
// scripts and seed data become the next Recovery of migration N at finalize.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SuperDeployError } from "../errors.ts";
import { normaliseDraftName } from "./draft-name.ts";
import type { ProjectPaths } from "./layout.ts";

/** The draft's own metadata file; never copied into the finalized migration. */
export const draftMetadataFileName = "draft.json";

export interface DraftMetadata {
  readonly name: string;
  /** store/hashing.ts desiredSchemaHash() of the desired schema `draft` last generated from. */
  readonly desiredSchemaHash?: string | undefined;
  /** For a Recovery draft: the number of the migration it recovers. */
  readonly recoveryOf?: number | undefined;
}

export async function readDraft(
  paths: ProjectPaths,
): Promise<DraftMetadata | undefined> {
  let text: string;
  try {
    text = await readFile(paths.draftMetadata, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    typeof parsed.name !== "string"
  ) {
    throw new SuperDeployError(
      "invalid-config",
      `${paths.draftMetadata} has no "name"`,
    );
  }
  const hash =
    "desiredSchemaHash" in parsed &&
    typeof parsed.desiredSchemaHash === "string"
      ? parsed.desiredSchemaHash
      : undefined;
  const recoveryOf = "recoveryOf" in parsed ? parsed.recoveryOf : undefined;
  if (
    recoveryOf !== undefined &&
    !(
      typeof recoveryOf === "number" &&
      Number.isInteger(recoveryOf) &&
      recoveryOf > 0
    )
  ) {
    throw new SuperDeployError(
      "invalid-config",
      `${paths.draftMetadata} has a "recoveryOf" that is not a migration number`,
    );
  }
  return {
    name: normaliseDraftName(parsed.name),
    desiredSchemaHash: hash,
    ...(recoveryOf === undefined ? {} : { recoveryOf }),
  };
}

export async function writeDraft(
  paths: ProjectPaths,
  metadata: DraftMetadata,
  schemaChange: string,
): Promise<void> {
  await writeDraftMetadata(paths, metadata);
  await writeFile(paths.draftSchemaChange, schemaChange);
}

/** Writes draft/draft.json (creating the draft folder if needed). */
export async function writeDraftMetadata(
  paths: ProjectPaths,
  metadata: DraftMetadata,
): Promise<void> {
  await mkdir(paths.draft, { recursive: true });
  await writeFile(
    paths.draftMetadata,
    `${JSON.stringify({ name: metadata.name, desiredSchemaHash: metadata.desiredSchemaHash, recoveryOf: metadata.recoveryOf }, null, 2)}\n`,
  );
}
