import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { TugError, USER_AGENT, type WeightBucket } from "@tug/core";
import { z } from "zod";
import { STRIKE_API_URL, strikeBucket } from "./index.js";

/** PKCS#8 prefix for a raw 32-byte Ed25519 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function keyFromHex(hex: string): { key: KeyObject; publicKeyHex: string } {
  const raw = Buffer.from(hex.trim(), "hex");
  if (raw.length !== 32) throw new TugError("E-KEY", "The API wallet key must be 32 bytes of hex.");
  const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return { key, publicKeyHex: spki.subarray(spki.length - 32).toString("hex") };
}

/** Strike's API wallet message: METHOD:path?query:unix_seconds:nonce:sha256_hex(body). */
export function signingMessage(method: string, path: string, ts: number, nonce: string, body: string): string {
  return `${method}:${path}:${ts}:${nonce}:${createHash("sha256").update(body).digest("hex")}`;
}

export interface SignedReply {
  status: number;
  json: unknown;
  raw: string;
  at: number;
}

/** Writes are weighted higher than reads; Strike publishes 1,200 orders per minute separately. */
const WRITE_WEIGHT = 10;
const READ_WEIGHT = 5;

/**
 * A Strike client signing every call with one API wallet. Single attempt per call: a retried
 * write could place a second order, so callers decide what to do after a failure.
 */
export class StrikeSigned {
  readonly publicKeyHex: string;
  private readonly key: KeyObject;

  constructor(
    keyHex: string,
    readonly baseUrl: string = STRIKE_API_URL,
    private readonly bucket: WeightBucket = strikeBucket,
  ) {
    const k = keyFromHex(keyHex);
    this.key = k.key;
    this.publicKeyHex = k.publicKeyHex;
  }

  static fromFile(path: string, baseUrl?: string): StrikeSigned {
    return new StrikeSigned(readFileSync(path, "utf8"), baseUrl);
  }

  async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<SignedReply> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const signature = sign(null, Buffer.from(signingMessage(method, path, ts, nonce, text)), this.key).toString("hex");
    await this.bucket.take(method === "GET" ? READ_WEIGHT : WRITE_WEIGHT);
    const res = await fetch(this.baseUrl + path, {
      method,
      body: text || undefined,
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(text ? { "content-type": "application/json" } : {}),
        "X-API-Wallet-Public-Key": this.publicKeyHex,
        "X-API-Wallet-Signature": signature,
        "X-API-Wallet-Timestamp": String(ts),
        "X-API-Wallet-Nonce": nonce,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, raw, at: Date.now() };
  }

  /** Same as call, but a non-2xx reply becomes E-STRIKE with Strike's own message. */
  async ok(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<SignedReply> {
    const r = await this.call(method, path, body);
    if (r.status < 200 || r.status >= 300) {
      throw new TugError("E-STRIKE", `Strike replied ${r.status} to ${method} ${path}: ${r.raw.slice(0, 300)}`);
    }
    return r;
  }
}

const num = z.union([z.string(), z.number()]).transform((v) => Number(v));

export const OrderAckSchema = z
  .object({ client_order_id: z.string(), symbol: z.string(), status: z.string() })
  .passthrough();

export const OpenOrderSchema = z
  .object({
    ID: z.number(),
    ClientOrderID: z.string(),
    Symbol: z.string(),
    Side: z.string(),
    Status: z.string(),
    Size: num,
    Filled: num,
    Price: num,
    PostOnly: z.boolean(),
  })
  .passthrough();
export type OpenOrder = z.infer<typeof OpenOrderSchema>;

export const OpenOrdersSchema = z.object({ count: z.number(), orders: z.array(OpenOrderSchema).nullable() });

export const CancelAckSchema = z
  .object({ order_id: z.number().optional(), client_order_id: z.string().optional(), symbol: z.string() })
  .passthrough();
