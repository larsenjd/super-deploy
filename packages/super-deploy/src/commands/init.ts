// `init`: scaffold a project from the template bundled in the library
// package (no network fetch). The result is ready to use: its config runs a
// private embedded PostgreSQL 18 for rehearsals and the `dev` target.
//
// Ticket 22 adds `--adopt <target>` (turning an existing database's managed
// schema into migration 1). It needs a loaded project for the target, so it
// is expected to be its own step after (or instead of) scaffolding;
// `InitOptions` is where the API option goes.
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { InitConflictError } from "../errors.ts";
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

/** An npm package name from a folder name: lowercase, URL-safe characters only. */
function packageName(folder: string): string {
  const name = folder
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^[._-]+/, "")
    .replace(/-+$/, "");
  return name === "" ? "super-deploy-project" : name;
}
