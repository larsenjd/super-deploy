// The differ wrapper for supported extensions (ADR-0009). pg-delta ignores
// extension versions: it plans `CREATE EXTENSION <name>` and never a
// version change. After its plan:
// - each `CREATE EXTENSION` gets `VERSION '<v>'`, the version installed in
//   the desired database, which loaded the desired schema's own
//   `CREATE EXTENSION ... VERSION`;
// - an `ALTER EXTENSION <name> UPDATE TO '<v>'` comes first for each
//   extension whose version rose from the source side to the desired side,
//   so later statements can use what the new version adds;
// - an extension whose version fell gets no statement: PostgreSQL ships no
//   downgrade scripts. `draft` refuses it first (`refuseExtensionDowngrades`,
//   `ExtensionDowngradeError`); a rehearsal comparing structure reports it
//   through the catalog comparison, which names both versions, as the
//   rehearsal mismatch any other difference gives;
// - each `COMMENT ON EXTENSION` is left out. The desired schema can't set an
//   extension's comment, so it is the one the install script writes, which
//   `CREATE EXTENSION` writes on the target too.
// The schema change is then checked like any other: the deploy-time rules
// refuse a `CREATE EXTENSION` still without a version, and any
// `COMMENT ON EXTENSION`.
//
// Versions compare as dotted numbers (`compareExtensionVersions`). pg-delta
// plans nothing for a version change, and its `DROP EXTENSION` for a
// removed extension (after the drops of its users) is kept as planned.
//
// Checked against pg-delta 1.0.0-alpha.59, adding citext, pgcrypto and
// uuid-ossp to a desired schema: it plans `CREATE EXTENSION "<name>" SCHEMA
// "<managed schema>"` (the schema exists on the source side), then
// `COMMENT ON EXTENSION "<name>" IS '<the install script's comment>'` for
// each. Never `ALTER EXTENSION ... SET SCHEMA`, since every extension lives
// in the managed schema.
import type { Session } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
import {
  compareExtensionVersions,
  parseSqlFile,
  quoteIdentifier,
  quoteLiteral,
} from "../sql-analysis/index.ts";
import type { Differ, PlannedStatement } from "./types.ts";

/** `differ`, with each `CREATE EXTENSION` it plans pinned to the desired side's version. */
export function withExtensionVersions(differ: Differ): Differ {
  return {
    name: differ.name,
    version: differ.version,
    async diff(source, desired) {
      const statements = await differ.diff(source, desired);
      const versions = await installedVersions(desired);
      const pinned = versionUpdates(await installedVersions(source), versions);
      for (const statement of statements) {
        const node = await syntaxTree(statement.sql);
        if (node?.CommentStmt?.objtype === "OBJECT_EXTENSION") {
          continue;
        }
        pinned.push(
          withVersion(statement, node?.CreateExtensionStmt, versions),
        );
      }
      return pinned;
    },
  };
}

/**
 * `ALTER EXTENSION ... UPDATE TO` for each extension whose version rose
 * from `before` to `after`.
 */
function versionUpdates(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): PlannedStatement[] {
  return versionChanges(before, after)
    .filter(({ from, to }) => compareExtensionVersions(to, from) > 0)
    .map(({ name, to }) => ({
      sql: `ALTER EXTENSION ${quoteIdentifier(name)} UPDATE TO ${quoteLiteral(to)};`,
      destructive: false,
      rewritesTable: false,
    }));
}

/**
 * Throws ExtensionDowngradeError for the first extension whose version
 * falls from `source` to `desired`. `draft` calls it before diffing: a
 * lowered version is a refusal there, and a structural difference anywhere
 * else.
 */
export async function refuseExtensionDowngrades(
  source: Session,
  desired: Session,
): Promise<void> {
  const lowered = versionChanges(
    await installedVersions(source),
    await installedVersions(desired),
  ).find(({ from, to }) => compareExtensionVersions(to, from) < 0);
  if (lowered !== undefined) {
    throw new ExtensionDowngradeError(lowered.name, lowered.from, lowered.to);
  }
}

/** Each extension installed on both sides at different versions. */
function versionChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): { name: string; from: string; to: string }[] {
  return [...before].flatMap(([name, from]) => {
    const to = after.get(name);
    return to === undefined || to === from ? [] : [{ name, from, to }];
  });
}

/** `draft` refused: the desired schema lowers an extension's version. */
export class ExtensionDowngradeError extends SuperDeployError {
  readonly code = "extension-downgrade";

  /** The extension, the version the migrations installed and the lower one desired. */
  readonly extension: string;
  readonly from: string;
  readonly to: string;

  constructor(extension: string, from: string, to: string) {
    super(
      `The desired schema lowers ${extension} from ${from} to ${to}, which PostgreSQL can't do: it has no downgrade scripts. Keep VERSION '${from}' or a higher one`,
    );
    this.extension = extension;
    this.from = from;
    this.to = to;
  }
}

async function installedVersions(
  session: Session,
): Promise<ReadonlyMap<string, string>> {
  const { rows } = await session.query<{ name: string; version: string }>(
    "SELECT extname AS name, extversion AS version FROM pg_catalog.pg_extension",
  );
  return new Map(rows.map(({ name, version }) => [name, version]));
}

/** The statement's syntax tree, for the two kinds of statement this wrapper changes. */
async function syntaxTree(sql: string): Promise<Statement | undefined> {
  if (!/^\s*(CREATE\s+EXTENSION|COMMENT\s+ON\s+EXTENSION)\b/i.test(sql)) {
    return undefined;
  }
  const parsed = await parseSqlFile({ path: "", text: sql });
  return parsed.ok ? (parsed.statements[0]?.node as Statement) : undefined;
}

function withVersion(
  statement: PlannedStatement,
  create: CreateExtensionBody | undefined,
  versions: ReadonlyMap<string, string>,
): PlannedStatement {
  const version = versions.get(create?.extname ?? "");
  const hasVersion = (create?.options ?? []).some(
    (option) => option.DefElem?.defname === "new_version",
  );
  if (version === undefined || hasVersion) {
    return statement;
  }
  const sql = statement.sql.replace(
    /;\s*$/,
    ` VERSION ${quoteLiteral(version)};`,
  );
  return { ...statement, sql };
}

interface Statement {
  readonly CreateExtensionStmt?: CreateExtensionBody;
  readonly CommentStmt?: { readonly objtype?: string };
}

interface CreateExtensionBody {
  readonly extname?: string;
  readonly options?: readonly { readonly DefElem?: { defname?: string } }[];
}
