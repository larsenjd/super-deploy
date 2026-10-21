// API seam for the embedded-postgres adapter's own options and lifecycle: a
// server on the port its config declares, so a local target such as `dev` is
// always at a known URL, and one server shared by every client of its data
// directory (ticket 14).
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { AdapterError } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
} from "vitest";
import { embeddedDeployRole } from "../support/deploy.ts";
import {
  freePort,
  serverRunning,
  startTestServer,
  type TestServer,
} from "../support/postgres.ts";

/** A new temp folder for a data directory, deleted when the test finishes. */
async function tempDataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "super-deploy-test-embedded-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return join(root, "data");
}

/** Listens on a free port of 127.0.0.1 until the test finishes. */
async function occupiedPort(): Promise<number> {
  const holder: Server = createServer();
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () => new Promise<void>((resolve) => holder.close(() => resolve())),
  );
  const address = holder.address();
  if (address === null || typeof address !== "object") {
    throw new Error("no port");
  }
  return address.port;
}

describe("embeddedPostgres with a port", () => {
  test("the server listens on the configured port of 127.0.0.1", async () => {
    const port = await freePort();
    const server = embeddedPostgres({ dataDir: await tempDataDir(), port });
    onTestFinished(() => server.stop());

    const url = await server.connectionString();

    expect(new URL(url).port).toBe(String(port));
    const client = new pg.Client({
      connectionString: `postgres://super_deploy:super_deploy@127.0.0.1:${port}/postgres`,
    });
    await client.connect();
    try {
      expect((await client.query("select 1 as one")).rows).toEqual([
        { one: 1 },
      ]);
    } finally {
      await client.end();
    }
  });

  test("a configured port that something else listens on fails naming the port and the setting", async () => {
    const port = await occupiedPort();
    const server = embeddedPostgres({ dataDir: await tempDataDir(), port });
    onTestFinished(() => server.stop());

    const error = await server.start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as Error).message).toContain(`port ${port}`);
    expect((error as Error).message).toContain("`port`");
  });
});

/** Whether a connection string reaches a server that runs `select 1`. */
async function accepts(connectionString: string): Promise<boolean> {
  const client = new pg.Client({ connectionString });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

describe("embeddedPostgres shared by several clients of one data directory", () => {
  test("the server keeps running until its last client stops", async () => {
    const dataDir = await tempDataDir();
    const first = embeddedPostgres({ dataDir });
    const second = embeddedPostgres({ dataDir });
    onTestFinished(() => first.stop());
    onTestFinished(() => second.stop());
    const url = await first.connectionString();
    await second.start();

    await first.stop();

    expect(await accepts(url)).toBe(true);
    await second.stop();
    expect(await accepts(url)).toBe(false);
    expect(await serverRunning(dataDir)).toBe(false);
  });

  test("a client waits while the server reports it is starting up", async () => {
    const dataDir = await tempDataDir();
    const setup = embeddedPostgres({ dataDir });
    await setup.start();
    await setup.stop();
    // A standby without hot standby answers every connection with 57P03
    // until it is promoted.
    await writeFile(join(dataDir, "standby.signal"), "");
    await appendFile(
      join(dataDir, "postgresql.auto.conf"),
      "hot_standby = off\n",
    );
    const client = embeddedPostgres({ dataDir });
    onTestFinished(() => client.stop());

    let settled = false;
    const started = client.start().finally(() => {
      settled = true;
    });
    const pid = await postmasterPid(dataDir);
    await delay(1_000);
    expect(settled).toBe(false);
    await writeFile(join(dataDir, "promote"), "");
    process.kill(pid, "SIGUSR1");

    await started;
    expect(await accepts(await client.connectionString())).toBe(true);
  });
});

/** The pid of the data directory's postmaster, once it has written one. */
async function postmasterPid(dataDir: string): Promise<number> {
  for (;;) {
    const pid = await readFile(join(dataDir, "postmaster.pid"), "utf8").then(
      (text) => Number(text.split("\n")[0]),
      () => undefined,
    );
    if (pid !== undefined && pid > 0) {
      return pid;
    }
    await delay(20);
  }
}

// Commands run at the same time each connect to `dev`, and each connect
// creates the database or hands it to the deploy role: losing that race to
// another client is not an error.
describe("embeddedPostgres targets connected to at the same time", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** Who `count` clients connecting to `database` as a target at once log in as. */
  async function connectAtOnce(
    database: string,
    count: number,
  ): Promise<(string | undefined)[]> {
    const clients = Array.from({ length: count }, () =>
      embeddedPostgres({ dataDir: server.dataDir }),
    );
    try {
      // Registered first, which goes one client at a time, so the connects
      // below do start together.
      for (const client of clients) {
        await client.start();
      }
      const sessions = await Promise.all(
        clients.map((client) => client.target(database).connect()),
      );
      return await Promise.all(
        sessions.map(async (session) => {
          try {
            const { rows } = await session.query<{ user: string }>(
              "select current_user as user",
            );
            return rows[0]?.user;
          } finally {
            await session.close();
          }
        }),
      );
    } finally {
      await Promise.all(clients.map((client) => client.stop()));
    }
  }

  async function owner(database: string): Promise<string | undefined> {
    const rows = await server.query<{ owner: string }>(
      "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
      [database],
    );
    return rows[0]?.owner;
  }

  test("all create a missing database without failing each other", async () => {
    for (let round = 1; round <= 5; round++) {
      const database = `race_create_${process.pid}_${round}`;

      const users = await connectAtOnce(database, 8);

      expect(users).toEqual(Array(8).fill(embeddedDeployRole));
      expect(await owner(database)).toBe(embeddedDeployRole);
    }
  });

  test("all hand a database the superuser created to the deploy role without failing each other", async () => {
    for (let round = 1; round <= 5; round++) {
      const database = await server.createDatabase();

      const users = await connectAtOnce(database, 8);

      expect(users).toEqual(Array(8).fill(embeddedDeployRole));
      expect(await owner(database)).toBe(embeddedDeployRole);
    }
  });
});
