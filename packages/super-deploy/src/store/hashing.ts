// Hashing for finalized migrations and desired-schema snapshots. Identical on
// every OS: files must be UTF-8 without a byte-order mark, and line endings
// are normalised (CRLF to LF) before hashing, so a checkout that converted
// line endings still verifies. Everything else, including whitespace, counts.
//
//   file hash      sha256(normalised text)
//   content hash   sha256(manifest), where the manifest is
//                    "super-deploy migration 1\n"
//                    "folder <JSON folder name>\n"
//                    "file <JSON relative path> <file hash>\n"   per file, sorted by path
//   chain hash     chain[n] = sha256(chain[n-1] + content[n]) over the hex
//                  strings, with chain[0] = "" (so chain[1] = sha256(content[1]))
//
// The desired-schema hash uses the same file lines under the header
// "super-deploy desired schema 1\n" and no folder line.
import { createHash } from "node:crypto";
import { InvalidEncodingError } from "../errors.ts";

/** A file to hash: its path relative to the folder being hashed (forward slashes) and its text. */
export interface HashedFile {
  readonly path: string;
  readonly text: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Decodes a file that will be hashed: UTF-8 only, no byte-order mark.
 * `file` names it in the error (project-relative).
 */
export function decodeHashedText(bytes: Uint8Array, file: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new InvalidEncodingError(file, "starts with a UTF-8 byte-order mark");
  }
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new InvalidEncodingError(file, "is not valid UTF-8", {
      cause: error,
    });
  }
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Line endings normalised to LF. */
export function normaliseLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function fileLines(files: readonly HashedFile[]): string {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(
      (file) =>
        `file ${JSON.stringify(file.path)} ${sha256(normaliseLineEndings(file.text))}\n`,
    )
    .join("");
}

/** The content hash of a migration folder: its name and every file in it. */
export function migrationContentHash(
  folderName: string,
  files: readonly HashedFile[],
): string {
  return sha256(
    `super-deploy migration 1\nfolder ${JSON.stringify(folderName)}\n${fileLines(files)}`,
  );
}

/** chain[n] = sha256(chain[n-1] + content[n]); pass `""` as the previous chain hash for migration 1. */
export function chainHash(
  previousChainHash: string,
  contentHash: string,
): string {
  return sha256(previousChainHash + contentHash);
}

/** A hash of a desired schema's files (paths relative to the desired-schema folder). */
export function desiredSchemaHash(files: readonly HashedFile[]): string {
  return sha256(`super-deploy desired schema 1\n${fileLines(files)}`);
}
