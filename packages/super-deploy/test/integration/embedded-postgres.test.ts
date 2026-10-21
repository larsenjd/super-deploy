// API seam for the embedded-postgres adapter's own options: a server on the
// port its config declares, so a local target such as `dev` is always at a
// known URL.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { AdapterError } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import { describe, expect, onTestFinished, test } from "vitest";

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

/** A port of 127.0.0.1 that is free now. */
async function freePortNow(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address !== "object") {
    throw new Error("no port");
  }
  return address.port;
}

describe("embeddedPostgres with a port", () => {
  test("the server listens on the configured port of 127.0.0.1", async () => {
    const port = await freePortNow();
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
