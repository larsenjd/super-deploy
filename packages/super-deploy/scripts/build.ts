// Builds the library: compiles src/ with plain tsc into dist/, then bundles
// the template package into dist/template so `init` can copy it without a
// network fetch.
import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";

const packageDir = join(import.meta.dirname, "..");
const distDir = join(packageDir, "dist");
const templateDir = join(packageDir, "..", "template");

/** Paths inside the template package that are workspace artefacts, not template content. */
const excludedNames = new Set(["node_modules", "dist"]);

rmSync(distDir, { recursive: true, force: true });

const require = createRequire(import.meta.url);
const tscBin = join(
  dirname(require.resolve("typescript/package.json")),
  "bin",
  "tsc",
);
const tsc = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], {
  cwd: packageDir,
  stdio: "inherit",
});
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

cpSync(templateDir, join(distDir, "template"), {
  recursive: true,
  filter: (source) => {
    const name = basename(source);
    return !excludedNames.has(name) && !name.endsWith(".tsbuildinfo");
  },
});
