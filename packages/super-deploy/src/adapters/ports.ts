// Local TCP ports for embedded PostgreSQL servers: a free one for a server
// without a configured port, and whether a configured one is free. `init`
// also writes a free one into the new project's config for `dev`.
import { createServer } from "node:net";

/** The only address embedded servers listen on. */
export const localHost = "127.0.0.1";

/** `host:port` as a URL writes it: an IPv6 address in brackets. */
export function hostAndPort(host: string, port: number | string): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** A port of 127.0.0.1 that is free now (the system picks it). */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, localHost, () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("Could not find a free port"));
        }
      });
    });
  });
}

/**
 * Whether something listens on `port` of 127.0.0.1 now. Only "address in
 * use" counts: any other failure to listen (such as a port this user may not
 * use) is left to the server's own start to report.
 */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolveInUse) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      resolveInUse(error.code === "EADDRINUSE");
    });
    probe.listen(port, localHost, () => {
      probe.close(() => resolveInUse(false));
    });
  });
}
