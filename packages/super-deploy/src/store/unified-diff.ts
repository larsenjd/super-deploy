// Unified diffs of text, line by line, as `diff -u` and git write them (three
// lines of context), for the report finalize writes about a hand-edited
// schema change (store/hand-edit.ts); and the way back, the old text from the
// diff and the new text, which unfinalize needs to restore the generated
// schema change.
//
// Also the diff of a set of files, which a migration keeps its snapshot as
// (ADR-0008), and its strict application. It is written as `git diff` writes
// it, so GitHub highlights it and `git apply` accepts it: a section per
// changed, added or deleted file in path order, headed `diff --git a/<path>
// b/<path>`, then `new file mode 100644` or `deleted file mode 100644` for an
// added or deleted file (an empty one has no hunks, so only these lines
// record it), then `--- a/<path>` and `+++ b/<path>` with `/dev/null` for the
// missing side. There are no `index` lines: nothing reads them. Paths are
// quoted as git quotes them, but with characters outside ASCII written as
// they are, as git writes them with core.quotePath off. Applying is strict,
// with no fuzz and no offset search, because the diff is applied only to the
// files it was written from: a hunk that doesn't match is a bug, not a
// merge. This module knows nothing of migrations: a diff that doesn't apply
// throws FilesDiffDoesNotApplyError naming the file, and store/snapshots.ts
// says whose diff it is.
//
// Lines keep their "\n", so a missing newline at the end is a difference too
// and shows as `\ No newline at end of file`. The longest common subsequence
// is computed after trimming the common start and end, so its table is only
// as large as the edited region.

import { type HashedFile, normaliseLineEndings } from "./hashing.ts";

const context = 3;
const noNewline = "\\ No newline at end of file";
const devNull = "/dev/null";
const newFileMode = "new file mode 100644";
const deletedFileMode = "deleted file mode 100644";
/** The characters git quotes in a path with their escapes; the rest it writes in octal. */
const cEscapes = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\x07", "\\a"],
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\v", "\\v"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);
const unescapes = new Map(
  [...cEscapes].map(([char, escaped]) => [escaped, char]),
);

interface Edit {
  readonly kind: " " | "-" | "+";
  /** The line, with its "\n" unless it is a last line without one. */
  readonly line: string;
}

/** `text` split after each "\n". */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The edits from `from` to `to`: kept lines, then removals before additions at each change. */
function edits(from: readonly string[], to: readonly string[]): Edit[] {
  let start = 0;
  while (
    start < from.length &&
    start < to.length &&
    from[start] === to[start]
  ) {
    start++;
  }
  let fromEnd = from.length;
  let toEnd = to.length;
  while (
    fromEnd > start &&
    toEnd > start &&
    from[fromEnd - 1] === to[toEnd - 1]
  ) {
    fromEnd--;
    toEnd--;
  }
  const a = from.slice(start, fromEnd);
  const b = to.slice(start, toEnd);
  // common(i, j): the length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const common = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? common(i + 1, j + 1) + 1
          : Math.max(common(i + 1, j), common(i, j + 1));
    }
  }
  const kept = (line: string): Edit => ({ kind: " ", line });
  const result = from.slice(0, start).map(kept);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const removed = a[i];
    const added = b[j];
    if (removed !== undefined && removed === added) {
      result.push(kept(removed));
      i++;
      j++;
    } else if (
      removed !== undefined &&
      (added === undefined || common(i + 1, j) >= common(i, j + 1))
    ) {
      result.push({ kind: "-", line: removed });
      i++;
    } else if (added !== undefined) {
      result.push({ kind: "+", line: added });
      j++;
    }
  }
  result.push(...from.slice(fromEnd).map(kept));
  return result;
}

/** `-5,3`-style range: the first line (the one before, when empty) and the count. */
function range(first: number, count: number): string {
  return count === 1 ? `${first}` : `${first},${count}`;
}

