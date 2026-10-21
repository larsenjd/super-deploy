// Unified diffs of text, line by line, as `diff -u` and git write them (three
// lines of context), for the report finalize writes about a hand-edited
// schema change (store/hand-edit.ts); and the way back, the old text from the
// diff and the new text, which unfinalize needs to restore the generated
// schema change.
//
// Lines keep their "\n", so a missing newline at the end is a difference too
// and shows as `\ No newline at end of file`. The longest common subsequence
// is computed after trimming the common start and end, so its table is only
// as large as the edited region.

const context = 3;
const noNewline = "\\ No newline at end of file";

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

/**
 * The unified diff from `from` to `to`, headed `--- <fromLabel>` and
 * `+++ <toLabel>`; empty when they are the same.
 */
export function unifiedDiff(
  from: string,
  to: string,
  labels: { readonly from: string; readonly to: string },
): string {
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
  if (hunks.length === 0) {
    return "";
  }
  // The old and new line numbers (0-based) each edit starts at.
  const at: { from: number; to: number }[] = [];
  let fromLine = 0;
  let toLine = 0;
  for (const edit of all) {
    at.push({ from: fromLine, to: toLine });
    fromLine += edit.kind === "+" ? 0 : 1;
    toLine += edit.kind === "-" ? 0 : 1;
  }
  const out = [`--- ${labels.from}`, `+++ ${labels.to}`];
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
  return `${out.join("\n")}\n`;
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
