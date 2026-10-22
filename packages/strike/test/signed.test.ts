import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StrikeSigned, keyFromHex, signingMessage, wsLogonMessage } from "../src/index.js";

// RFC 8032 section 7.1, test 1.
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
// Real Strike testnet replies, captured 2026-10-22 (server, time and request in the file).
const REPLIES = JSON.parse(readFileSync(new URL("./fixtures/order-replies-testnet-2026-10-22.json", import.meta.url), "utf8")).replies as Record<
  string,
  { status: number; raw: string }
>;
const SPKI = (hex: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "spki" });

/** Answers the client's next request with one of Strike's real captured replies, and records the request. */
async function withReply<T>(reply: { status: number; raw: string }, run: () => Promise<T>) {
  const seen: Array<{ headers: Record<string, string>; body: string; url: string }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body ?? "") });
    return new Response(reply.raw, { status: reply.status });
  }) as typeof fetch;
  try {
    return { result: await run(), seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("Strike API wallet signing", () => {
  it("derives the public key from the private key", () => {
    expect(keyFromHex(SECRET).publicKeyHex).toBe(PUBLIC);
    expect(new StrikeSigned(SECRET, "https://example.invalid").publicKeyHex).toBe(PUBLIC);
  });
  it("T-SIGN-1 a GET message carries the path with its query", () => {
    const m = signingMessage("GET", "/v2/openOrders?symbol=ETH-USD", 1792676531, "n-1", "");
    expect(m.startsWith("GET:/v2/openOrders?symbol=ETH-USD:1792676531:n-1:")).toBe(true);
  });
  it("T-SIGN-2 a POST message ends with the SHA-256 of the exact body sent, and the signature verifies", async () => {
    const { result, seen } = await withReply(REPLIES.order_accepted!, () => new StrikeSigned(SECRET, "https://example.invalid").ok("POST", "/v2/order", { symbol: "ETH-USD", size: "0.006" }));
    expect(result.status).toBe(201);
    const h = seen[0]!.headers;
    const body = seen[0]!.body;
    const msg = signingMessage("POST", "/v2/order", Number(h["X-API-Wallet-Timestamp"]), h["X-API-Wallet-Nonce"]!, body);
    expect(msg.endsWith(`:${createHash("sha256").update(body).digest("hex")}`)).toBe(true);
    expect(verify(null, Buffer.from(msg), SPKI(PUBLIC), Buffer.from(h["X-API-Wallet-Signature"]!, "hex"))).toBe(true);
    expect(seen[0]!.url).toBe("https://example.invalid/v2/order");
  });
  it("T-SIGN-3 an empty body hashes to the SHA-256 of nothing", () => {
    expect(signingMessage("GET", "/v2/time", 1, "n", "").split(":").pop()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("T-SIGN-4 the user-stream logon message is session.logon:<time>:<public key>", () => {
    expect(wsLogonMessage(1792676531, PUBLIC)).toBe(`session.logon:1792676531:${PUBLIC}`);
  });
  it("turns Strike's real 404 reply into E-STRIKE with Strike's words", async () => {
    await expect(withReply(REPLIES.order_not_found!, () => new StrikeSigned(SECRET, "https://example.invalid").ok("GET", "/v2/order?symbol=ETH-USD&client_order_id=x"))).rejects.toMatchObject({
      code: "E-STRIKE",
      message: expect.stringContaining("order not found"),
    });
  });

  // Needs the testnet key, so it runs on the build server and is reported as skipped elsewhere (never as passed).
  const keyFile = process.env.TUG_ACCOUNT_KEY_FILE;
  it.runIf(Boolean(keyFile && existsSync(keyFile) && process.env.STRIKE_API_URL?.includes("testnet")))(
    "T-SIGN-4 (live) Strike testnet accepts a signed read",
    async () => {
      const c = StrikeSigned.fromFile(keyFile!);
      const r = await c.call("GET", "/v2/openOrders?symbol=ETH-USD");
      expect(r.status).toBe(200);
    },
  );
});
