import { defineConfig } from "vitest/config";

// Two projects so the pre-commit hook can run only database-free tests:
// - unit: pure functions such as SQL analysis; never starts PostgreSQL.
// - integration: the programmatic API and CLI seams against real PostgreSQL 18.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
