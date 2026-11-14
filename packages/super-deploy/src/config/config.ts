// The typed project configuration (super-deploy.config.ts) and its validation.
// Never in config: credentials, the disposable flag, migration state.

import { isAbsolute, normalize } from "node:path";
import type { DeploymentAdapter, RehearsalAdapter } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";
import { isSupportedExtension } from "../sql-analysis/extensions.ts";
import type { ListedExtensions } from "../sql-analysis/rule-types.ts";
import {
  type SupportedExtension,
  supportedExtensionVersions,
} from "../sql-analysis/supported-extensions.ts";

/** A duration: milliseconds as a number, or a string such as `"500ms"`, `"5s"`, `"2min"`. */
export type Duration = number | string;

export interface TargetConfig {
  /** How to connect to this target. */
  adapter: DeploymentAdapter;
  /** `lock_timeout` inside deployments. Default `"5s"`. */
  lockTimeout?: Duration;
  /** `statement_timeout` inside deployments. Default none. */
  statementTimeout?: Duration;
  /** How long a connection to this target may take before it fails. Default `"10s"`. */
  connectTimeout?: Duration;
}

export interface SuperDeployConfig {
  /**
   * The PostgreSQL major version every target runs. Only 18 is supported;
   * another is an escape hatch for adopting a database (ADR-0007).
   */
  postgresVersion: number;
  /** Provides throwaway databases for rehearsals. */
  rehearsal: RehearsalAdapter;
  /** Named targets, e.g. `dev`, `qa`, `prod`. */
  targets?: Record<string, TargetConfig>;
  /** The one schema super-deploy manages. Default `public`. */
  managedSchema?: string;
  /** The schema recording deployments on each target. Default `deployment_history`. */
  historySchema?: string;
  /** Schemas PL/pgSQL routines may reference but super-deploy neither creates nor reproduces. Default none. */
  externalSchemas?: readonly string[];
  /** The project directory, relative to the config file. Default `data-model`. */
  directory?: string;
  /**
   * The supported extensions the desired schema may install, each with the
   * versions it may install (ADR-0009), e.g. `{ citext: ["1.8"] }`. Default none.
   */
  extensions?: ExtensionsConfig;
}

/** Supported extension names to the versions a project may use of each. */
export type ExtensionsConfig = {
  readonly [Name in SupportedExtension]?: readonly (typeof supportedExtensionVersions)[Name][number][];
};

/** Identity function that types a super-deploy.config.ts default export. */
export function defineConfig(config: SuperDeployConfig): SuperDeployConfig {
  return config;
}

export interface ResolvedTarget {
  readonly name: string;
  readonly adapter: DeploymentAdapter;
  readonly lockTimeoutMs: number;
  /** Whether the config sets lockTimeout; false when it is the default. */
  readonly lockTimeoutSet: boolean;
  readonly statementTimeoutMs: number | undefined;
  readonly connectTimeoutMs: number;
  /**
   * The PostgreSQL major version its server must run: the config's
   * postgresVersion. Default 18, for a target built by hand.
   */
  readonly postgresVersion?: number;
}

/** A target's timeouts when its config sets none; no statement timeout by default. */
export const targetDefaults = {
  lockTimeoutMs: 5000,
  statementTimeoutMs: undefined,
  connectTimeoutMs: 10_000,
} as const satisfies Omit<
  ResolvedTarget,
  "name" | "adapter" | "lockTimeoutSet" | "postgresVersion"
>;

/** A validated configuration with every default applied. */
export interface ResolvedConfig {
  readonly postgresVersion: number;
  readonly rehearsal: RehearsalAdapter;
  readonly targets: Readonly<Record<string, ResolvedTarget>>;
  readonly managedSchema: string;
  readonly historySchema: string;
  readonly externalSchemas: readonly string[];
  readonly directory: string;
  /** Each supported extension the project may use, with its versions; empty by default. */
  readonly extensions: ListedExtensions;
}

