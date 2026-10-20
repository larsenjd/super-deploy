// The typed project configuration (super-deploy.config.ts) and its validation.
// Never in config: credentials, the disposable flag, migration state.

import { isAbsolute, normalize } from "node:path";
import type { DeploymentAdapter, RehearsalAdapter } from "../adapters/types.ts";
import { SuperDeployError } from "../errors.ts";

/** A duration: milliseconds as a number, or a string such as `"500ms"`, `"5s"`, `"2min"`. */
export type Duration = number | string;

export interface TargetConfig {
  /** How to connect to this target. */
  adapter: DeploymentAdapter;
  /** `lock_timeout` inside deployments. Default `"5s"`. */
  lockTimeout?: Duration;
  /** `statement_timeout` inside deployments. Default none. */
  statementTimeout?: Duration;
}

export interface SuperDeployConfig {
  /** Must be 18. */
  postgresVersion: 18;
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
}

/** Identity function that types a super-deploy.config.ts default export. */
export function defineConfig(config: SuperDeployConfig): SuperDeployConfig {
  return config;
}

export interface ResolvedTarget {
  readonly name: string;
  readonly adapter: DeploymentAdapter;
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number | undefined;
}

/** A validated configuration with every default applied. */
export interface ResolvedConfig {
  readonly postgresVersion: 18;
  readonly rehearsal: RehearsalAdapter;
  readonly targets: Readonly<Record<string, ResolvedTarget>>;
  readonly managedSchema: string;
  readonly historySchema: string;
  readonly externalSchemas: readonly string[];
  readonly directory: string;
}

const settings = new Set([
  "postgresVersion",
  "rehearsal",
  "targets",
  "managedSchema",
  "historySchema",
  "externalSchemas",
  "directory",
]);
const targetSettings = new Set(["adapter", "lockTimeout", "statementTimeout"]);
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

  if (raw.postgresVersion !== 18) {
    throw invalid(
      "postgresVersion",
      `must be 18 (the only supported PostgreSQL version), got ${describe(raw.postgresVersion)}`,
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
          duration(value.lockTimeout, `${path}.lockTimeout`) ?? 5000,
        statementTimeoutMs: duration(
          value.statementTimeout,
          `${path}.statementTimeout`,
        ),
      };
    }
  }

  return {
    postgresVersion: 18,
    rehearsal: raw.rehearsal as RehearsalAdapter,
    targets,
    managedSchema,
    historySchema,
    externalSchemas,
    directory,
  };
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
  return new ConfigError(
    `Invalid setting "${setting}" in super-deploy.config.ts: ${problem}`,
    setting,
  );
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
  readonly code = "invalid-config";
  /** Dotted path of the offending setting, e.g. `targets.dev.lockTimeout`. */
  readonly setting: string | undefined;

  constructor(message: string, setting?: string, options?: ErrorOptions) {
    super(message, options);
    this.setting = setting;
  }
}
