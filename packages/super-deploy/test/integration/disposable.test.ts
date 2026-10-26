// API seam: guarded commands stay terminal-only. A program can call
// `disposable`, but it has no answer callback and nothing skips the guard:
// in CI (or without a terminal) it refuses before touching the target. Its
// behaviour at a terminal is tested in cli-guard.test.ts.
import { disposable, TerminalRequiredError } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { deployProject } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.stop();
});

describe("disposable", () => {
  test("refuses in CI with TerminalRequiredError, without connecting to the target", async () => {
    const { project, database } = await deployProject(server, {});
    vi.stubEnv("CI", "true");
    try {
      const error = await disposable(project, {
        target: "dev",
        set: true,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TerminalRequiredError);
      expect(error).toMatchObject({
        code: "terminal-required",
        command: "disposable",
        reason: "ci",
      });
      expect(await server.databases()).not.toContain(database);
    } finally {
      vi.unstubAllEnvs();
      await project.close();
    }
  });
});
