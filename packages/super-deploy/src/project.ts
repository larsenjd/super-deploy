// Loading a project: find super-deploy.config.ts from the working directory
// or a parent, import it with Node's built-in TypeScript support, and validate
// it. Every command function takes the resulting Project.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ResolvedConfig, resolveConfig } from "./config/config.ts";
import { ConfigError, ProjectNotFoundError } from "./errors.ts";
import { type ProjectPaths, projectPaths } from "./store/layout.ts";

export const configFileName = "super-deploy.config.ts";

export interface Project {
  /** Absolute path of the folder holding super-deploy.config.ts. */
  readonly root: string;
  readonly configPath: string;
  readonly config: ResolvedConfig;
  readonly paths: ProjectPaths;
  /** Closes every adapter (dropping leftover throwaway databases, stopping servers it started). */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface LoadProjectOptions {
  /** Where to start looking for super-deploy.config.ts. Default `process.cwd()`. */
  cwd?: string;
}

export async function loadProject(
  options: LoadProjectOptions = {},
): Promise<Project> {
  const start = resolve(options.cwd ?? process.cwd());
  const configPath = findConfig(start);
  if (configPath === undefined) {
    throw new ProjectNotFoundError(start);
  }
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(configPath).href)) as {
      default?: unknown;
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `Failed to load ${configPath}: ${reason}`,
      undefined,
      { cause: error },
    );
  }
  const config = resolveConfig(module.default);
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
    close,
    [Symbol.asyncDispose]: close,
  };
}

function findConfig(start: string): string | undefined {
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
