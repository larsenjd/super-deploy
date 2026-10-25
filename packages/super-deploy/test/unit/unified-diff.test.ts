// The multi-file diff a migration keeps its snapshot as (ADR-0008), at the
// diff module's own seam (database-free): what the writer writes, that the
// applier gives back exactly the files it was written from, and that `git
// apply` reads it the same way.
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  applyFilesDiff,
  filesDiff,
  SnapshotDiffDoesNotApplyError,
} from "../../src/store/unified-diff.ts";

interface Files {
  readonly [path: string]: string;
}

function asFiles(files: Files) {
  return Object.entries(files).map(([path, text]) => ({ path, text }));
}

/** `after`'s files, from applying the diff from `before` to `after` to `before`. */
function roundTrip(before: Files, after: Files): Files {
  const diff = filesDiff(asFiles(before), asFiles(after));
  return Object.fromEntries(
    applyFilesDiff(diff, asFiles(before), "migration 3").map((file) => [
      file.path,
      file.text,
    ]),
  );
}

/** Lines "1\n" to "<count>\n". */
function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `${index + 1}\n`).join("");
}

/** The edge cases a desired schema's history can hold, from one set of files to the next. */
const histories: readonly {
  readonly name: string;
  readonly before: Files;
  readonly after: Files;
}[] = [
  {
    name: "a trailing newline removed",
    before: { "a.sql": "one\ntwo\n" },
    after: { "a.sql": "one\ntwo" },
  },
  {
    name: "a trailing newline added",
    before: { "a.sql": "one\ntwo" },
    after: { "a.sql": "one\ntwo\n" },
  },
  {
    name: "the last line changed with no trailing newline on either side",
    before: { "a.sql": "one\ntwo" },
    after: { "a.sql": "one\n2" },
  },
  {
    name: "an empty file added, emptied, filled and deleted",
    before: { "emptied.sql": "x\n", "filled.sql": "", "deleted.sql": "" },
    after: { "added.sql": "", "emptied.sql": "", "filled.sql": "x\n" },
  },
  {
    name: "a file replaced at the same path by one with nothing in common",
    before: { "a.sql": "one\ntwo\n" },
    after: { "a.sql": "three\nfour" },
  },
  {
    name: "a file deleted and a folder of the same name added",
    before: { "sales.sql": "one\n" },
    after: { "sales.sql/orders.sql": "one\n" },
  },
  {
    name: "many hunks in one file",
    before: { "a.sql": numbered(40) },
    after: {
      "a.sql": numbered(40)
        .replace("2\n", "two\n")
        .replace("\n20\n", "\ntwenty\n")
        .replace("\n27\n", "\n")
        .replace("\n40\n", "\n40\n41"),
    },
  },
  {
    name: "files added to and deleted from nested folders",
    before: { "a/b/c.sql": "c\n", "a/d.sql": "d\n", "e.sql": "e\n" },
    after: {
      "a/d.sql": "d\n",
      "e.sql": "e\n",
      "f/g/h.sql": "h\n",
      "f/i.sql": "i",
    },
  },
  {
    name: "paths git quotes or ends with a tab",
    before: { 'quote".sql': "a\n", "back\\slash.sql": "b\n" },
    after: {
      'quote".sql': "A\n",
      "with space.sql": "c\n",
      "tab\there.sql": "d\n",
    },
  },
];

describe("filesDiff", () => {
  test("a changed file is a git-style section with three lines of context", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n";
    const after = "1\n2\n3\n4\nfive\n6\n7\n8\n";
    expect(
      filesDiff(
        [
          { path: "orders.sql", text: before },
          { path: "customers.sql", text: "kept\n" },
        ],
        [
          { path: "customers.sql", text: "kept\n" },
          { path: "orders.sql", text: after },
        ],
      ),
    ).toBe(
      [
        "diff --git a/orders.sql b/orders.sql",
        "--- a/orders.sql",
        "+++ b/orders.sql",
        "@@ -2,7 +2,7 @@",
        " 2",
        " 3",
        " 4",
        "-5",
        "+five",
        " 6",
        " 7",
        " 8",
        "",
      ].join("\n"),
    );
  });

  test("an added or deleted file has /dev/null on the other side, in path order", () => {
    expect(
      filesDiff(
        [{ path: "sales/orders.sql", text: "old\n" }],
        [{ path: "billing/invoices.sql", text: "new\nlast" }],
      ),
    ).toBe(
      [
        "diff --git a/billing/invoices.sql b/billing/invoices.sql",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/billing/invoices.sql",
        "@@ -0,0 +1,2 @@",
        "+new",
        "+last",
        "\\ No newline at end of file",
        "diff --git a/sales/orders.sql b/sales/orders.sql",
        "deleted file mode 100644",
        "--- a/sales/orders.sql",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old",
        "",
      ].join("\n"),
    );
  });

  test("line endings alone are no change, and the diff has LF line endings", () => {
    expect(
      filesDiff(
        [{ path: "a.sql", text: "one\r\ntwo\r\n" }],
        [{ path: "a.sql", text: "one\ntwo\n" }],
      ),
    ).toBe("");
    expect(
      filesDiff(
        [{ path: "a.sql", text: "one\r\ntwo\r\n" }],
        [{ path: "a.sql", text: "one\r\n2\r\n" }],
      ),
    ).toBe(
      [
        "diff --git a/a.sql b/a.sql",
        "--- a/a.sql",
        "+++ b/a.sql",
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "+2",
        "",
      ].join("\n"),
    );
  });

  test("the same files give an empty diff", () => {
    const files = [{ path: "orders.sql", text: "create table orders ();\n" }];
    expect(filesDiff(files, files)).toBe("");
  });
});

