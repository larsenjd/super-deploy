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
// "super-deploy desired schema 1\n" and no folder line. The draft's
// schema-change hash (draft.json) is the file hash of the schema change
// `draft` wrote.
//
// A Recovery (<migration>/recoveries/recovery-K/) is hashed on its own, so
// adding one never changes its migration's content or chain hash:
//
//   recovery content hash   sha256("super-deploy recovery 1\n"
//                                  "migration <JSON migration folder name>\n"
//                                  "folder <JSON recovery folder name>\n"
//                                  file lines as above)
//   recovery chain hash     recovery[K] = sha256(recovery[K-1] + content[K]),
//                           with recovery[0] = the migration's chain hash

import { createHash } from "node:crypto";
import { SuperDeployError } from "../errors.ts";
import { comparePaths } from "./layout.ts";

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

/** sha256 of a file's text with its line endings normalised. */
export function fileHash(text: string): string {
  return sha256(normaliseLineEndings(text));
}

function fileLines(files: readonly HashedFile[]): string {
  return [...files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((file) => `file ${JSON.stringify(file.path)} ${fileHash(file.text)}\n`)
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

/** The content hash of a Recovery folder: its migration, its name and every file in it. */
export function recoveryContentHash(
  migrationFolderName: string,
  recoveryFolderName: string,
  files: readonly HashedFile[],
): string {
  return sha256(
    `super-deploy recovery 1\nmigration ${JSON.stringify(migrationFolderName)}\nfolder ${JSON.stringify(recoveryFolderName)}\n${fileLines(files)}`,
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

/** A file that is hashed (finalized migrations, the draft, the desired schema) isn't UTF-8 without a BOM. */
export class InvalidEncodingError extends SuperDeployError {
  readonly code = "invalid-encoding";
  /** Project-relative path with forward slashes. */
  readonly file: string;

  constructor(file: string, reason: string, options?: ErrorOptions) {
    super(
      `${file} ${reason}; save it as UTF-8 without a byte-order mark`,
      options,
    );
    this.file = file;
  }
}
