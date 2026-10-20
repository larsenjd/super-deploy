import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import the library by its package name, so they can only reach the
// public API. Inside Vitest those names resolve to src/, including from the
// super-deploy.config.ts of temporary test projects (their dynamic import goes
// through Vitest too), so tests and configs share one module instance and no
// build is needed. The CLI seam spawns the built binary instead (dist/).
const alias = [
  {
    find: /^super-deploy$/,
    replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
  },
  {
    find: /^super-deploy\/embedded-postgres$/,
    replacement: fileURLToPath(
      new URL("./src/adapters/embedded-postgres.ts", import.meta.url),
    ),
  },
];

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
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
