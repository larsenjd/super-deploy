// Checks that a PostgreSQL server offers the supported extensions (ADR-0009)
// as the tool knows them: for maintainers confirming the supported set on a
// real target, such as an Aurora PostgreSQL 18.4 cluster. It only reads
// `pg_available_extension_versions`, so any login role will do and nothing
// is installed or changed.
//
// Usage, from packages/super-deploy (quote the connection string):
//   node scripts/check-supported-extensions.ts "postgres://user:password@host:5432/postgres?sslmode=require"
//
// Exit codes: 0 when every extension passes, 1 when any differs, 2 for a
// usage error. A connection failure prints node-postgres's error.
//
// The report, one line each:
//   Server: PostgreSQL 18.4
//     The server's version (`SHOW server_version`).
//   PASS citext: trusted, offers exactly the known versions 1.4, 1.5, 1.6, 1.7, 1.8
//     The server offers exactly the versions the tool knows
//     (src/sql-analysis/supported-extensions.ts), each trusted, so a deploy
//     role with CREATE on the database can install any of them.
//   FAIL citext: expected 1.4, ..., 1.8; server offers 1.4, 1.5, 1.6; missing 1.7, 1.8
//     The extension differs. After "expected", the versions the tool knows;
//     then, separated by "; ", each way the server differs:
//     - "server doesn't offer it": no version at all.
//     - "server offers <versions>": every version it offers, shown whenever
//       they aren't exactly the expected ones.
//     - "missing <versions>": versions the tool knows that the server lacks.
//       A project on this server can't pin them.
//     - "not known to the tool <versions>": versions the server offers that
//       the tool doesn't know. Adding one means regenerating the supported
//       set from an embedded-postgres that offers it.
//     - "not trusted at <versions>": known versions only a superuser can
//       install, which a deploy role therefore can't.
//   PASS: all 17 supported extensions match
//   FAIL: 2 of 17 supported extensions differ: citext, pgcrypto
//     The summary.
//
// What it can't see: on RDS and Aurora, `rds.allowed_extensions` can forbid
// an extension the server lists. Run `SHOW rds.allowed_extensions` too; `*`
// (the default) allows all.
import pg from "pg";
import { supportedExtensionVersions } from "../src/sql-analysis/supported-extensions.ts";
import { compareExtensionVersions } from "../src/sql-analysis/version-order.ts";

export interface ExtensionReport {
  /** Whether every expected extension matches. */
  readonly passed: boolean;
  /** The report's lines, as the script prints them. */
  readonly lines: readonly string[];
}

/**
 * Compares the server at `connectionString` with `expected`, extension names
 * to the versions the tool knows (default: the supported set).
 */
export async function checkSupportedExtensions(
  connectionString: string,
  expected: Readonly<
    Record<string, readonly string[]>
  > = supportedExtensionVersions,
): Promise<ExtensionReport> {
  const client = new pg.Client({ connectionString });
  client.on("error", () => {});
  await client.connect();
  let serverVersion: string | undefined;
  let rows: { name: string; version: string; trusted: boolean }[];
  try {
    serverVersion = (
      await client.query<{ server_version: string }>("SHOW server_version")
    ).rows[0]?.server_version;
    rows = (
      await client.query<{ name: string; version: string; trusted: boolean }>(
        "SELECT name, version, trusted FROM pg_available_extension_versions WHERE name = ANY($1)",
        [Object.keys(expected)],
      )
    ).rows;
  } finally {
    await client.end();
  }

  const lines = [`Server: PostgreSQL ${serverVersion}`];
  const differing: string[] = [];
  for (const [name, versions] of Object.entries(expected)) {
    const offered = rows.filter((row) => row.name === name);
    const problems = extensionProblems(versions, offered);
    if (problems.length === 0) {
      lines.push(
        `PASS ${name}: trusted, offers exactly the known versions ${versions.join(", ")}`,
      );
    } else {
      differing.push(name);
      lines.push(
        `FAIL ${name}: ${[`expected ${versions.join(", ")}`, ...problems].join("; ")}`,
      );
    }
  }
  const total = Object.keys(expected).length;
  lines.push(
    differing.length === 0
      ? `PASS: all ${total} supported extensions match`
      : `FAIL: ${differing.length} of ${total} supported extensions differ: ${differing.join(", ")}`,
  );
  return { passed: differing.length === 0, lines };
}

function extensionProblems(
  expected: readonly string[],
  offered: readonly { version: string; trusted: boolean }[],
): string[] {
  if (offered.length === 0) {
    return ["server doesn't offer it"];
  }
  const offeredVersions = offered.map((row) => row.version);
  const missing = expected.filter(
    (version) => !offeredVersions.includes(version),
  );
  const unknown = offeredVersions
    .filter((version) => !expected.includes(version))
    .sort(compareExtensionVersions);
  const untrusted = offered
    .filter((row) => expected.includes(row.version) && !row.trusted)
    .map((row) => row.version)
    .sort(compareExtensionVersions);
  const problems: string[] = [];
  if (missing.length > 0 || unknown.length > 0) {
    problems.push(
      `server offers ${offeredVersions.sort(compareExtensionVersions).join(", ")}`,
    );
  }
  if (missing.length > 0) {
    problems.push(`missing ${missing.join(", ")}`);
  }
  if (unknown.length > 0) {
    problems.push(`not known to the tool ${unknown.join(", ")}`);
  }
  if (untrusted.length > 0) {
    problems.push(`not trusted at ${untrusted.join(", ")}`);
  }
  return problems;
}

if (import.meta.main) {
  const connectionString = process.argv[2];
  if (connectionString === undefined || process.argv.length > 3) {
    console.error(
      'Usage: node scripts/check-supported-extensions.ts <connection string>\n  e.g. node scripts/check-supported-extensions.ts "postgres://user:password@host:5432/postgres"',
    );
    process.exitCode = 2;
  } else {
    const report = await checkSupportedExtensions(connectionString);
    console.log(report.lines.join("\n"));
    process.exitCode = report.passed ? 0 : 1;
  }
}