const settings = new Set([
  "postgresVersion",
  "rehearsal",
  "targets",
  "managedSchema",
  "historySchema",
  "externalSchemas",
  "directory",
  "extensions",
]);
const targetSettings = new Set([
  "adapter",
  "lockTimeout",
  "statementTimeout",
  "connectTimeout",
]);
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const targetName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Validates a config file's default export, naming the first invalid setting. */
export function resolveConfig(raw: unknown): ResolvedConfig {
  if (!isRecord(raw)) {
    throw new ConfigError(
      "super-deploy.config.ts must `export default defineConfig({ ... })` with an object",
    );
  }
  rejectUnknown(raw, settings, "");

  const postgresVersion = raw.postgresVersion;
  if (
    typeof postgresVersion !== "number" ||
    !Number.isInteger(postgresVersion) ||
    postgresVersion < 1
  ) {
    throw invalid(
      "postgresVersion",
      `must be a PostgreSQL major version such as 18, got ${describe(postgresVersion)}`,
    );
  }
  if (!hasMethod(raw.rehearsal, "createDatabase")) {
    throw invalid(
      "rehearsal",
      "must be a rehearsal adapter with a createDatabase() method",
    );
  }

  const managedSchema = schemaName(
    raw.managedSchema,
    "managedSchema",
    "public",
  );
  const historySchema = schemaName(
    raw.historySchema,
    "historySchema",
    "deployment_history",
  );
  if (historySchema === managedSchema) {
    throw invalid("historySchema", "must differ from managedSchema");
  }

  let externalSchemas: string[] = [];
  if (raw.externalSchemas !== undefined) {
    if (!Array.isArray(raw.externalSchemas)) {
      throw invalid("externalSchemas", "must be an array of schema names");
    }
    externalSchemas = raw.externalSchemas.map((schema: unknown, index) => {
      const name = schemaName(schema, `externalSchemas[${index}]`, "");
      if (name === managedSchema || name === historySchema) {
        throw invalid(
          `externalSchemas[${index}]`,
          "must differ from managedSchema and historySchema",
        );
      }
      return name;
    });
  }

  let directory = "data-model";
  if (raw.directory !== undefined) {
    if (typeof raw.directory !== "string" || raw.directory.trim() === "") {
      throw invalid("directory", "must be a non-empty relative path");
    }
    const normalised = normalize(raw.directory);
    if (isAbsolute(normalised) || normalised.split(/[\\/]/)[0] === "..") {
      throw invalid(
        "directory",
        "must be a path inside the project, relative to the config file",
      );
    }
    directory = raw.directory;
  }

  const extensions = extensionsSetting(raw.extensions);

  const targets: Record<string, ResolvedTarget> = {};
  if (raw.targets !== undefined) {
    if (!isRecord(raw.targets)) {
      throw invalid("targets", "must be an object of named targets");
    }
    for (const [name, value] of Object.entries(raw.targets)) {
      const path = `targets.${name}`;
      if (!targetName.test(name)) {
        throw invalid(
          path,
          "target names may contain only letters, digits, - and _",
        );
      }
      if (!isRecord(value)) {
        throw invalid(path, "must be an object with an adapter");
      }
      rejectUnknown(value, targetSettings, `${path}.`);
      if (!hasMethod(value.adapter, "connect")) {
        throw invalid(
          `${path}.adapter`,
          "must be a deployment adapter with a connect() method",
        );
      }
      targets[name] = {
        name,
        adapter: value.adapter as DeploymentAdapter,
        lockTimeoutMs:
          duration(value.lockTimeout, `${path}.lockTimeout`) ??
          targetDefaults.lockTimeoutMs,
        lockTimeoutSet: value.lockTimeout !== undefined,
        statementTimeoutMs:
          duration(value.statementTimeout, `${path}.statementTimeout`) ??
          targetDefaults.statementTimeoutMs,
        connectTimeoutMs:
          duration(value.connectTimeout, `${path}.connectTimeout`) ??
          targetDefaults.connectTimeoutMs,
        postgresVersion,
      };
    }
  }

  return {
    postgresVersion,
    rehearsal: raw.rehearsal as RehearsalAdapter,
    targets,
    managedSchema,
    historySchema,
    externalSchemas,
    directory,
    extensions,
  };
}

function extensionsSetting(value: unknown): ListedExtensions {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw invalid(
      "extensions",
      `must be an object from supported extension names to lists of versions, got ${describe(value)}`,
    );
  }
  const extensions: Partial<Record<SupportedExtension, readonly string[]>> = {};
  for (const [name, versions] of Object.entries(value)) {
    const setting = `extensions.${name}`;
    if (!isSupportedExtension(name)) {
      throw new ExtensionNotSupportedError(name, setting);
    }
    const supported: readonly string[] = supportedExtensionVersions[name];
    if (
      !Array.isArray(versions) ||
      !versions.every((version) => typeof version === "string")
    ) {
      throw invalid(
        setting,
        `must be an array of version strings such as ["${supported.at(-1)}"], got ${describe(versions)}`,
      );
    }
    if (versions.length === 0) {
      throw new ExtensionVersionsEmptyError(name, supported, setting);
    }
    const listed = new Set<string>();
    for (const version of versions) {
      if (!supported.includes(version)) {
        throw new ExtensionVersionNotSupportedError(
          name,
          version,
          supported,
          setting,
        );
      }
      if (listed.has(version)) {
        throw new ExtensionVersionDuplicatedError(name, version, setting);
      }
      listed.add(version);
    }
    extensions[name] = [...listed];
  }
  return extensions;
}

