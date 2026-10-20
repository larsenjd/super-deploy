// Runs round-trip scenarios through the programmatic API: for each
// scenario, draft and finalize a -> b, b -> c and c -> a in one project.
// Finalize rehearses every step (pg-delta re-diff and our catalog comparison
// must both be empty), so a finalized step is a proven round trip.
//
// The deploy leg: every finalized step is deployed to target `dev` as soon
// as it is finalized, and all of them at once (one transaction) to target
// `fresh` at the end. Ticket 12 can add "status reports no drift" to both.
//
// Not test.concurrent: createTestProject's cleanup uses the global
// onTestFinished, which can't tell concurrent tests apart.
import { deploy, draft, finalize, loadProject, status } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RoundTrip, roundTripRoles } from "../fixtures/round-trips.ts";
import { deployConfig, targetDatabaseName } from "./deploy.ts";
import { startTestServer, type TestServer } from "./postgres.ts";
import { createTestProject } from "./project.ts";

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

  describe("round trips through draft, finalize and deploy", () => {
    test.each(scenarios.map((s) => [s.name, s] as const))(
      "%s",
      async (_name, scenario) => {
        const dir = await createTestProject({
          config: deployConfig(server, {
            otherTargets: `fresh: { adapter: postgres.target(${JSON.stringify(targetDatabaseName())}) },`,
          }).config,
          files: { "data-model/desired-schema/schema.sql": scenario.a },
        });
        const project = await loadProject({ cwd: dir.root });
        if (scenario.a.trim() !== "") {
          await draft(project, { name: "start" });
          await finalize(project);
          await deploy(project, { target: "dev" });
        }
        for (const [step, sql] of [
          ["create", scenario.b],
          ["alter", scenario.c],
          ["drop", scenario.a],
        ] as const) {
          await dir.write("data-model/desired-schema/schema.sql", sql);
          const drafted = await draft(project, { name: step });
          expect(drafted.statements.length, step).toBeGreaterThan(0);
          // The alter and drop steps drop structure: acknowledged, as a
          // developer would after reading the question.
          const finalized = await finalize(project, {
            acknowledgeDestructive: true,
          });
          const deployed = await deploy(project, { target: "dev" });
          expect(
            deployed.deployed.map((m) => m.number),
            step,
          ).toEqual([finalized.number]);
        }
        const all = await deploy(project, { target: "fresh" });
        expect(all.deployed).toHaveLength(scenario.a.trim() === "" ? 3 : 4);
        for (const target of ["dev", "fresh"]) {
          expect((await status(project, { target })).pending).toEqual([]);
        }
      },
    );
  });
}
