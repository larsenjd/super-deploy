// The extension pre-flight (ADR-0009, spec "Pre-flight"): read-only checks
// that a target can run the extension statements of what a command would
// deploy (the pending migrations, or the draft and its seed data), before
// anything changes on it:
//   (a) every version a `CREATE EXTENSION ... VERSION` or `ALTER EXTENSION
//       ... UPDATE TO` names is in the target's pg_available_extension_versions:
//       nothing ever falls back to another version, and an older target
//       (ADR-0007) is refused by this same check
//   (b) when anything creates an extension, the deploy role has CREATE on the
//       database (no check otherwise, so targets need no more than before).
//       `missingCreateExtensions` is also what rebuild checks its replay with
//   (c) no extension that would be created already exists in another schema:
//       extension names are database-wide, so CREATE EXTENSION would fail.
//       The way out names where it is and who owns it, and says to move it
//       with ALTER EXTENSION ... SET SCHEMA or drop it (the ticket's wording)
// The versions come from the units' SQL itself, not the config: finalized
// migrations replay as recorded (ADR-0009).
//
// Each finding carries its one-line message, and each kind has its typed
// error. `status` lists the findings with the other pre-flight refusals
// (PreflightFindings.extensions). `deploy` checks them on the attempt-log
// session before the history schema is created or an attempt opens
// (withLockedTarget's `beforeAttempt`), and `deploy-draft` before YES, so a
// refusal changes nothing and records no attempt.

import type { Session } from "../adapters/types.ts";
import { joined, SuperDeployError } from "../errors.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
import {
  compareExtensionVersions,
  type ExtensionVersionStatement,
  extensionVersionStatements,
  parseSqlFile,
} from "../sql-analysis/index.ts";
import { missingCreateOnDatabase } from "./target.ts";

/** (a) The target doesn't offer a version a unit installs or updates to. */
export interface ExtensionVersionUnavailable {
  readonly kind: "version-unavailable";
  readonly extension: string;
  readonly version: string;
  /** The first unit naming that version, e.g. `00002-add-emails` or `draft add-emails`. */
  readonly unit: string;
  /** The versions of the extension the target offers, oldest first; empty when it offers none. */
  readonly available: readonly string[];
  readonly message: string;
}

/** (b) The units create extensions, and the deploy role lacks CREATE on the database. */
export interface ExtensionCreateNotPermitted {
  readonly kind: "create-not-permitted";
  /** The extensions the units create, in order of first creation. */
  readonly extensions: readonly string[];
  /** The deploy role (the session's current role). */
  readonly role: string;
  readonly database: string;
  /** The statement a DBA runs, e.g. `GRANT CREATE ON DATABASE shop TO deployer`. */
  readonly fix: string;
  readonly message: string;
}

/** (c) An extension a unit creates is already installed in another schema. */
export interface ExtensionInstalledElsewhere {
  readonly kind: "installed-elsewhere";
  readonly extension: string;
  /** The first unit creating it. */
  readonly unit: string;
  /** The schema it is installed in now. */
  readonly schema: string;
  readonly owner: string;
  readonly message: string;
}

/** One reason a target can't run the units' extension statements. */
export type ExtensionRefusal =
  | ExtensionVersionUnavailable
  | ExtensionCreateNotPermitted
  | ExtensionInstalledElsewhere;

/** An extension statement of a unit. */
interface UnitExtensionStatement extends ExtensionVersionStatement {
  readonly unit: string;
}

/**
 * Every reason the target on `session` can't run the extension statements
 * of `units`: (a) per version, (b) once, (c) per extension. Read-only.
 */
export async function extensionRefusals(
  session: Session,
  managedSchema: string,
  units: readonly ReplayUnit[],
): Promise<ExtensionRefusal[]> {
  const statements = await unitExtensionStatements(units);
  if (statements.length === 0) {
    return [];
  }
  const created = createdExtensions(statements);
  const missingCreate = await createNotPermitted(
    session,
    created.map(({ name }) => name),
  );
  return [
    ...(await versionsUnavailable(session, statements)),
    ...(missingCreate === undefined ? [] : [missingCreate]),
    ...(await installedElsewhere(session, managedSchema, created)),
  ];
}