function schemaName(value: unknown, setting: string, fallback: string): string {
  if (value === undefined && fallback !== "") {
    return fallback;
  }
  if (typeof value !== "string" || !identifier.test(value)) {
    throw invalid(
      setting,
      `must be a lowercase PostgreSQL identifier (letters, digits, _), got ${describe(value)}`,
    );
  }
  if (value.startsWith("pg_") || value === "information_schema") {
    throw invalid(
      setting,
      `must not be a system schema, got ${describe(value)}`,
    );
  }
  return value;
}

const units: Record<string, number> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
};

function duration(value: unknown, setting: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  const match =
    typeof value === "string"
      ? /^(\d+)\s*(ms|s|min|h)$/.exec(value.trim())
      : null;
  const amount = Number(match?.[1]);
  const unit = units[match?.[2] ?? ""];
  if (unit === undefined || !(amount > 0)) {
    throw invalid(
      setting,
      `must be a positive duration such as "500ms", "5s" or "2min", got ${describe(value)}`,
    );
  }
  return amount * unit;
}

/** A duration in milliseconds as config would write it: `"500ms"`, `"5s"`, `"2min"`. */
export function durationText(ms: number): string {
  const [unit, size] = Object.entries(units).findLast(
    ([, size]) => ms % size === 0,
  ) ?? ["ms", 1];
  return `${ms / size}${unit}`;
}

function rejectUnknown(
  value: Record<string, unknown>,
  known: Set<string>,
  prefix: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new ConfigError(
        `Unknown setting "${prefix}${key}" in super-deploy.config.ts`,
        `${prefix}${key}`,
      );
    }
  }
}

function invalid(setting: string, problem: string): ConfigError {
  return new ConfigError(invalidMessage(setting, problem), setting);
}

function invalidMessage(setting: string, problem: string): string {
  return `Invalid setting "${setting}" in super-deploy.config.ts: ${problem}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasMethod(value: unknown, method: string): boolean {
  return isRecord(value) && typeof value[method] === "function";
}

function describe(value: unknown): string {
  return value === undefined
    ? "nothing"
    : (JSON.stringify(value) ?? String(value));
}

/** The config file failed to load or a setting is invalid. */
export class ConfigError extends SuperDeployError {
  // A subclass narrows `code` to one of its own (the extension errors below).
  readonly code:
    | "invalid-config"
    | "extension-not-supported"
    | "extension-version-not-supported"
    | "extension-versions-empty"
    | "extension-version-duplicated" = "invalid-config";
  /** Dotted path of the offending setting, e.g. `targets.dev.lockTimeout`. */
  readonly setting: string | undefined;

  constructor(message: string, setting?: string, options?: ErrorOptions) {
    super(message, options);
    this.setting = setting;
  }
}

/** The config's `extensions` names an extension that isn't a supported extension. */
export class ExtensionNotSupportedError extends ConfigError {
  override readonly code = "extension-not-supported";
  readonly extension: string;

  constructor(extension: string, setting: string) {
    super(
      invalidMessage(
        setting,
        `${extension} is not a supported extension: supported extensions are ${Object.keys(supportedExtensionVersions).join(", ")}`,
      ),
      setting,
    );
    this.extension = extension;
  }
}

/** The config's `extensions` lists a version of a supported extension the tool doesn't know. */
export class ExtensionVersionNotSupportedError extends ConfigError {
  override readonly code = "extension-version-not-supported";
  readonly extension: string;
  readonly version: string;
  /** The versions the tool knows, oldest first. */
  readonly supported: readonly string[];

  constructor(
    extension: string,
    version: string,
    supported: readonly string[],
    setting: string,
  ) {
    super(
      invalidMessage(
        setting,
        `${extension} ${version} is not a supported version: supported versions are ${supported.join(", ")}`,
      ),
      setting,
    );
    this.extension = extension;
    this.version = version;
    this.supported = supported;
  }
}

/** The config's `extensions` gives a supported extension an empty list of versions. */
export class ExtensionVersionsEmptyError extends ConfigError {
  override readonly code = "extension-versions-empty";
  readonly extension: string;

  constructor(
    extension: string,
    supported: readonly string[],
    setting: string,
  ) {
    super(
      invalidMessage(
        setting,
        `list at least one version of ${extension}, from ${supported.join(", ")}`,
      ),
      setting,
    );
    this.extension = extension;
  }
}

/** The config's `extensions` lists one version of an extension twice. */
export class ExtensionVersionDuplicatedError extends ConfigError {
  override readonly code = "extension-version-duplicated";
  readonly extension: string;
  readonly version: string;

  constructor(extension: string, version: string, setting: string) {
    super(
      invalidMessage(setting, `${extension} ${version} is listed twice`),
      setting,
    );
    this.extension = extension;
    this.version = version;
  }
}
