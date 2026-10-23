// Loading a project: find super-deploy.config.ts from the working directory
// or a parent, import it with Node's built-in TypeScript support, and validate
// it. Every command function takes the resulting Project.
//
// A syntax error in the config is reported at its line, which Node gives only
// as the first line of the SyntaxError's stack (`<path or file URL>:<line>`,
// then the source line and a caret). An error thrown as the config runs is
// reported at the topmost frame of its stack in the config itself (type
// stripping keeps lines), so a function the config calls is located at the
// call; one with no such frame (thrown while an imported module loads) keeps
// no location. Inside Vitest the config goes through Vitest's transform
// instead, whose errors carry no location, so tests of this load the project
// in a plain Node process (`config.test.ts`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConfigError,
  type ResolvedConfig,
  resolveConfig,
} from "./config/config.ts";
import { errorReason, SuperDeployError } from "./errors.ts";
import { interruptibleRehearsal } from "./interruption.ts";
import { type ProjectPaths, projectPaths } from "./store/layout.ts";

export const configFileName = "super-deploy.config.ts";

let loads = 0;

export interface Project {
  /** Absolute path of the folder holding super-deploy.config.ts. */
  readonly root: string;
  readonly configPath: string;
  readonly config: ResolvedConfig;
  readonly paths: ProjectPaths;
  /** Warnings about the config itself, e.g. an unsupported postgresVersion. */
  readonly warnings: readonly string[];
  /** The interruption signal the project was loaded with, if any. */
  readonly signal: AbortSignal | undefined;
  /** Closes every adapter (dropping leftover throwaway databases, releasing embedded servers: the last client stops one). */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LoadProjectOptions {
  /** Where to start looking for super-deploy.config.ts. Default `process.cwd()`. */
  cwd?: string;
  /**
   * Interrupts commands running on this project when it aborts: they stop,
   * clean up (roll back, drop throwaway databases) and reject with
   * InterruptedError.
   */
  signal?: AbortSignal;
  /**
   * Import the config file afresh even if this process already imported it
   * (modules it imports are still reused). For long-running processes such as
   * the interactive menu, so edits to the config take effect.
   */
  reload?: boolean;
}

export async function loadProject(
  options: LoadProjectOptions = {},
): Promise<Project> {
  const start = resolve(options.cwd ?? process.cwd());
  const configPath = findConfig(start);
  if (configPath === undefined) {
    throw new ProjectNotFoundError(start);
  }
  const url = pathToFileURL(configPath);
  if (options.reload) {
    url.search = `?load=${++loads}`;
  }
  let module: { default?: unknown };
  try {
    module = (await import(url.href)) as { default?: unknown };
  } catch (error) {
    throw new ConfigError(describeLoadFailure(error, configPath), undefined, {
      cause: error,
    });
  }
  const resolved = resolveConfig(module.default);
  const config: ResolvedConfig = {
    ...resolved,
    rehearsal: interruptibleRehearsal(resolved.rehearsal, options.signal),
  };
  const root = dirname(configPath);

  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= closeAdapters(config);
    return closed;
  };
  return {
    root,
    configPath,
    config,
    paths: projectPaths(root, config.directory),
    warnings: configWarnings(config),
    signal: options.signal,
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** The warning for a postgresVersion other than 18 (ADR-0007). */
function configWarnings(config: ResolvedConfig): string[] {
  const version = config.postgresVersion;
  return version === 18
    ? []
    : [
        `postgresVersion ${version} is unsupported: super-deploy is built and tested for PostgreSQL 18. It is an escape hatch for adopting a database; migrations are generated and rehearsed on 18 and may not run on ${version}`,
      ];
}

/**
 * `super-deploy.config.ts:<line>: <reason> in \`<source line>\`` for an error
 * located in the config file itself; otherwise
 * `Failed to load super-deploy.config.ts: <reason>`.
 */
function describeLoadFailure(error: unknown, configPath: string): string {
  const reason = errorReason(error);
  const number = configLine(error, configPath);
  if (number !== undefined) {
    const source = readFileSync(configPath, "utf8").split(/\r?\n/)[number - 1];
    if (source !== undefined) {
      return `${configFileName}:${number}: ${reason} in \`${source.trim()}\``;
    }
  }
  return `Failed to load ${configFileName}: ${reason}`;
}

/**
 * The config's line an error comes from: for a module's SyntaxError, the
 * `<location>:<line>` its stack's first line names; for anything else, the
 * topmost stack frame (`at … <location>:<line>:<column>`) in the config.
 */
function configLine(error: unknown, configPath: string): number | undefined {
  if (!(error instanceof Error) || error.stack === undefined) {
    return undefined;
  }
  const [first = "", ...frames] = error.stack.split("\n");
  if (error instanceof SyntaxError) {
    const match = /^(.+):(\d+)$/.exec(first);
    if (match !== null) {
      const [, location = "", number = ""] = match;
      return filePath(location) === configPath ? Number(number) : undefined;
    }
  }
  for (const frame of frames) {
    const match = /^\s+at (?:.* \()?(.+):(\d+):\d+\)?$/.exec(frame);
    if (match !== null) {
      const [, location = "", number = ""] = match;
      if (filePath(location) === configPath) {
        return Number(number);
      }
    }
  }
  return undefined;
}

/** A stack's location as a path: file URLs converted, `?load=N` dropped. */
function filePath(location: string): string {
  const withoutQuery = location.replace(/\?[^/]*$/, "");
  return withoutQuery.startsWith("file:")
    ? fileURLToPath(withoutQuery)
    : withoutQuery;
}

/** The super-deploy.config.ts in `start` or its nearest parent, if any. */
export function findConfig(start: string): string | undefined {
  return findUpward(start, configFileName);
}

/** The path of the file or folder `name` in `start` or its nearest parent, if any. */
export function findUpward(start: string, name: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

async function closeAdapters(config: ResolvedConfig): Promise<void> {
  const errors: unknown[] = [];
  const adapters = [
    config.rehearsal,
    ...Object.values(config.targets).map((t) => t.adapter),
  ];
  for (const adapter of adapters) {
    try {
      await adapter.close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Closing the project's adapters failed");
  }
}

/** No super-deploy.config.ts in the working directory or any parent. */
export class ProjectNotFoundError extends SuperDeployError {
  readonly code = "project-not-found";
  readonly searchedFrom: string;

  constructor(searchedFrom: string) {
    super(
      `No super-deploy.config.ts found in ${searchedFrom} or any parent directory`,
    );
    this.searchedFrom = searchedFrom;
  }
}