/** The hunks from `from` to `to`, as lines without their "\n"; none when they are the same. */
function hunkLines(from: string, to: string): string[] {
  const all = edits(splitLines(from), splitLines(to));
  // Each change with its context; changes whose contexts meet share a hunk.
  const hunks: { start: number; end: number }[] = [];
  all.forEach((edit, index) => {
    if (edit.kind === " ") {
      return;
    }
    const start = Math.max(0, index - context);
    const end = Math.min(all.length, index + context + 1);
    const last = hunks.at(-1);
    if (last !== undefined && start <= last.end) {
      last.end = end;
    } else {
      hunks.push({ start, end });
    }
  });
  // The old and new line numbers (0-based) each edit starts at.
  const at: { from: number; to: number }[] = [];
  let fromLine = 0;
  let toLine = 0;
  for (const edit of all) {
    at.push({ from: fromLine, to: toLine });
    fromLine += edit.kind === "+" ? 0 : 1;
    toLine += edit.kind === "-" ? 0 : 1;
  }
  const out: string[] = [];
  for (const { start, end } of hunks) {
    const hunk = all.slice(start, end);
    const fromCount = hunk.filter((edit) => edit.kind !== "+").length;
    const toCount = hunk.filter((edit) => edit.kind !== "-").length;
    const first = at[start] ?? { from: 0, to: 0 };
    out.push(
      `@@ -${range(first.from + (fromCount === 0 ? 0 : 1), fromCount)} +${range(first.to + (toCount === 0 ? 0 : 1), toCount)} @@`,
    );
    for (const edit of hunk) {
      if (edit.line.endsWith("\n")) {
        out.push(`${edit.kind}${edit.line.slice(0, -1)}`);
      } else {
        out.push(`${edit.kind}${edit.line}`, noNewline);
      }
    }
  }
  return out;
}

/**
 * The unified diff from `from` to `to`, headed `--- <fromLabel>` and
 * `+++ <toLabel>`; empty when they are the same.
 */
export function unifiedDiff(
  from: string,
  to: string,
  labels: { readonly from: string; readonly to: string },
): string {
  const hunks = hunkLines(from, to);
  return hunks.length === 0
    ? ""
    : `${[`--- ${labels.from}`, `+++ ${labels.to}`, ...hunks].join("\n")}\n`;
}

/**
 * The diff from the files `from` to the files `to`, as `git diff` writes it:
 * a section per changed, added or deleted file, in path order; empty when
 * they are the same. Line endings are normalised to LF first, so they alone
 * are never a change.
 */
