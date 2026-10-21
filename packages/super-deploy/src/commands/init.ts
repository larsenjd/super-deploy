// `init`: scaffold a project from the template bundled in the library
// package (no network fetch). The result is ready to use: its config runs
// private embedded PostgreSQL 18 servers, one for the `dev` target and one
// for rehearsals. `dev`'s listens on a fixed port, so it is always at the same
// URL: init writes one that is free when it runs in place of the template's.
//
// `init --adopt <target>` doesn't scaffold: it needs the target's connection
// from config, so it runs in a project initialised (and configured) already,
// and is the `adopt` API function (commands/adopt.ts).

import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { freePort } from "../adapters/ports.ts";
import { SuperDeployError } from "../errors.ts";
import { configFileName } from "../project.ts";
import {
  libraryPackageDirectory,
  renamedOnInit,
  templateDirectory,
  templateFiles,
} from "../store/template.ts";

export interface InitOptions {
  /** The folder to scaffold into, created if missing. Default `process.cwd()`. */
  directory?: string;
}

export interface InitResult {
  /** Absolute path of the new project's root. */
  readonly root: string;
  /** Every file written, relative to `root` (posix), sorted. */
  readonly files: readonly string[];
}

/**
 * Copies the template into `directory`. Refuses with InitConflictError,
 * writing nothing, if any template file already exists there.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const root = resolve(options.directory ?? process.cwd());
  const source = templateDirectory();
  const copies = (await templateFiles(source)).map((from) => ({
    from,
    to: renamedOnInit[from] ?? from,
  }));
  const files = copies
    .map((copy) => copy.to)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const conflicts = files.filter((file) => existsSync(join(root, file)));
  if (conflicts.length > 0) {
    throw new InitConflictError(root, conflicts);
  }

  for (const { from, to } of copies) {
    const target = join(root, ...to.split("/"));
    await mkdir(dirname(target), { recursive: true });
    if (to === "package.json") {
      const manifest = projectManifest(
        await readFile(join(source, from), "utf8"),
        root,
      );
      await writeFile(target, manifest, { flag: "wx" });
    } else if (to === configFileName) {
      const config = await readFile(join(source, from), "utf8");
      await writeFile(target, withDevPort(config, await freePort()), {
        flag: "wx",
      });
    } else {
      await copyFile(join(source, from), target, constants.COPYFILE_EXCL);
    }
  }
  return { root, files };
}

/**
 * The template's package.json made the project's own: named after its
 * folder, and depending on the library that ran init instead of the
 * workspace (`workspace:*` means nothing outside the super-deploy repo).
 *
 * The library isn't published in V1 (REFINEMENTS.md, "Publishing"), so the
 * dependency is a `link:` to this library's folder, which installs offline
 * and never resolves an unrelated package from the registry. Once published
 * it becomes the exact version (`toolVersion`).
 */
function projectManifest(text: string, root: string): string {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const { name: _name, description: _description, ...rest } = manifest;
  const result: Record<string, unknown> = {
    name: packageName(basename(root)),
    ...rest,
  };
  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies = result[field] as Record<string, string> | undefined;
    if (dependencies?.["super-deploy"] !== undefined) {
      result[field] = {
        ...dependencies,
        "super-deploy": `link:${libraryPackageDirectory.split(sep).join("/").replace(/\/$/, "")}`,
      };
    }
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** The template's config with `port` as its `dev` server's port. */
function withDevPort(config: string, port: number): string {
  return config.replace(/^(\s*port: )\d+,$/m, `$1${port},`);
}

/** An npm package name from a folder name: lowercase, URL-safe characters only. */
function packageName(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return name === "" ? "super-deploy-project" : name;
}

/** `init` would overwrite existing files; nothing was written. */
export class InitConflictError extends SuperDeployError {
  readonly code = "init-conflict";
  readonly directory: string;
  /** Paths relative to `directory`, sorted. */
  readonly paths: readonly string[];

  constructor(directory: string, paths: readonly string[]) {
    super(
      `Cannot initialise a project in ${directory}: it already has ${paths.join(", ")}`,
    );
    this.directory = directory;
    this.paths = paths;
  }
}
