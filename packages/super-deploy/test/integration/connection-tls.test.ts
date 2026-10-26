// API seam for TLS on postgresTarget's (and postgresRehearsal's) connection strings: `sslmode` means
// what it means to libpq and psql, and node-postgres prints no warning of its
// own. The server gets TLS from test/fixtures/tls, a self-signed certificate
// for 127.0.0.1 standing in for a server with a private CA.
import { chmod, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdapterError, postgresRehearsal, postgresTarget } from "super-deploy";
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

/** The error `postgresTarget` gives for `connectionString`, before any connection. */
async function refusal(connectionString: string): Promise<AdapterError> {
  const error = await encrypted(connectionString).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AdapterError);
  expect(error).toMatchObject({ code: "connection-string-invalid" });
  return error as AdapterError;
}

test.each(["sslrootcert", "sslcert", "sslkey"])(
  "a %s file that doesn't exist is named with the reason, before connecting",
  async (parameter) => {
    const error = await refusal(
      `${url}?sslmode=verify-full&${parameter}=/nonexistent.pem`,
    );

    expect(error.message).toBe(
      `The deployment adapter: ${parameter} file /nonexistent.pem can't be read: no such file or directory`,
    );
    expect(error.cause).toMatchObject({ code: "ENOENT" });
  },
);

test("a directory as sslrootcert is named as a directory", async () => {
  const error = await refusal(
    `${url}?sslmode=verify-ca&sslrootcert=${server.dataDir}`,
  );

  expect(error.message).toBe(
    `The deployment adapter: sslrootcert file ${server.dataDir} can't be read: it is a directory`,
  );
});

test("a relative sslrootcert's message shows where it was looked for", async () => {
  const error = await refusal(
    `${url}?sslmode=verify-full&sslrootcert=missing-ca.pem`,
  );

  expect(error.message).toBe(
    `The deployment adapter: sslrootcert file missing-ca.pem (${join(process.cwd(), "missing-ca.pem")}) can't be read: no such file or directory. A relative path is read from the directory the command runs in.`,
  );
});

test("sslmode=disable ignores an unreadable sslrootcert, as libpq does", async () => {
  await expect(
    encrypted(`${url}?sslmode=disable&sslrootcert=/nonexistent.pem`),
  ).resolves.toBe(false);
});

test.each(["bogus", "DISABLE", "verify_full"])(
  "sslmode=%s is refused before connecting, naming the valid values",
  async (mode) => {
    const error = await refusal(`${url}?sslmode=${mode}`);

    expect(error.message).toBe(
      `The deployment adapter's connection string has sslmode=${mode}, which isn't one of disable, allow, prefer, require, verify-ca, verify-full`,
    );
  },
);

test("sslmode=allow connects without encrypting", async () => {
  await expect(encrypted(`${url}?sslmode=allow`)).resolves.toBe(false);
});

test.each([
  [
    "an unreadable sslrootcert",
    "sslmode=verify-full&sslrootcert=/nonexistent.pem",
    "The rehearsal adapter: sslrootcert file /nonexistent.pem can't be read: no such file or directory",
  ],
  [
    "an sslmode libpq doesn't know",
    "sslmode=bogus",
    "The rehearsal adapter's connection string has sslmode=bogus, which isn't one of disable, allow, prefer, require, verify-ca, verify-full",
  ],
])(
  "postgresRehearsal refuses %s the same way, before connecting",
  async (_, parameters, message) => {
    const rehearsal = postgresRehearsal({
      connectionString: `${url}?${parameters}`,
    });

    const error = await rehearsal
      .createDatabase({
        encoding: "UTF8",
        locale: "C",
        collationProvider: "libc",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "connection-string-invalid", message });
  },
);
