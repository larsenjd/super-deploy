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
//   (c) no extension that would be created already exists, in any schema,
//       unless an earlier statement of the units drops it: CREATE EXTENSION
//       would fail. The way out names where it is and who owns it, and says
//       to drop it. Moving it wouldn't help: extension names are unique in a
//       database. In the managed schema it is drift `deploy` refuses anyway,
//       but `deploy-draft` doesn't check drift
// The statements come from the units' SQL itself, not the config: finalized
// migrations replay as recorded (ADR-0009, rehearsal/extension-availability.ts).
//
// Each finding carries its one-line message, and each kind has its typed
// error. `status` lists the findings with the other pre-flight refusals
// (PreflightFindings.extensions). `deploy` checks them on the attempt-log
// session before the history schema is created or an attempt opens
// (withLockedTarget's `beforeAttempt`), and `deploy-draft` before YES, so a
// refusal changes nothing and records no attempt.

import type { Session } from "../adapters/types.ts";
import { joined, SuperDeployError } from "../errors.ts";
import {
  type InstalledExtension,
  installedExtensions,
  offeredVersions,
  type UnitExtensionChange,
  unavailableVersions,
  unitExtensionChanges,
} from "../rehearsal/extension-availability.ts";
import type { ReplayUnit } from "../rehearsal/replay.ts";
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

/** (c) An extension a unit creates is already installed. */
export interface ExtensionAlreadyInstalled {
  readonly kind: "already-installed";
  /** The first unit creating it. */
  readonly unit: string;
  /** The extension as the target has it now. */
  readonly installed: InstalledExtension;
  readonly message: string;
}

/** One reason a target can't run the units' extension statements. */
export type ExtensionRefusal =
  | ExtensionVersionUnavailable
  | ExtensionCreateNotPermitted
  | ExtensionAlreadyInstalled;

/**
 * Every reason the target on `session` can't run the extension statements
 * of `units`: (a) per version, (b) once, (c) per extension. Read-only.
 */
export async function extensionRefusals(
  session: Session,
  managedSchema: string,
  units: readonly ReplayUnit[],
): Promise<ExtensionRefusal[]> {
  const changes = await unitExtensionChanges(units);
  if (changes.length === 0) {
    return [];
  }
  const created = createdExtensions(changes);
  const missingCreate = await createNotPermitted(
    session,
    created.map(({ name }) => name),
  );
  return [
    ...(await versionsUnavailable(session, changes)),
    ...(missingCreate === undefined ? [] : [missingCreate]),
    ...(await alreadyInstalled(session, managedSchema, changes)),
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
  const created = createdExtensions(await unitExtensionChanges(units));
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
    case "already-installed":
      return new ExtensionAlreadyInstalledError(target, refusal);
  }
}

/** Each extension `changes` create, with the first unit creating it. */
function createdExtensions(
  changes: readonly UnitExtensionChange[],
): { readonly name: string; readonly unit: string }[] {
  const created = new Map<string, string>();
  for (const { name, unit, change } of changes) {
    if (change === "create" && !created.has(name)) {
      created.set(name, unit);
    }
  }
  return [...created].map(([name, unit]) => ({ name, unit }));
}

/** (a): each version `changes` name that the target doesn't offer, once. */
async function versionsUnavailable(
  session: Session,
  changes: readonly UnitExtensionChange[],
): Promise<ExtensionVersionUnavailable[]> {
  return (await unavailableVersions(session, changes)).map(
    ({ name, version, unit, change, available }) => ({
      kind: "version-unavailable",
      extension: name,
      version,
      unit,
      available,
      message: `the target can't install ${name} ${version}, which ${unit} ${change === "create" ? "installs" : "updates to"}: ${offeredVersions(name, available)}`,
    }),
  );
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

/**
 * (c): each extension `changes` create that the target already has, unless
 * an earlier change drops it first.
 */
async function alreadyInstalled(
  session: Session,
  managedSchema: string,
  changes: readonly UnitExtensionChange[],
): Promise<ExtensionAlreadyInstalled[]> {
  if (!changes.some(({ change }) => change === "create")) {
    return [];
  }
  const present = new Map(
    (await installedExtensions(session)).map((e) => [e.name, e]),
  );
  const refusals: ExtensionAlreadyInstalled[] = [];
  for (const { name, unit, change } of changes) {
    if (change === "update") {
      continue;
    }
    // Once created or dropped, it is the units' own: refused once at most.
    const installed = present.get(name);
    present.delete(name);
    if (change === "drop" || installed === undefined) {
      continue;
    }
    const managed = installed.schema === managedSchema;
    const where = `${managed ? "the managed schema" : "schema"} ${installed.schema}`;
    const why = managed
      ? ""
      : " (moving it doesn't help: extension names are unique in a database)";
    refusals.push({
      kind: "already-installed",
      unit,
      installed,
      message: `${unit} creates extension ${name}, but the target already has it in ${where}, owned by ${installed.owner}: drop it, so that ${unit} installs it${why}`,
    });
  }
  return refusals;
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
 * would be deployed creates is already installed, in the managed schema or
 * another one. Nothing was written, and no attempt was logged.
 */
export class ExtensionAlreadyInstalledError extends SuperDeployError {
  readonly code = "extension-already-installed";
  readonly target: string;
  readonly unit: string;
  readonly installed: InstalledExtension;

  constructor(target: string, refusal: ExtensionAlreadyInstalled) {
    super(refusedMessage(target, refusal));
    this.target = target;
    this.unit = refusal.unit;
    this.installed = refusal.installed;
  }
}

function refusedMessage(target: string, refusal: ExtensionRefusal): string {
  return `Target ${target} failed the extension pre-flight: ${refusal.message}`;
}
