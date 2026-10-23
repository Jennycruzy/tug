import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserStream } from "../src/userStream.js";

describe("user stream logon timeout", () => {
  it("a server that accepts the connection but never answers (Strike, 23 Oct 05:39) is closed and retried", async () => {
    // A real TCP server that takes the connection and then says nothing, as Strike's socket did during its outage.
    const held: Socket[] = [];
    const server = createServer((s) => void held.push(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "tug-ws-"));
    const seed = (generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("hex");
    writeFileSync(join(dir, "key"), seed);
    const states: string[] = [];
    const stream = new UserStream(join(dir, "key"), { status: (s) => void states.push(`${s.state}${s.reason ? `:${s.reason}` : ""}`) }, { url: `ws://127.0.0.1:${port}/ws/user-api`, logonTimeoutMs: 200 });
    stream.start();
    await new Promise((r) => setTimeout(r, 2_000));
    stream.stop();
    for (const s of held) s.destroy();
    server.close();
    // connecting → closed by the timeout → connecting again (after the 1 s backoff), and never "open".
    expect(states[0]).toBe("connecting");
    expect(states).toContain("closed:logon timeout");
    expect(states.filter((s) => s === "connecting").length).toBeGreaterThanOrEqual(2);
    expect(states).not.toContain("open");
    expect(held.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});
