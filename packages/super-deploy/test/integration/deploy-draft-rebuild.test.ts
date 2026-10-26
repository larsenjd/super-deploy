// API seam: deploy-draft and rebuild stay terminal-only. A program can call
// them, but they have no answer callback and nothing skips the guard: in CI
// they refuse before touching the target. Their behaviour at a terminal is
// tested in cli-deploy-draft-rebuild.test.ts.
import { deployDraft, rebuild, TerminalRequiredError } from "super-deploy";
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

describe.each([
  [
    "deploy-draft",
    (project) => deployDraft(project, { target: "dev", withSeed: true }),
  ],
  ["rebuild", (project) => rebuild(project, { target: "dev", to: 1 })],
] as const satisfies readonly (readonly [
  string,
  (
    project: Awaited<ReturnType<typeof deployProject>>["project"],
  ) => Promise<unknown>,
])[])("%s", (command, run) => {
  test("refuses in CI with TerminalRequiredError, without connecting to the target", async () => {
    const { project, database } = await deployProject(server, {});
    vi.stubEnv("CI", "true");
    try {
      const error = await run(project).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TerminalRequiredError);
      expect(error).toMatchObject({
        code: "terminal-required",
        command,
        reason: "ci",
      });
      expect(await server.databases()).not.toContain(database);
    } finally {
      vi.unstubAllEnvs();
      await project.close();
    }
  });
});