export function filesDiff(
  from: readonly HashedFile[],
  to: readonly HashedFile[],
): string {
  const before = normalised(from);
  const after = normalised(to);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out = paths.flatMap((path) =>
    fileSection(path, before.get(path), after.get(path)),
  );
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** Each file's text by its path, with LF line endings. */
function normalised(files: readonly HashedFile[]): Map<string, string> {
  return new Map(
    files.map((file) => [file.path, normaliseLineEndings(file.text)]),
  );
}

/** The lines of one file's section; none when its text is unchanged. */
function fileSection(
  path: string,
  before: string | undefined,
  after: string | undefined,
): string[] {
  const hunks = hunkLines(before ?? "", after ?? "");
  if (before !== undefined && after !== undefined && hunks.length === 0) {
    return [];
  }
  const a = gitPath(`a/${path}`);
  const b = gitPath(`b/${path}`);
  // git ends a name holding a space with a tab, so it can't be read as a date.
  const tab = path.includes(" ") ? "\t" : "";
  return [
    `diff --git ${a} ${b}`,
    ...(before === undefined
      ? [newFileMode]
      : after === undefined
        ? [deletedFileMode]
        : []),
    // An empty file added or deleted has no hunks, and no --- and +++ lines.
    ...(hunks.length === 0
      ? []
      : [
          `--- ${before === undefined ? devNull : a + tab}`,
          `+++ ${after === undefined ? devNull : b + tab}`,
          ...hunks,
        ]),
  ];
}

/** `name` as git writes it: in C-style quotes when it holds `"`, `\` or a control character. */
function gitPath(name: string): string {
  const escaped = name.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what git quotes.
    /["\\\x00-\x1f\x7f]/g,
    (char) =>
      cEscapes.get(char) ??
      `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return escaped === name ? name : `"${escaped}"`;
}

/**
 * The files from applying `diff`, a filesDiff, to `files`, strictly: every
 * context and removed line must be where its hunk says, with no fuzz and no
 * offset search; an added file must not be there yet, and a deleted file must
 * be removed whole. Line endings are normalised first. Sorted by path.
 * Throws FilesDiffDoesNotApplyError naming the file whose section failed.
 */
export function applyFilesDiff(
  diff: string,
  files: readonly HashedFile[],
): HashedFile[] {
  const result = normalised(files);
  for (const section of fileSections(normaliseLineEndings(diff))) {
    const doesNotApply = () => new FilesDiffDoesNotApplyError(section.path);
    const before = result.get(section.path);
    if ((before === undefined) !== (section.change === "added")) {
      throw doesNotApply();
    }
    const after = applyHunks(before ?? "", section.hunks);
    if (after === undefined || (section.change === "deleted" && after !== "")) {
      throw doesNotApply();
    }
    if (section.change === "deleted") {
      result.delete(section.path);
    } else {
      result.set(section.path, after);
    }
  }
  return [...result]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, text]) => ({ path, text }));
}

interface FileSection {
  readonly path: string;
  readonly change: "added" | "deleted" | "changed";
  readonly hunks: readonly Hunk[];
}

interface Hunk {
  /** 0-based line of the old text the hunk starts at. */
  readonly start: number;
  /** The old lines and the new lines, each with its "\n" unless it is a last line without one. */
  readonly from: readonly string[];
  readonly to: readonly string[];
}

/**
 * The sections of `diff`; a line that doesn't belong in one makes that
 * section's file fail, and a section header that can't be read fails with no
 * file.
 */
function fileSections(diff: string): FileSection[] {
  const lines = diff === "" ? [] : diff.replace(/\n$/, "").split("\n");
  const sections: FileSection[] = [];
  let index = 0;
  while (index < lines.length) {
    const path = diffGitPath(lines[index] ?? "");
    if (path === undefined) {
      throw new FilesDiffDoesNotApplyError(undefined);
    }
    const doesNotApply = () => new FilesDiffDoesNotApplyError(path);
    index++;
    let change: FileSection["change"] = "changed";
    if (lines[index] === newFileMode || lines[index] === deletedFileMode) {
      change = lines[index] === newFileMode ? "added" : "deleted";
      index++;
    }
    const hunks: Hunk[] = [];
    if (lines[index]?.startsWith("--- ")) {
      // The --- and +++ lines say again what the section's header said.
      const tab = path.includes(" ") ? "\t" : "";
      const a = change === "added" ? devNull : gitPath(`a/${path}`) + tab;
      const b = change === "deleted" ? devNull : gitPath(`b/${path}`) + tab;
      if (lines[index] !== `--- ${a}` || lines[index + 1] !== `+++ ${b}`) {
        throw doesNotApply();
      }
      index += 2;
      while (lines[index]?.startsWith("@@ ")) {
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(
          lines[index] ?? "",
        );
        if (header === null) {
          throw doesNotApply();
        }
        index++;
        const fromCount = Number(header[2] ?? "1");
        const toCount = Number(header[4] ?? "1");
        const from: string[] = [];
        const to: string[] = [];
        while (from.length < fromCount || to.length < toCount) {
          const line = lines[index] ?? "";
          const kind = line[0];
          if (kind !== " " && kind !== "-" && kind !== "+") {
            throw doesNotApply();
          }
          const ended = lines[index + 1] === noNewline;
          const text = ended ? line.slice(1) : `${line.slice(1)}\n`;
          if (kind !== "+") {
            from.push(text);
          }
          if (kind !== "-") {
            to.push(text);
          }
          index += ended ? 2 : 1;
        }
        if (from.length !== fromCount || to.length !== toCount) {
          throw doesNotApply();
        }
        const first = Number(header[1]);
        hunks.push({ start: fromCount === 0 ? first : first - 1, from, to });
      }
    }
    // Anything but the next section's header belongs to this section.
    if (index < lines.length && !lines[index]?.startsWith("diff --git ")) {
      throw doesNotApply();
    }
    if (hunks.length === 0 && change === "changed") {
      throw doesNotApply();
    }
    sections.push({ path, change, hunks });
  }
  return sections;
}

/** The path a `diff --git a/<path> b/<path>` line names; undefined when it isn't one. */
function diffGitPath(line: string): string | undefined {
  const names = line.startsWith("diff --git ")
    ? line.slice("diff --git ".length)
    : "";
  // Both names are the same path, so the line is "<a> <b>" with them equally long.
  const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(names);
  const a = quoted?.[1] ?? names.slice(0, (names.length - 1) / 2);
  const path = a.startsWith('"') ? unquoted(a) : a;
  return path?.startsWith("a/") &&
    names === `${gitPath(path)} ${gitPath(`b/${path.slice(2)}`)}`
    ? path.slice(2)
    : undefined;
}

/** The name in a C-style quoted `name`, undoing gitPath (which never writes an octal escape above 177). */
function unquoted(name: string): string {
  return name
    .slice(1, -1)
    .replace(
      /\\(?:[0-7]{3}|.)/g,
      (escaped) =>
        unescapes.get(escaped) ??
        String.fromCharCode(Number.parseInt(escaped.slice(1), 8)),
    );
}

/**
 * `text` with `hunks` applied in order; undefined when one doesn't match
 * exactly, or a line without a newline would end up before another.
 */
function applyHunks(text: string, hunks: readonly Hunk[]): string | undefined {
  const lines = splitLines(text);
  const out: string[] = [];
  let next = 0;
  for (const hunk of hunks) {
    const at = lines.slice(hunk.start, hunk.start + hunk.from.length);
    if (
      hunk.start < next ||
      at.length !== hunk.from.length ||
      at.some((line, index) => line !== hunk.from[index])
    ) {
      return undefined;
    }
    out.push(...lines.slice(next, hunk.start), ...hunk.to);
    next = hunk.start + hunk.from.length;
  }
  out.push(...lines.slice(next));
  return out.slice(0, -1).every((line) => line.endsWith("\n"))
    ? out.join("")
    : undefined;
}

/** The `from` text of `diff`, a unifiedDiff whose `to` text is `to`. */
export function unapplyUnifiedDiff(diff: string, to: string): string {
  const toLines = splitLines(to);
  const from: string[] = [];
  let next = 0;
  let previous: string | undefined;
  // The first two lines are the --- and +++ headers.
  for (const line of diff.split("\n").slice(2)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header !== null) {
      const first = Number(header[1]);
      const start = header[2] === "0" ? first : first - 1;
      from.push(...toLines.slice(next, start));
      next = start;
    } else if (line === noNewline) {
      if (previous !== "+") {
        from.push((from.pop() ?? "").slice(0, -1));
      }
    } else if (line.startsWith(" ") || line.startsWith("-")) {
      from.push(`${line.slice(1)}\n`);
      next += line.startsWith(" ") ? 1 : 0;
    } else if (line.startsWith("+")) {
      next++;
    }
    previous = line[0];
  }
  from.push(...toLines.slice(next));
  return from.join("");
}

/**
 * A filesDiff doesn't apply to the files it was applied to. Its callers say
 * whose diff it is (SnapshotDiffDoesNotApplyError, store/snapshots.ts).
 */
export class FilesDiffDoesNotApplyError extends Error {
  /** The path of the file whose section failed; undefined when a section header can't be read. */
  readonly file: string | undefined;

  constructor(file: string | undefined) {
    super(
      `The diff doesn't apply${file === undefined ? ": a section header can't be read" : ` to ${file}`}`,
    );
    this.file = file;
  }
}
