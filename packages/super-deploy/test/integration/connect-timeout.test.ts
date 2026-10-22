// API seam for a target's connectTimeout: a target that never answers fails
// after the timeout with a message naming the host, the timeout and the
// setting, and an interruption abandons the pending connect.
import {
  AdapterError,
  InterruptedError,
  loadProject,
  status,
} from "superdeploy";
import { expect, test, vi } from "vitest";
import { createTestProject, downTargetConfig } from "../support/project.ts";
import { silentHost } from "../support/silent-host.ts";

const variable = "SUPER_DEPLOY_TEST_DOWN_URL";

/** A project whose `down` target reads its URL from `variable`. */
function downProject(targetSettings: string) {
  return createTestProject({
    config: downTargetConfig(variable, targetSettings),
  });
}

test("status fails after connectTimeout, naming the host, the timeout and the setting", async () => {
  const host = await silentHost();
  vi.stubEnv(variable, host.url);
  const dir = await downProject('connectTimeout: "1s"');
  const project = await loadProject({ cwd: dir.root });

  const started = Date.now();
  const error = await status(project, { target: "down" }).catch(
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(AdapterError);
  expect((error as AdapterError).message).toBe(
    `The deployment adapter of target down failed to connect: no answer from ${host.address} within 1s (connectTimeout in super-deploy.config.ts)`,
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("an interruption abandons a pending connect", async () => {
  const host = await silentHost();
  vi.stubEnv(variable, host.url);
  const dir = await downProject('connectTimeout: "1min"');
  const controller = new AbortController();
  const project = await loadProject({
    cwd: dir.root,
    signal: controller.signal,
  });

  const result = status(project, { target: "down" }).catch((e: unknown) => e);
  await host.connected;
  const interrupted = Date.now();
  controller.abort(new Error("SIGINT"));

  expect(await result).toBeInstanceOf(InterruptedError);
  expect(Date.now() - interrupted).toBeLessThan(1000);
});
