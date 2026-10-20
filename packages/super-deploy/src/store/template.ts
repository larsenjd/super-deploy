// The project template `init` copies: the `super-deploy-template` workspace
// package, bundled into dist/template by scripts/build.ts. Only Node built-ins
// here: the build script imports this module directly.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The library package's own folder (holding its package.json). */
export const libraryPackageDirectory = fileURLToPath(
  new URL("../../", import.meta.url),
);

/** Names inside the template package that are workspace artefacts, not template content. */
const artefactNames = new Set(["node_modules", "dist", ".super-deploy"]);

/** Whether a file or folder name is template content (not a workspace artefact). */
export function isTemplateContent(name: string): boolean {
  return !artefactNames.has(name) && !name.endsWith(".tsbuildinfo");
}

/**
 * Template files stored under another name, because under their real name
 * they would change how the workspace treats the template package (a
 * pnpm-workspace.yaml would make it a workspace root of its own). Template
 * path to project path.
 */
export const renamedOnInit: Readonly<Record<string, string>> = {
  "project.pnpm-workspace.yaml": "pnpm-workspace.yaml",
};

/**
 * The template folder: dist/template next to the built library, or the
 * workspace's template package when running from source (tests).
 */
export function templateDirectory(): string {
  const bundled = fileURLToPath(new URL("../template/", import.meta.url));
  if (existsSync(bundled)) {
    return bundled;
  }
  return join(libraryPackageDirectory, "..", "template");
}

/** Every template file, as posix paths relative to the template folder, sorted. */
export async function templateFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (folder: string, prefix: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!isTemplateContent(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(join(folder, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        files.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(directory, "");
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
