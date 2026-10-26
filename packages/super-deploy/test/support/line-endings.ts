// Drafts saved with Windows line endings: finalize writes a migration's (or
// Recovery's) files LF (src/commands/finalize.ts), so finalizing the same
// draft saved with CRLF and with LF gives identical files.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FinalizeResult,
  finalize,
  type Project,
  unfinalize,
} from "superdeploy";
import { expect } from "vitest";
import { type Files, readFiles, writeFiles } from "./files.ts";

/** `text` with each LF line ending saved as CRLF, as a Windows editor saves it. */
export function withCrlf(text: string): string {
  return text.replaceAll("\n", "\r\n");
}

/** Matches a file's text that has no CRLF line ending. */
export const withoutCrlf = expect.not.stringContaining("\r\n");

/** What one finalize wrote, read byte for byte. */
export interface Finalized {
  /** The new migration's (or Recovery's) files. */
  readonly files: Files;
  /** The text of index.json. */
  readonly indexJson: string;
}

/**
 * Saves `draftFiles` (by path relative to the draft folder) into the draft
 * with CRLF line endings and finalizes it; then unfinalizes, saves them with
 * LF and finalizes again. Returns the first finalize's result and what each
 * finalize wrote.
 */
export async function finalizedWithEachLineEnding(
  project: Project,
  draftFiles: Files,
): Promise<{ result: FinalizeResult; crlf: Finalized; lf: Finalized }> {
  const finalizedWith = async (saved: (text: string) => string) => {
    await writeFiles(
      project.paths.draft,
      Object.fromEntries(
        Object.entries(draftFiles).map(([path, text]) => [path, saved(text)]),
      ),
    );
    const result = await finalize(project);
    const finalized: Finalized = {
      files: await readFiles(result.path),
      indexJson: await readFile(
        join(project.paths.migrations, "index.json"),
        "utf8",
      ),
    };
    return { result, finalized };
  };
  const { result, finalized: crlf } = await finalizedWith(withCrlf);
  await unfinalize(project);
  const { finalized: lf } = await finalizedWith((text) => text);
  return { result, crlf, lf };
}
