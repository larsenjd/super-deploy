import { readFileSync } from "node:fs";

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
  throw new Error("super-deploy's package.json has no version");
}
