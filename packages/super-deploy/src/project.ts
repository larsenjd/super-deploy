// Loading a project: find super-deploy.config.ts from the working directory
// or a parent, import it with Node's built-in TypeScript support, and validate
// it. Every command function takes the resulting Project.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Failed to load ${configFileName}: ${reason}`,
      undefined,
      { cause: error },
    );
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
