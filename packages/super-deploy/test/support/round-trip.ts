// Runs round-trip scenarios through the programmatic API: for each
// scenario, draft and finalize a -> b, b -> c and c -> a in one project.
// Finalize rehearses every step (pg-delta re-diff and our catalog comparison
// must both be empty), so a finalized step is a proven round trip.
//
// The deploy leg is added when ticket 04 (deploy) is available.
//
// Not test.concurrent: createTestProject's cleanup uses the global
// onTestFinished, which can't tell concurrent tests apart.
import { draft, finalize, loadProject } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RoundTrip, roundTripRoles } from "../fixtures/round-trips.ts";
import { startTestServer, type TestServer } from "./postgres.ts";
import { createTestProject, embeddedConfig } from "./project.ts";

export function describeRoundTrips(scenarios: readonly RoundTrip[]): void {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
    for (const role of roundTripRoles) {
      await server.query(`create role ${role} nologin`);
    }
  });
  afterAll(async () => {
    await server?.stop();
  });

  describe("round trips through draft and finalize", () => {
    test.each(scenarios.map((s) => [s.name, s] as const))(
      "%s",
      async (_name, scenario) => {
        const dir = await createTestProject({
          config: embeddedConfig(server),
          files: { "data-model/desired-schema/schema.sql": scenario.a },
        });
        const project = await loadProject({ cwd: dir.root });
        if (scenario.a.trim() !== "") {
          await draft(project, { name: "start" });
          await finalize(project);
        }
        for (const [step, sql] of [
          ["create", scenario.b],
          ["alter", scenario.c],
          ["drop", scenario.a],
        ] as const) {
          await dir.write("data-model/desired-schema/schema.sql", sql);
          const drafted = await draft(project, { name: step });
          expect(drafted.statements.length, step).toBeGreaterThan(0);
          await finalize(project);
        }
      },
    );
  });
}
