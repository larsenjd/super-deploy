// The maintainer scripts behind the supported set (ADR-0009): the generated
// source matches a fresh run, and the check script compares a server's
// extensions with the set.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checkSupportedExtensions } from "../../scripts/check-supported-extensions.ts";
import { supportedExtensionsSource } from "../../scripts/generate-supported-extensions.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

const packageDir = join(import.meta.dirname, "..", "..");

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

test("the committed supported extensions are what the generation script reads from embedded PostgreSQL", async () => {
  const committed = await readFile(
    join(packageDir, "src", "sql-analysis", "supported-extensions.ts"),
    "utf8",
  );

  const generated = await supportedExtensionsSource(
    await server.connectionString(),
  );

  expect(generated).toBe(committed);
  expect(committed).toContain(`"citext": ["1.4","1.5","1.6","1.7","1.8"],`);
  expect(committed).toContain(`"pgcrypto": ["1.3","1.4"],`);
});

test("the check script passes every supported extension on embedded PostgreSQL 18", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["scripts/check-supported-extensions.ts", await server.connectionString()],
    { cwd: packageDir },
  );

  const lines = stdout.trimEnd().split("\n");
  expect(lines.filter((line) => line.startsWith("PASS "))).toHaveLength(17);
  expect(lines).toContain(
    "PASS citext: trusted, offers exactly the known versions 1.4, 1.5, 1.6, 1.7, 1.8",
  );
  expect(lines.at(-1)).toBe("PASS: all 17 supported extensions match");
});

test("the check script names each extension that differs, with what was expected and what the server has", async () => {
  const report = await checkSupportedExtensions(
    await server.connectionString(),
    {
      citext: ["1.4", "1.9"],
      earthdistance: ["1.1", "1.2"],
      postgis: ["3.5"],
      pgcrypto: ["1.3", "1.4"],
    },
  );

  expect(report.passed).toBe(false);
  expect(report.lines.slice(1)).toEqual([
    "FAIL citext: expected 1.4, 1.9; server offers 1.4, 1.5, 1.6, 1.7, 1.8; missing 1.9; not known to the tool 1.5, 1.6, 1.7, 1.8",
    "FAIL earthdistance: expected 1.1, 1.2; not trusted at 1.1, 1.2",
    "FAIL postgis: expected 3.5; server doesn't offer it",
    "PASS pgcrypto: trusted, offers exactly the known versions 1.3, 1.4",
    "FAIL: 3 of 4 supported extensions differ: citext, earthdistance, postgis",
  ]);
});

test("the check script exits 1 and explains its usage without a connection string", async () => {
  const error = await promisify(execFile)(
    process.execPath,
    ["scripts/check-supported-extensions.ts"],
    { cwd: packageDir },
  ).catch((e: unknown) => e as { code: number; stderr: string });

  expect(error).toMatchObject({ code: 2 });
  expect((error as { stderr: string }).stderr).toContain(
    "Usage: node scripts/check-supported-extensions.ts <connection string>",
  );
});
