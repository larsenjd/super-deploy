// API seam: `postgresVersion` naming a version other than 18, the escape
// hatch for adopting a database on an older server (ADR-0007). The target is
// a real PostgreSQL 16; rehearsals still run on the PostgreSQL 18 test server.
import {
  adopt,
  deploy,
  loadProject,
  status,
  UnsupportedServerError,
} from "superdeploy";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { targetDatabaseName } from "../support/deploy.ts";
import { startTestServer, type TestServer } from "../support/postgres.ts";
import {
  type Postgres16Server,
  startPostgres16,
} from "../support/postgres-16.ts";
import { createTestProject } from "../support/project.ts";

let server: TestServer;
let legacyServer: Postgres16Server;
beforeAll(async () => {
  [server, legacyServer] = await Promise.all([
    startTestServer(),
    startPostgres16(),
  ]);
});
afterAll(async () => {
  await Promise.all([server?.stop(), legacyServer?.stop()]);
});

/** A config for `postgresVersion`, rehearsing on the test server, with `targets` spliced in. */
function config(postgresVersion: number, targets: string): string {
  return `import { defineConfig, postgresTarget } from "superdeploy";
import { embeddedPostgres } from "superdeploy/embedded-postgres";

const postgres = embeddedPostgres({ dataDir: ${JSON.stringify(server.dataDir)} });

export default defineConfig({
  postgresVersion: ${postgresVersion},
  rehearsal: postgres.rehearsal,
  targets: { ${targets} },
});
`;
}

// Primary keys and NOT NULL columns: PostgreSQL 18 records a named NOT NULL
// constraint for each, 16 none, and their default statistics targets read
// differently.
const shop = `
create table customers (
  id bigint generated always as identity primary key,
  email text not null,
  created_at timestamptz not null default now(),
  constraint customers_email_key unique (email)
);
create table orders (
  id bigint generated always as identity primary key,
  customer_id bigint not null,
  total numeric(12,2) not null,
  constraint orders_total_check check (total >= 0),
  constraint orders_customer_fkey foreign key (customer_id) references customers (id)
);
create index orders_customer_idx on orders (customer_id);
create view big_orders as select id, customer_id, total from orders where total > 100;
insert into customers (email) values ('ada@example.com');
`;

describe("postgresVersion 16", () => {
  test("adopts a PostgreSQL 16 database, which then shows no drift, and the adopted schema deploys to PostgreSQL 18", async () => {
    const legacy = await legacyServer.createDatabase(shop);
    const dir = await createTestProject({
      config: config(
        16,
        `legacy: { adapter: postgresTarget({ connectionString: ${JSON.stringify(legacyServer.connectionString(legacy))} }) },`,
      ),
    });
    const project = await loadProject({ cwd: dir.root });
    try {
      expect(project.warnings).toEqual([
        expect.stringMatching(/^postgresVersion 16 is unsupported: /),
      ]);

      const result = await adopt(project, { target: "legacy" });

      expect(result.migration.folder).toBe("00001-adopt");
      const report = await status(project, { target: "legacy" });
      expect(report.recorded).toMatchObject([
        { number: 1, name: "adopt", recordedHow: "marked" },
      ]);
      expect(report.drift).toEqual([]);
    } finally {
      await project.close();
    }

    // Moving on to PostgreSQL 18: the adopted schema deploys there.
    const database = targetDatabaseName();
    await dir.write(
      "super-deploy.config.ts",
      config(
        18,
        `dev: { adapter: postgres.target(${JSON.stringify(database)}) },`,
      ),
    );
    const upgraded = await loadProject({ cwd: dir.root, reload: true });
    try {
      expect(upgraded.warnings).toEqual([]);
      await deploy(upgraded, { target: "dev" });
      expect((await status(upgraded, { target: "dev" })).drift).toEqual([]);
    } finally {
      await upgraded.close();
    }
  });

  test("refuses a target whose server isn't the configured postgresVersion", async () => {
    const dir = await createTestProject({
      config: config(
        16,
        `dev: { adapter: postgres.target(${JSON.stringify(targetDatabaseName())}) },`,
      ),
    });
    const project = await loadProject({ cwd: dir.root });
    try {
      const error = await status(project, { target: "dev" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(UnsupportedServerError);
      expect((error as Error).message).toMatch(
        /^Target dev is PostgreSQL 18\.\d+, but postgresVersion is 16$/,
      );
    } finally {
      await project.close();
    }
  });
});
