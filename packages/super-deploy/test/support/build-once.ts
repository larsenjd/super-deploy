// Vitest global setup for the integration project: builds dist/ once per run,
// because the CLI seam spawns the real binary (dist/cli.js).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function setup(): void {
  const packageDir = join(import.meta.dirname, "..", "..");
  const build = spawnSync(process.execPath, ["scripts/build.ts"], {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`Building super-deploy failed (exit ${build.status})`);
  }
}
