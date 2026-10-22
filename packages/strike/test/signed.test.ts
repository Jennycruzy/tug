import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StrikeSigned, keyFromHex, signingMessage } from "../src/index.js";

// RFC 8032 section 7.1, test 1.
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

describe("Strike API wallet signing", () => {
  it("derives the public key from the private key", () => {
    expect(keyFromHex(SECRET).publicKeyHex).toBe(PUBLIC);
    expect(new StrikeSigned(SECRET, "https://example.invalid").publicKeyHex).toBe(PUBLIC);
  });
  it("builds the message from method, path with query, time, nonce and body hash", () => {
    const m = signingMessage("GET", "/v2/openOrders?symbol=ETH-USD", 1792676531, "n-1", "");
    expect(m).toBe(
      "GET:/v2/openOrders?symbol=ETH-USD:1792676531:n-1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("signs calls the public key verifies", async () => {
    const seen: Array<{ headers: Record<string, string>; body: string; url: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body ?? "") });
      return new Response('{"ok":true}', { status: 201 });
    }) as typeof fetch;
    try {
      const c = new StrikeSigned(SECRET, "https://example.invalid");
      const r = await c.ok("POST", "/v2/order", { symbol: "ETH-USD" });
      expect(r.status).toBe(201);
    } finally {
      globalThis.fetch = realFetch;
    }
    const h = seen[0]!.headers;
    const msg = signingMessage("POST", "/v2/order", Number(h["X-API-Wallet-Timestamp"]), h["X-API-Wallet-Nonce"]!, seen[0]!.body);
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUBLIC, "hex")]), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(msg), pub, Buffer.from(h["X-API-Wallet-Signature"]!, "hex"))).toBe(true);
    expect(seen[0]!.url).toBe("https://example.invalid/v2/order");
  });
  it("turns a refusal into E-STRIKE with Strike's message", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"order_would_match_immediately"}', { status: 400 })) as unknown as typeof fetch;
    try {
      await expect(new StrikeSigned(SECRET, "https://example.invalid").ok("POST", "/v2/order", {})).rejects.toMatchObject({
        code: "E-STRIKE",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
