// The one splitter shared by rules and ordering: PostgreSQL 18's own parser
// (libpg-query) splits a file into statements with their syntax trees.
//
// libpg-query facts this relies on: statement locations are UTF-8 *byte*
// offsets and exclude leading comments; syntax-error cursor positions are
// 0-based *character* offsets; an empty string throws, so blank files are
// skipped; JSON omits default values (0, false, "").
import type { Node } from "@pgsql/types";
import { loadModule, parseSync } from "libpg-query";
import type { RuleViolation } from "./rules.ts";

export interface SqlFile {
  /** Project-relative path with forward slashes, as shown in messages. */
  path: string;
  text: string;
}

export interface ParsedStatement {
  readonly file: string;
  /** 1-based line of the statement's first token. */
  readonly line: number;
  /** The statement's text, trimmed, without its terminating semicolon. */
  readonly text: string;
  /** UTF-8 byte offset of the statement in the file. */
  readonly offset: number;
  /** Syntax-tree node type, e.g. `CreateStmt`. */
  readonly nodeType: string;
  readonly node: Node;
}

export type ParseOutcome =
  | { ok: true; statements: ParsedStatement[] }
  | { ok: false; violation: RuleViolation };

interface RawStatement {
  stmt?: Node;
  stmt_location?: number;
  stmt_len?: number;
}

let loaded: Promise<void> | undefined;

export async function parseSqlFile(file: SqlFile): Promise<ParseOutcome> {
  loaded ??= loadModule();
  await loaded;
  if (file.text.trim() === "") {
    return { ok: true, statements: [] };
  }
  let raw: RawStatement[];
  try {
    raw = (parseSync(file.text) as { stmts?: RawStatement[] }).stmts ?? [];
  } catch (error) {
    return { ok: false, violation: syntaxViolation(file, error) };
  }
  const bytes = Buffer.from(file.text, "utf8");
  const statements = raw.map((entry): ParsedStatement => {
    const offset = entry.stmt_location ?? 0;
    const end = entry.stmt_len ? offset + entry.stmt_len : bytes.length;
    const node = entry.stmt ?? ({} as Node);
    return {
      file: file.path,
      line: lineAtByte(bytes, offset),
      text: bytes.subarray(offset, end).toString("utf8").trim(),
      offset,
      nodeType: Object.keys(node)[0] ?? "Unknown",
      node,
    };
  });
  return { ok: true, statements };
}

function syntaxViolation(file: SqlFile, error: unknown): RuleViolation {
  const details = (
    error as { sqlDetails?: { message?: string; cursorPosition?: number } }
  ).sqlDetails;
  const message =
    details?.message ??
    (error instanceof Error ? error.message : String(error));
  const position = details?.cursorPosition ?? 0;
  const before = Array.from(file.text).slice(0, position).join("");
  return {
    file: file.path,
    line: before.split("\n").length,
    statement: "",
    rule: "syntax-error",
    message: `Syntax error: ${message}`,
  };
}

/** 1-based line of a UTF-8 byte offset. */
export function lineAtByte(bytes: Buffer, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < bytes.length; index++) {
    if (bytes[index] === 0x0a) {
      line++;
    }
  }
  return line;
}
