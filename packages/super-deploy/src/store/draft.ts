// The one draft: draft/draft.json holds its name; draft/schema-change.sql is
// the generated schema change.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SuperDeployError } from "../errors.ts";
import { normaliseDraftName } from "./draft-name.ts";
import type { ProjectPaths } from "./layout.ts";

export interface DraftMetadata {
  readonly name: string;
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
  return { name: normaliseDraftName(parsed.name) };
}

export async function writeDraft(
  paths: ProjectPaths,
  metadata: DraftMetadata,
  schemaChange: string,
): Promise<void> {
  await mkdir(paths.draft, { recursive: true });
  await writeFile(
    paths.draftMetadata,
    `${JSON.stringify({ name: metadata.name }, null, 2)}\n`,
  );
  await writeFile(paths.draftSchemaChange, schemaChange);
}
