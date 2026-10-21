// Loading a project: find super-deploy.config.ts from the working directory
// or a parent, import it with Node's built-in TypeScript support, and validate
// it. Every command function takes the resulting Project.
//
// A syntax error in the config is reported at its line, which Node gives only
// as the first line of the SyntaxError's stack (`<path or file URL>:<line>`,
// then the source line and a caret). Inside Vitest the config goes through
// Vitest's transform instead, whose errors carry no location, so tests of this
// load the project in a plain Node process (`config.test.ts`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConfigError,
  type ResolvedConfig,
  resolveConfig,
} from "./config/config.ts";
import { SuperDeployError } from "./errors.ts";
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
  /** The interruption signal the project was loaded with, if any. */
  readonly signal: AbortSignal | undefined;
  /** Closes every adapter (dropping leftover throwaway databases, stopping servers it started). */
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
    signal: options.signal,
    close,
    [Symbol.asyncDispose]: close,
  };
}

/**
 * `super-deploy.config.ts:<line>: <reason> in \`<source line>\`` for a syntax
 * error Node located in the config file itself; otherwise
 * `Failed to load super-deploy.config.ts: <reason>`.
 */
function describeLoadFailure(error: unknown, configPath: string): string {
  const reason = error instanceof Error ? error.message : String(error);
  const line =
    error instanceof SyntaxError ? syntaxErrorLine(error) : undefined;
  if (line !== undefined && line.path === configPath) {
    const source = readFileSync(configPath, "utf8").split(/\r?\n/)[
      line.number - 1
    ];
    if (source !== undefined) {
      return `${configFileName}:${line.number}: ${reason} in \`${source.trim()}\``;
    }
  }
  return `Failed to load ${configFileName}: ${reason}`;
}

/** The file and line a module's SyntaxError names in its stack's first line. */
function syntaxErrorLine(
  error: SyntaxError,
): { path: string; number: number } | undefined {
  const match = /^(.+):(\d+)$/.exec(error.stack?.split("\n", 1)[0] ?? "");
  if (match === null) {
    return undefined;
  }
  const [, location = "", number = ""] = match;
  const withoutQuery = location.replace(/\?[^/]*$/, "");
  const path = withoutQuery.startsWith("file:")
    ? fileURLToPath(withoutQuery)
    : withoutQuery;
  return { path, number: Number(number) };
}

/** The super-deploy.config.ts in `start` or its nearest parent, if any. */
export function findConfig(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, configFileName);
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