/**
 * (b) alone: the deploy role lacks CREATE on the database and `units`
 * create an extension. Undefined otherwise. Read-only.
 */
export async function missingCreateExtensions(
  session: Session,
  units: readonly ReplayUnit[],
): Promise<ExtensionCreateNotPermitted | undefined> {
  const created = createdExtensions(await unitExtensionStatements(units));
  return createNotPermitted(
    session,
    created.map(({ name }) => name),
  );
}

/**
 * Throws the typed error of the first of `extensionRefusals`, naming
 * `target`.
 */
export async function requireExtensionsDeployable(
  session: Session,
  target: string,
  managedSchema: string,
  units: readonly ReplayUnit[],
): Promise<void> {
  const [refusal] = await extensionRefusals(session, managedSchema, units);
  if (refusal !== undefined) {
    throw extensionRefusalError(target, refusal);
  }
}

/** The typed error for `refusal` on `target`. */
export function extensionRefusalError(
  target: string,
  refusal: ExtensionRefusal,
): SuperDeployError {
  switch (refusal.kind) {
    case "version-unavailable":
      return new ExtensionVersionUnavailableError(target, refusal);
    case "create-not-permitted":
      return new ExtensionCreateNotPermittedError(target, refusal);
    case "installed-elsewhere":
      return new ExtensionInstalledElsewhereError(target, refusal);
  }
}

/** Each extension statement naming a version in `units`' files, in run order. */
async function unitExtensionStatements(
  units: readonly ReplayUnit[],
): Promise<UnitExtensionStatement[]> {
  const found: UnitExtensionStatement[] = [];
  for (const unit of units) {
    for (const { file, sql } of unit.files) {
      // Every file passed the deploy-time rules, so it parses.
      const parsed = await parseSqlFile({ path: file, text: sql });
      for (const statement of extensionVersionStatements(
        parsed.ok ? parsed.statements : [],
      )) {
        found.push({ ...statement, unit: unit.label });
      }
    }
  }
  return found;
}

/** Each extension `statements` create, with the first unit creating it. */
function createdExtensions(
  statements: readonly UnitExtensionStatement[],
): { readonly name: string; readonly unit: string }[] {
  const created = new Map<string, string>();
  for (const { name, unit, creates } of statements) {
    if (creates && !created.has(name)) {
      created.set(name, unit);
    }
  }
  return [...created].map(([name, unit]) => ({ name, unit }));
}

/** (a): each version `statements` name that the target doesn't offer, once. */
async function versionsUnavailable(
  session: Session,
  statements: readonly UnitExtensionStatement[],
): Promise<ExtensionVersionUnavailable[]> {
  const { rows } = await session.query<{ name: string; version: string }>(
    "SELECT name, version FROM pg_catalog.pg_available_extension_versions WHERE name = ANY($1)",
    [statements.map(({ name }) => name)],
  );
  const refusals: ExtensionVersionUnavailable[] = [];
  for (const { name, version, unit, creates } of statements) {
    if (
      version === undefined ||
      rows.some((row) => row.name === name && row.version === version) ||
      refusals.some((r) => r.extension === name && r.version === version)
    ) {
      continue;
    }
    const available = rows
      .filter((row) => row.name === name)
      .map((row) => row.version)
      .sort(compareExtensionVersions);
    const offers =
      available.length === 0
        ? `it doesn't offer ${name}`
        : `it offers ${name} ${available.join(", ")}`;
    refusals.push({
      kind: "version-unavailable",
      extension: name,
      version,
      unit,
      available,
      message: `the target can't install ${name} ${version}, which ${unit} ${creates ? "installs" : "updates to"}: ${offers}`,
    });
  }
  return refusals;
}

/** (b): when `extensions` isn't empty and the deploy role lacks CREATE on the database. */
async function createNotPermitted(
  session: Session,
  extensions: readonly string[],
): Promise<ExtensionCreateNotPermitted | undefined> {
  if (extensions.length === 0) {
    return undefined;
  }
  const missing = await missingCreateOnDatabase(session);
  return missing === undefined
    ? undefined
    : {
        kind: "create-not-permitted",
        extensions,
        ...missing,
        message: createExtensionMessage(missing, extensions),
      };
}

