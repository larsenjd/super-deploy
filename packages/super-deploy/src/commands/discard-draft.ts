// `discard-draft [--acknowledge-overwrite]`: delete the draft, leaving the
// desired schema alone, so the next `draft` starts from scratch.
import { rm } from "node:fs/promises";
import { NoDraftError } from "../errors.ts";
import type { Project } from "../project.ts";
import { acknowledgeOverwrite, type OverwriteOptions } from "../questions.ts";
import { readDraft } from "../store/draft.ts";
import { projectRelative } from "../store/layout.ts";
import { exists } from "../store/migrations.ts";

export type DiscardDraftOptions = OverwriteOptions;

export interface DiscardDraftResult {
  /** The discarded draft's name (undefined if its draft.json was missing or unreadable). */
  readonly name: string | undefined;
  /** Absolute path of the deleted draft folder. */
  readonly path: string;
}

export async function discardDraft(
  project: Project,
  options: DiscardDraftOptions = {},
): Promise<DiscardDraftResult> {
  const { root, paths } = project;
  if (!(await exists(paths.draft))) {
    throw new NoDraftError("discard");
  }
  const name = await draftName(project);
  await acknowledgeOverwrite(options, {
    kind: "acknowledge-overwrite",
    command: "discard-draft",
    message: `Discard draft ${name ?? projectRelative(root, paths.draft)}?`,
    paths: [projectRelative(root, paths.draft)],
  });
  await rm(paths.draft, { recursive: true, force: true });
  return { name, path: paths.draft };
}

/** The draft's name, or undefined when draft.json is missing or broken (discarding it is still allowed). */
export async function draftName(project: Project): Promise<string | undefined> {
  try {
    return (await readDraft(project.root, project.paths))?.name;
  } catch {
    return undefined;
  }
}
