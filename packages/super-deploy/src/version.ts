import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const packageJson: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

/** The version of super-deploy itself, as recorded in migration metadata and attempts. */
export const toolVersion: string = readVersion(packageJson);

function readVersion(manifest: unknown): string {
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("A package.json has no version");
}

/** The SQL parser's package and version (libpg-query, PostgreSQL's own parser), as recorded in migration metadata. */
export const parserName = "libpg-query";
export const parserVersion: string = readVersion(
  JSON.parse(
    readFileSync(
      createRequire(import.meta.url).resolve("libpg-query/package.json"),
      "utf8",
    ),
  ),
);
