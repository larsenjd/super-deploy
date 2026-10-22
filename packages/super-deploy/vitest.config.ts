import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import the library by its package name, so they can only reach the
// public API. Inside Vitest those names resolve to src/, including from the
// super-deploy.config.ts of temporary test projects (their dynamic import goes
// through Vitest too), so tests and configs share one module instance and no
// build is needed. The CLI seam spawns the built binary instead (dist/).
const alias = [
  {
    find: /^superdeploy$/,
    replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
  },
  {
    find: /^superdeploy\/embedded-postgres$/,
    replacement: fileURLToPath(
      new URL("./src/adapters/embedded-postgres.ts", import.meta.url),
    ),
  },
];

// Integration workers: half the CPUs, so parallel worktrees don't starve
// each other. On 16 CPUs, two concurrent runs at 8 workers each finished in
// 90 s with the slowest test at 8.5 s, against 101 s and 14 s at Vitest's
// default of 15 each; alone, 8 workers take 70 s against 59 s. At least 3
// (the default on a 4-CPU CI runner): the tests mostly wait on PostgreSQL, and
// on 4 CPUs 2 workers took 222 s alone against 174 s for 3 workers sharing
// the CPUs with a second run.
const integrationWorkers = Math.max(3, Math.floor(availableParallelism() / 2));

// Two projects so the pre-commit hook can run only database-free tests:
// - unit: pure functions such as SQL analysis; never starts PostgreSQL.
// - integration: the programmatic API and CLI seams against real PostgreSQL 18.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // Builds dist/ once per run for the CLI seam.
          globalSetup: ["test/support/build-once.ts"],
          // Measured on 16 CPUs: the slowest test takes ~7 s alone and ~14 s
          // with a second worktree's run alongside at full width; each
          // file's PostgreSQL starts in under 1 s. 30 s fails a hung test
          // (e.g. one that deliberately breaks code) quickly while leaving
          // room for load; the round trips, the slowest, get 60 s each.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          maxWorkers: integrationWorkers,
          // Projects with different maxWorkers run as separate groups:
          // the (sub-second) unit tests first.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
