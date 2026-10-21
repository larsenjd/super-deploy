// A host that accepts TCP connections and never answers, like a firewalled
// host or a wrong VPN as far as a client can tell, but local and immediate,
// so a test doesn't depend on how the machine routes a non-routable address.
import { createServer, type Socket } from "node:net";
import { onTestFinished } from "vitest";

export interface SilentHost {
  /** A PostgreSQL URL pointing at the host. */
  readonly url: string;
  /** `127.0.0.1:<port>`, as a message names it. */
  readonly address: string;
  /** Resolves once a client has connected (and is waiting for an answer). */
  readonly connected: Promise<void>;
}

/** Starts a silent host, closed when the current test finishes. */
export async function silentHost(): Promise<SilentHost> {
  const sockets = new Set<Socket>();
  let markConnected: () => void = () => {};
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    markConnected();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://u:p@127.0.0.1:${port}/x`,
    address: `127.0.0.1:${port}`,
    connected,
  };
}
