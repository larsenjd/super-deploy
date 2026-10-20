// Every accepted ordering fixture, drafted against real PostgreSQL 18: it
// loads in the computed order, and again in the alternative order (which
// ignores kind priority, so a missing dependency edge fails to load), with
// the same catalog both times.
//
// Uses the test-only allowlist bypass until ticket 08 allows views,
// functions and the rest in the desired schema.
import { DesiredSchemaLoadError, draft, loadProject } from "super-deploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { allowAnyDesiredSchemaStatementForTests } from "../../src/sql-analysis/rules.ts";
import { fixtureRoles, orderingFixtures } from "../fixtures/ordering.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import { createTestProject, embeddedConfig } from "../support/project.ts";

let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
  for (const role of fixtureRoles) {
    await server.query(`create role ${role} nologin`);
  }
  allowAnyDesiredSchemaStatementForTests(true);
});
afterAll(async () => {
  allowAnyDesiredSchemaStatementForTests(false);
  await server?.stop();
});

const accepted = orderingFixtures.filter((f) => f.errors === undefined);

describe("ordering fixtures in PostgreSQL 18", () => {
  test.each(accepted.map((f) => [f.name, f] as const))(
    "%s",
    async (_name, fixture) => {
      const dir = await createTestProject({
        config: embeddedConfig(server),
        files: Object.fromEntries(
          Object.entries(fixture.files).map(([name, text]) => [
            `data-model/desired-schema/${name}`,
            text,
          ]),
        ),
      });
      const project = await loadProject({ cwd: dir.root });

      const result = draft(project, { name: "fixture" });

      if (fixture.postgresRefuses === undefined) {
        await expect(result).resolves.toMatchObject({ name: "fixture" });
      } else {
        const error = await result.catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DesiredSchemaLoadError);
        expect((error as DesiredSchemaLoadError).detail).toContain(
          fixture.postgresRefuses,
        );
      }
    },
  );
});
