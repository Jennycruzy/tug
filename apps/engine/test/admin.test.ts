import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminPortFor, listenAdmin } from "../src/admin.js";
import { openDb } from "../src/db.js";

const hold = (port: number) => new Promise<Server>((resolve) => { const s = createServer(); s.listen(port, "127.0.0.1", () => resolve(s)); });

describe("/admin/pause port", () => {
  it("mainnet defaults to 8793 (8791 is another service's on the server); testnet to 8792", () => {
    expect(adminPortFor("mainnet")).toBe(8793);
    expect(adminPortFor("testnet")).toBe(8792);
  });

  it("listenAdmin rejects when the port is taken, and answers POST /admin/pause when it is free", async () => {
    const taken = await hold(0);
    const port = (taken.address() as { port: number }).port;
    await expect(listenAdmin(port, async () => {})).rejects.toMatchObject({ code: "EADDRINUSE" });
    taken.close();
    let paused = 0;
    const s = await listenAdmin(port, async () => void paused++);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/admin/pause`, { method: "POST" });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { paused: boolean }).paused).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/admin/pause`)).status).toBe(404);
      expect(paused).toBe(1);
    } finally {
      s.close();
    }
  });

  it("the trader service exits before starting when its admin port is taken, and sends nothing", async () => {
    const taken = await hold(0);
    const port = (taken.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "tug-admin-"));
    const seed = (generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("hex");
    writeFileSync(join(dir, "key"), seed);
    const run = spawnSync("node_modules/.bin/tsx", ["apps/engine/src/trader-main.ts"], {
      env: { ...process.env, TUG_NETWORK: "testnet", TUG_DB: join(dir, "tug.db"), TUG_ACCOUNT_KEY_FILE: join(dir, "key"), TUG_ADMIN_PORT: String(port), TUG_TRADING: "on", STRIKE_API_URL: "https://example.invalid", STRIKE_WS_USER: "wss://example.invalid" },
      encoding: "utf8",
      timeout: 60_000,
    });
    taken.close();
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("trader start");
    const db = openDb(join(dir, "tug.db"));
    const events = db.prepare("SELECT code, message FROM events").all() as Array<{ code: string | null; message: string }>;
    const calls = (db.prepare("SELECT COUNT(*) AS n FROM strike_calls").get() as { n: number }).n;
    db.close();
    expect(events.map((e) => e.code)).toEqual(["E-ADMIN-PORT"]);
    expect(calls).toBe(0);
  }, 90_000);
});
