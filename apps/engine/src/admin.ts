import { createServer, type Server } from "node:http";

/** Loopback port of POST /admin/pause per network. 8791 is taken by another service on the server (decisions.md). */
export const adminPortFor = (network: string): number => (network === "mainnet" ? 8793 : network === "vault" ? 8794 : 8792);

/**
 * Opens POST /admin/pause on 127.0.0.1 (§9.7) and resolves once it is listening; rejects if the port cannot
 * be bound, so the caller can exit before any trading starts.
 */
export function listenAdmin(port: number, pause: () => Promise<unknown>): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/admin/pause") {
      res.writeHead(404).end();
      return;
    }
    const t0 = Date.now();
    pause()
      .then(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ paused: true, ms: Date.now() - t0 })))
      .catch((e: Error) => res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ paused: true, error: e.message })));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
