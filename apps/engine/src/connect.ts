import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { TugError } from "@tug/core";
import { keyFromHex } from "@tug/strike";
import { z } from "zod";
import { logEvent, type Db } from "./db.js";

/**
 * TUG in your account (Builder Connect, §11.3). The server makes an Ed25519 key pair for each connection, asks
 * Strike for the consent message, the person's own wallet signs it, and Strike registers the public key on their
 * account under TUG's builder code. The private key is stored only encrypted (AES-256-GCM with TUG_KEK), is
 * decrypted in memory by the connection runner, and is deleted on Stop. Each connection is controlled by a random
 * token held by the person's browser; only its SHA-256 is stored.
 */

/** AES-256-GCM: base64 of iv (12 bytes) | tag (16 bytes) | ciphertext. */
export function encryptKey(kek: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

export function decryptKey(kek: Buffer, enc: string): string {
  const b = Buffer.from(enc, "base64");
  const d = createDecipheriv("aes-256-gcm", kek, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

/** TUG_KEK: 32 bytes, base64. */
export function kekFrom(value: string | undefined): Buffer {
  const k = Buffer.from(value ?? "", "base64");
  if (k.length !== 32) throw new TugError("E-KEY", "TUG_KEK must be 32 bytes of base64.");
  return k;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_ACTIVE = 20;

export const StartBody = z.object({
  network: z.literal("testnet"),
  chain: z.enum(["cardano", "ethereum", "solana"]),
  address: z.string().min(20).max(200).regex(/^[A-Za-z0-9_]+$/),
});
export const VerifyBody = z.object({ id: z.string().uuid(), token: z.string().length(64), wallet_signature: z.string().min(10).max(4000) });
export const ActivateBody = z.object({ id: z.string().uuid(), token: z.string().length(64), budget_usd: z.number().min(10).max(10_000), accept_risk: z.literal(true) });
export const StopBody = z.object({ id: z.string().uuid(), token: z.string().length(64), close_positions: z.boolean() });

export interface ConnectRow {
  id: string;
  token_sha256: string;
  network: string;
  chain: string;
  address: string;
  api_pubkey: string;
  enc_privkey: string | null;
  nonce: string | null;
  account_id: string | null;
  fee_share_bps: number | null;
  budget_usd: number | null;
  close_on_stop: number;
  start_equity: number | null;
  status: "signing" | "verified" | "active" | "stopping" | "ended" | "failed";
  error: string | null;
  stop_report: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export class Connect {
  constructor(
    private readonly db: Db,
    private readonly o: { kek: Buffer; code: string; feeBps: number; strikeUrl: string },
  ) {}

  private async strike(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(this.o.strikeUrl + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const text = await r.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { error: text.slice(0, 200) };
    }
    return { status: r.status, json };
  }

  /** The connection, if the token is the one handed out for it. */
  owned(id: string, token: string): ConnectRow {
    const row = this.db.prepare("SELECT * FROM connections WHERE id=?").get(id) as ConnectRow | undefined;
    const ok = row && timingSafeEqual(Buffer.from(row.token_sha256, "hex"), Buffer.from(sha(token), "hex"));
    if (!row || !ok) throw new TugError("E-CONN", "Your wallet connection could not be verified.");
    return row;
  }

  /** Step 1: a new key pair and Strike's consent message for the person's wallet to sign. */
  async start(input: unknown): Promise<{ id: string; token: string; message_to_sign: string; public_key: string; fee_share_bps: number }> {
    const b = StartBody.parse(input);
    const active = (this.db.prepare("SELECT COUNT(*) AS n FROM connections WHERE network=? AND status IN ('active','stopping')").get(b.network) as { n: number }).n;
    if (active >= MAX_ACTIVE) throw new TugError("E-CONN", `TUG runs at most ${MAX_ACTIVE} accounts per network; try again later.`);
    const secret = randomBytes(32).toString("hex");
    const pub = keyFromHex(secret).publicKeyHex;
    const r = await this.strike("/auth/builder/request-signature", { address: b.address, chain: b.chain, code: this.o.code, fee_share_bps: this.o.feeBps, public_key: pub });
    if (r.status !== 200 || typeof r.json.message_to_sign !== "string" || typeof r.json.nonce !== "string") {
      throw new TugError("E-CONN", `Strike did not start the connection: ${String(r.json.error ?? r.status)}`);
    }
    const id = randomUUID();
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO connections (id, token_sha256, network, chain, address, api_pubkey, enc_privkey, nonce, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'signing',?,?)",
      )
      .run(id, sha(token), b.network, b.chain, b.address, pub, encryptKey(this.o.kek, secret), r.json.nonce, now, now);
    logEvent(this.db, "connect", "info", "connection started", undefined, { id, chain: b.chain, network: b.network });
    return { id, token, message_to_sign: r.json.message_to_sign, public_key: pub, fee_share_bps: this.o.feeBps };
  }

  /** Step 2: the wallet's signature goes to Strike, which registers TUG's key on the person's account. */
  async verify(input: unknown): Promise<{ account: string; fee_share_bps: number }> {
    const b = VerifyBody.parse(input);
    const row = this.owned(b.id, b.token);
    if (row.status !== "signing" || !row.nonce) throw new TugError("E-CONN", "This connection is not waiting for a signature.");
    const r = await this.strike("/auth/builder/verify-signature", { nonce: row.nonce, wallet_signature: b.wallet_signature });
    const now = Date.now();
    if (r.status !== 200 || typeof r.json.account_id !== "string" || r.json.api_wallet_public_key !== row.api_pubkey) {
      // Strike's challenge is single-use: a failed attempt ends this connection; the key is deleted.
      this.db.prepare("UPDATE connections SET status='failed', enc_privkey=NULL, nonce=NULL, error=?, updated_at=? WHERE id=?").run(String(r.json.error ?? r.status), now, row.id);
      logEvent(this.db, "connect", "warn", "Your wallet connection could not be verified.", "E-CONN", { id: row.id, strike: r.json.error ?? r.status });
      throw new TugError("E-CONN", `Your wallet connection could not be verified: ${String(r.json.error ?? r.status)}`);
    }
    this.db
      .prepare("UPDATE connections SET status='verified', nonce=NULL, account_id=?, fee_share_bps=?, updated_at=? WHERE id=?")
      .run(r.json.account_id, Number(r.json.fee_share_bps ?? this.o.feeBps), now, row.id);
    logEvent(this.db, "connect", "info", "connection verified", undefined, { id: row.id });
    return { account: shortId(r.json.account_id), fee_share_bps: Number(r.json.fee_share_bps ?? this.o.feeBps) };
  }

  /** Step 3: the budget cap and the risk acknowledgement; TUG starts trading the account within it. */
  activate(input: unknown): { status: string; budget_usd: number } {
    const b = ActivateBody.parse(input);
    const row = this.owned(b.id, b.token);
    if (row.status !== "verified") throw new TugError("E-CONN", "Connect a wallet first.");
    const now = Date.now();
    this.db.prepare("UPDATE connections SET status='active', budget_usd=?, started_at=?, updated_at=? WHERE id=?").run(b.budget_usd, now, now, row.id);
    logEvent(this.db, "connect", "info", "connection active", undefined, { id: row.id, budget: b.budget_usd });
    return { status: "active", budget_usd: b.budget_usd };
  }

  /** Stop: the runner cancels TUG's orders (and closes positions if asked), then deletes the key. */
  stop(input: unknown): { status: string } {
    const b = StopBody.parse(input);
    const row = this.owned(b.id, b.token);
    const now = Date.now();
    if (row.status === "signing" || row.status === "verified") {
      // Nothing was traded: the key is deleted at once.
      this.db.prepare("UPDATE connections SET status='ended', enc_privkey=NULL, nonce=NULL, ended_at=?, updated_at=?, stop_report=? WHERE id=?").run(now, now, JSON.stringify({ at: now, traded: false }), row.id);
      return { status: "ended" };
    }
    if (row.status !== "active") return { status: row.status };
    this.db.prepare("UPDATE connections SET status='stopping', close_on_stop=?, updated_at=? WHERE id=?").run(b.close_positions ? 1 : 0, now, row.id);
    logEvent(this.db, "connect", "info", "connection stopping", undefined, { id: row.id, close: b.close_positions });
    return { status: "stopping" };
  }

  /** What the person sees: status, budget, and the account's latest equity, positions and fills. */
  view(id: string, token: string) {
    const row = this.owned(id, token);
    const net = connectionNetwork(row.id);
    const eq = this.db.prepare("SELECT ts, equity, positions_json FROM live_equity WHERE network=? ORDER BY ts DESC LIMIT 1").get(net) as { ts: number; equity: number; positions_json: string } | undefined;
    const fills = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(role='maker'),0) AS maker, COALESCE(SUM(fee),0) AS fees FROM fills WHERE network=?").get(net) as { n: number; maker: number; fees: number };
    const orders = (this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE network=? AND status IN ('pending','new','open','partially_filled')").get(net) as { n: number }).n;
    const events = this.db.prepare("SELECT ts, level, code, message FROM events WHERE data_json LIKE ? ORDER BY ts DESC LIMIT 5").all(`%${row.id}%`);
    return {
      id: row.id,
      status: row.status,
      network: row.network,
      chain: row.chain,
      account: row.account_id ? shortId(row.account_id) : null,
      budget_usd: row.budget_usd,
      fee_share_bps: row.fee_share_bps,
      key_held: row.enc_privkey !== null,
      equity: eq ? { at: eq.ts, equity: eq.equity, positions: JSON.parse(eq.positions_json) as Record<string, { size: string; entry: number; upnl: number }> } : null,
      fills: fills.n,
      maker_fills: fills.maker,
      fees: fills.fees,
      open_orders: orders,
      stop_report: row.stop_report ? (JSON.parse(row.stop_report) as unknown) : null,
      error: row.error,
      events,
      created_at: row.created_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
    };
  }
}

/** The network name a connection's rows are stored under (orders, fills, equity): `c` + the first 8 hex of its id. */
export const connectionNetwork = (id: string) => `c${id.replace(/-/g, "").slice(0, 8)}`;
const shortId = (id: unknown) => {
  const s = String(id);
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
};
