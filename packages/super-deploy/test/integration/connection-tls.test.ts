// API seam for TLS on postgresTarget's connection strings: `sslmode` means
// what it means to libpq and psql, and node-postgres prints no warning of its
// own. The server gets TLS from test/fixtures/tls, a self-signed certificate
// for 127.0.0.1 standing in for a server with a private CA.
import { chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterError, postgresTarget } from "super-deploy";
import { embeddedPostgres } from "super-deploy/embedded-postgres";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { startTestServer, type TestServer } from "../support/postgres.ts";

const certificate = fileURLToPath(
  new URL("../fixtures/tls/server.crt", import.meta.url),
);
const key = fileURLToPath(
  new URL("../fixtures/tls/server.key", import.meta.url),
);

let server: TestServer;
let url: string;
beforeAll(async () => {
  server = await startTestServer();
  // server.crt and server.key in the data directory are PostgreSQL's
  // defaults; it refuses a key others can read, and git doesn't keep 0600.
  await copyFile(certificate, join(server.dataDir, "server.crt"));
  await copyFile(key, join(server.dataDir, "server.key"));
  await chmod(join(server.dataDir, "server.key"), 0o600);
  await server.query("alter system set ssl = on");
  await server.query("select pg_reload_conf()");
  url = await embeddedPostgres({ dataDir: server.dataDir }).connectionString();
});
afterAll(async () => {
  await server?.stop();
});

/** Whether a session over `connectionString` is encrypted. */
async function encrypted(connectionString: string): Promise<boolean> {
  const session = await postgresTarget({ connectionString }).connect();
  try {
    const { rows } = await session.query<{ ssl: boolean }>(
      "select ssl from pg_stat_ssl where pid = pg_backend_pid()",
    );
    return rows[0]?.ssl ?? false;
  } finally {
    await session.close();
  }
}

test("without sslmode the connection isn't encrypted", async () => {
  await expect(encrypted(url)).resolves.toBe(false);
});

test.each([
  ["require", "?sslmode=require"],
  ["prefer", "?sslmode=prefer"],
  [
    "require, even with uselibpqcompat=false,",
    "?uselibpqcompat=false&sslmode=require",
  ],
])(
  "sslmode=%s encrypts without verifying the certificate, and prints no warning",
  async (_, query) => {
    const warn = vi.spyOn(process, "emitWarning");

    await expect(encrypted(`${url}${query}`)).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  },
);

test("sslmode=verify-full refuses a certificate it can't verify", async () => {
  await expect(encrypted(`${url}?sslmode=verify-full`)).rejects.toThrow(
    /self-signed certificate/,
  );
});

test("sslmode=verify-ca without sslrootcert is refused before connecting", async () => {
  const error = await encrypted(`${url}?sslmode=verify-ca`).catch(
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(AdapterError);
  expect(error).toMatchObject({ code: "connection-string-invalid" });
  expect((error as AdapterError).message).toMatch(
    /^The deployment adapter's connection string has sslmode=verify-ca without sslrootcert/,
  );
});

test.each(["verify-ca", "verify-full"])(
  "sslmode=%s with the server's CA in sslrootcert connects",
  async (mode) => {
    await expect(
      encrypted(`${url}?sslmode=${mode}&sslrootcert=${certificate}`),
    ).resolves.toBe(true);
  },
);