/**
 * The line for a deploy role that lacks CREATE on the database to create
 * `extensions`, with the GRANT a DBA runs: shared by every command that
 * checks it.
 */
export function createExtensionMessage(
  missing: {
    readonly role: string;
    readonly database: string;
    readonly fix: string;
  },
  extensions: readonly string[],
): string {
  const what = `${extensions.length === 1 ? "extension" : "extensions"} ${joined(extensions)}`;
  return `the deploy role ${missing.role} needs CREATE on database ${missing.database} to create ${what} (a DBA runs: ${missing.fix})`;
}

/** (c): each extension `created` names that is installed outside `managedSchema`. */
async function installedElsewhere(
  session: Session,
  managedSchema: string,
  created: readonly { readonly name: string; readonly unit: string }[],
): Promise<ExtensionInstalledElsewhere[]> {
  if (created.length === 0) {
    return [];
  }
  const { rows } = await session.query<{
    name: string;
    schema: string;
    owner: string;
  }>(
    `SELECT e.extname AS name, n.nspname AS schema, pg_catalog.pg_get_userbyid(e.extowner) AS owner
       FROM pg_catalog.pg_extension e
       JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = ANY($1) AND n.nspname <> $2`,
    [created.map(({ name }) => name), managedSchema],
  );
  return created.flatMap(({ name, unit }) => {
    const row = rows.find((r) => r.name === name);
    return row === undefined
      ? []
      : [
          {
            kind: "installed-elsewhere",
            extension: name,
            unit,
            schema: row.schema,
            owner: row.owner,
            message: `${unit} creates extension ${name}, but the target already has it in schema ${row.schema}, owned by ${row.owner}: move it with ALTER EXTENSION ${name} SET SCHEMA, or drop it`,
          },
        ];
  });
}

/**
 * A command refused a target before changing anything: it doesn't offer an
 * extension version what would be deployed installs. Nothing was written,
 * and no attempt was logged.
 */
export class ExtensionVersionUnavailableError extends SuperDeployError {
  readonly code = "extension-version-unavailable";
  readonly target: string;
  readonly extension: string;
  readonly version: string;
  readonly unit: string;
  /** The versions the target offers, oldest first. */
  readonly available: readonly string[];

  constructor(target: string, refusal: ExtensionVersionUnavailable) {
    super(refusedMessage(target, refusal));
    this.target = target;
    this.extension = refusal.extension;
    this.version = refusal.version;
    this.unit = refusal.unit;
    this.available = refusal.available;
  }
}

/**
 * A command refused a target before changing anything: what would be
 * deployed creates an extension, and the deploy role lacks CREATE on the
 * database. Nothing was written, and no attempt was logged.
 */
export class ExtensionCreateNotPermittedError extends SuperDeployError {
  readonly code = "extension-create-not-permitted";
  readonly target: string;
  readonly extensions: readonly string[];
  readonly role: string;
  readonly database: string;
  /** The GRANT a DBA runs. */
  readonly fix: string;

  constructor(target: string, refusal: ExtensionCreateNotPermitted) {
    super(refusedMessage(target, refusal));
    this.target = target;
    this.extensions = refusal.extensions;
    this.role = refusal.role;
    this.database = refusal.database;
    this.fix = refusal.fix;
  }
}

/**
 * A command refused a target before changing anything: an extension what
 * would be deployed creates is already installed in another schema. Nothing
 * was written, and no attempt was logged.
 */
export class ExtensionInstalledElsewhereError extends SuperDeployError {
  readonly code = "extension-installed-elsewhere";
  readonly target: string;
  readonly extension: string;
  readonly unit: string;
  readonly schema: string;
  readonly owner: string;

  constructor(target: string, refusal: ExtensionInstalledElsewhere) {
    super(refusedMessage(target, refusal));
    this.target = target;
    this.extension = refusal.extension;
    this.unit = refusal.unit;
    this.schema = refusal.schema;
    this.owner = refusal.owner;
  }
}

function refusedMessage(target: string, refusal: ExtensionRefusal): string {
  return `Target ${target} failed the extension pre-flight: ${refusal.message}`;
}