describe("applyFilesDiff", () => {
  test.each(histories)(
    "gives back the files after $name",
    ({ before, after }) => {
      expect(roundTrip(before, after)).toEqual(after);
    },
  );

  test("gives LF line endings from files with CRLF ones", () => {
    expect(
      roundTrip(
        { "a.sql": "one\r\ntwo\r\n", "b.sql": "b\r\n" },
        { "a.sql": "one\r\n2\r\n", "b.sql": "b\r\n" },
      ),
    ).toEqual({ "a.sql": "one\n2\n", "b.sql": "b\n" });
  });

  const twelve = numbered(12);
  const doesNotApply: readonly {
    readonly name: string;
    readonly before: Files;
    readonly after: Files;
    readonly appliedTo: Files;
  }[] = [
    {
      name: "a removed line that isn't there",
      before: { "a.sql": twelve },
      after: { "a.sql": twelve.replace("\n6\n", "\n") },
      appliedTo: { "a.sql": twelve.replace("\n6\n", "\nsix\n") },
    },
    {
      name: "a context line that isn't there",
      before: { "a.sql": twelve },
      after: { "a.sql": twelve.replace("\n6\n", "\n") },
      appliedTo: { "a.sql": twelve.replace("\n4\n", "\nfour\n") },
    },
    {
      name: "a hunk whose lines are there, a line further down",
      before: { "a.sql": twelve },
      after: { "a.sql": twelve.replace("\n6\n", "\n") },
      appliedTo: { "a.sql": `0\n${twelve}` },
    },
    {
      name: "a last line that has a newline the diff says it hasn't",
      before: { "a.sql": "one\ntwo" },
      after: { "a.sql": "one\n2" },
      appliedTo: { "a.sql": "one\ntwo\n" },
    },
    {
      name: "a file deleted that holds more than the diff removes",
      before: { "a.sql": "one\n" },
      after: {},
      appliedTo: { "a.sql": "one\ntwo\n" },
    },
    {
      name: "an empty file deleted that isn't empty",
      before: { "a.sql": "" },
      after: {},
      appliedTo: { "a.sql": "one\n" },
    },
    {
      name: "a file added that is there already",
      before: {},
      after: { "a.sql": "one\n" },
      appliedTo: { "a.sql": "" },
    },
    {
      name: "a file changed that isn't there",
      before: { "a.sql": "one\n" },
      after: { "a.sql": "two\n" },
      appliedTo: { "b.sql": "one\n" },
    },
  ];

  test("refuses a hunk that would end a line before another without a newline", () => {
    const diff = [
      "diff --git a/a.sql b/a.sql",
      "--- a/a.sql",
      "+++ b/a.sql",
      "@@ -1 +1 @@",
      "-one",
      "+1",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(() =>
      applyFilesDiff(diff, asFiles({ "a.sql": "one\ntwo\n" }), "migration 3"),
    ).toThrow(SnapshotDiffDoesNotApplyError);
  });

  test.each(doesNotApply)(
    "refuses $name, naming the migration and the file",
    ({ before, after, appliedTo }) => {
      const diff = filesDiff(asFiles(before), asFiles(after));
      let thrown: unknown;
      try {
        applyFilesDiff(diff, asFiles(appliedTo), "migration 3");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SnapshotDiffDoesNotApplyError);
      expect(thrown).toMatchObject({
        code: "snapshot-diff-does-not-apply",
        migration: "migration 3",
        file: "a.sql",
      });
    },
  );
});

const gitInstalled = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!gitInstalled)("git apply", () => {
  // Windows can't name a file with a quote, a backslash or a tab.
  const onThisDisk = histories.filter(
    ({ before, after }) =>
      process.platform !== "win32" ||
      ![...Object.keys(before), ...Object.keys(after)].some((path) =>
        /["\\\t]/.test(path),
      ),
  );

  test.each(onThisDisk)(
    "gives the same files after $name",
    async ({ before, after }) => {
      const dir = await mkdtemp(join(tmpdir(), "super-deploy-diff-"));
      onTestFinished(() => rm(dir, { recursive: true, force: true }));
      for (const [path, text] of Object.entries(before)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
      }
      // Outside a repository, git apply patches the files in its working directory.
      const applied = spawnSync("git", ["apply", "-"], {
        cwd: dir,
        input: filesDiff(asFiles(before), asFiles(after)),
        encoding: "utf8",
      });
      expect(applied.stderr).toBe("");
      expect(applied.status).toBe(0);
      const files: Record<string, string> = {};
      for (const entry of await readdir(dir, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (entry.isFile()) {
          const path = join(entry.parentPath, entry.name);
          files[
            path
              .slice(dir.length + 1)
              .split(sep)
              .join("/")
          ] = await readFile(path, "utf8");
        }
      }
      expect(files).toEqual(after);
    },
  );
});
