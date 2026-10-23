import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRules } from "@tug/core";
import { keyFromHex, StrikeSigned } from "@tug/strike";
import { buildApi } from "../src/api.js";
import { Connect, connectionNetwork, decryptKey, encryptKey, type ConnectRow } from "../src/connect.js";
import { ConnectRunner } from "../src/connectRunner.js";
import { openDb } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { Trader } from "../src/trader.js";

const { rules } = loadRules("rules/tug-rules-v1.json");
const KEK = Buffer.alloc(32, 7);
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const TESTNET = "https://api-v2-testnet.strikefinance.org";
const ADDRESS = "addr_test1qpsemj96k72fttx68vgrj656qws8mz90h3x3uclfvpr4hqaw4p707x38mfrqs549pw5jhd2h05vh0n85uc5pnq2dgnfq8p28y9";
// Real testnet replies of the order path (positions_one: a real ETH-USD position; order_open: a real resting order).
const R = JSON.parse(readFileSync(new URL("./fixtures/order-path-testnet-2026-10-22.json", import.meta.url), "utf8")).replies as Record<string, { status: number; raw: string }>;

/** Answers by URL and records every request (method, url, body, headers). */
function answerWith(answer: (method: string, url: string, body: Record<string, unknown> | null) => { status: number; raw: string }) {
  const sent: Array<{ method: string; url: string; body: Record<string, unknown> | null; headers: Record<string, string> }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = answer(method, url, body);
    return new Response(r.raw, { status: r.status });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

// Strike's documented replies for the two Builder Connect calls (strike-auth skill), filled in for this request.
const signatureReply = (pub: string) => ({
  status: 200,
  raw: JSON.stringify({ nonce: "0192f0c1-7b8e-7c3a-9d61-2f1e4b5a6c7d", message_to_sign: `Connect to Strike via builder "tug".\nAPI Key: ${pub}`, message: "x" }),
});
const verifiedReply = (pub: string) => ({
  status: 200,
  raw: JSON.stringify({ account_id: "01a144dc-27e4-706c-ac46-9c2c1e77d60b", builder_code: "tug", fee_share_bps: 1, api_wallet_id: 1234, api_wallet_public_key: pub, api_wallet_expired_at: "9999-12-31T23:59:59Z" }),
});

/** A connection that was started, verified, activated and asked to stop (Strike's documented replies). */
async function stoppingConnection() {
  const { db, c } = connect();
  let io = answerWith((_m, _u, body) => signatureReply(String(body?.public_key)));
  const r = await c.start({ network: "testnet", chain: "cardano", address: ADDRESS }).finally(() => io.restore());
  io = answerWith(() => verifiedReply(r.public_key));
  await c.verify({ id: r.id, token: r.token, wallet_signature: "{}".padEnd(20, " ") }).finally(() => io.restore());
  c.activate({ id: r.id, token: r.token, budget_usd: 50, accept_risk: true });
  c.stop({ id: r.id, token: r.token, close_positions: false });
  const prefix = `tug-v${rules.version}-${connectionNetwork(r.id)}-`;
  const order = JSON.parse(R.order_open!.raw) as Record<string, unknown> & { ClientOrderID: string };
  return { db, c, r, prefix, order };
}

function connect() {
  const db = openDb(":memory:");
  return { db, c: new Connect(db, { kek: KEK, code: "tug", feeBps: 1, strikeUrl: TESTNET }) };
}

describe("TUG in your account (Builder Connect)", () => {
  it("T-CONN-1 targets are sized on the budget cap, not on the account's equity", () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "cabc", { trading: true, killFile: "/nonexistent/kill" });
    const t = new Trader(db, ex, rules, { network: "cabc", markets: rules.testnet_markets, tradingOn: () => true, pausedFile: "/nonexistent/p", keyFile: { hex: SECRET }, budgetUsd: 50 });
    expect(t.sizingEquity(1_000)).toBe(50);
    expect(t.sizingEquity(30)).toBe(30);
  });

  it("T-CONN-2 an order that would take gross exposure past budget × gross cap is not sent (E-BUDGET); a reducing order is", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "cabc", { trading: true, killFile: "/nonexistent/kill" });
    const t = new Trader(db, ex, rules, { network: "cabc", markets: rules.testnet_markets, tradingOn: () => true, pausedFile: "/nonexistent/p", keyFile: { hex: SECRET }, budgetUsd: 50 });
    const held = JSON.parse(R.positions_one!.raw) as { positions: Array<{ symbol: string; size: string }> };
    const pos = held.positions[0]!;
    const io = answerWith((_m, url) => (url.includes("/v2/openOrders") ? R.open_orders_empty! : R.positions_one!));
    try {
      const limit = 50 * rules.gross_exposure_cap;
      const price = 2400;
      const heldNotional = Math.abs(Number(pos.size)) * price;
      const away = Number(pos.size) >= 0 ? "buy" : "sell";
      const toward = away === "buy" ? "sell" : "buy";
      // Growing the position past the limit is refused.
      const tooBig = ((limit - heldNotional) / price + 0.05).toFixed(3);
      expect(await t.withinBudget({ symbol: pos.symbol, side: away, price: String(price), size: tooBig })).toBe(false);
      // Reducing the position always passes.
      expect(await t.withinBudget({ symbol: pos.symbol, side: toward, price: String(price), size: String(Math.abs(Number(pos.size)) / 2) })).toBe(true);
    } finally {
      io.restore();
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE code='E-BUDGET'").get() as { n: number }).n).toBe(1);
  });

  it("T-CONN-3 start asks Strike with TUG's code, a 1 bps fee and a fresh key; the key is stored only encrypted", async () => {
    const { db, c } = connect();
    const io = answerWith((_m, _u, body) => signatureReply(String(body?.public_key)));
    let r;
    try {
      r = await c.start({ network: "testnet", chain: "cardano", address: ADDRESS });
    } finally {
      io.restore();
    }
    expect(io.sent[0]!.url).toBe(`${TESTNET}/auth/builder/request-signature`);
    expect(Object.keys(io.sent[0]!.body!).sort()).toEqual(["address", "chain", "code", "fee_share_bps", "public_key"]);
    expect(io.sent[0]!.body).toMatchObject({ address: ADDRESS, chain: "cardano", code: "tug", fee_share_bps: 1 });
    expect(r.public_key).toMatch(/^[0-9a-f]{64}$/);
    const row = db.prepare("SELECT * FROM connections").get() as ConnectRow;
    const secret = decryptKey(KEK, row.enc_privkey!);
    expect(keyFromHex(secret).publicKeyHex).toBe(r.public_key);
    expect(row.enc_privkey).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain(r.token);
    // Mainnet is not offered; a wrong token controls nothing.
    await expect(c.start({ network: "mainnet", chain: "cardano", address: ADDRESS })).rejects.toThrow();
    expect(() => c.view(r.id, "0".repeat(64))).toThrow(/could not be verified/);
  });

  it("T-CONN-4 a failed signature ends the connection and deletes the key; a good one binds the account", async () => {
    for (const ok of [false, true]) {
      const { db, c } = connect();
      let io = answerWith((_m, _u, body) => signatureReply(String(body?.public_key)));
      const r = await c.start({ network: "testnet", chain: "ethereum", address: "0x1111111111111111111111111111111111111111" }).finally(() => io.restore());
      io = answerWith(() => (ok ? verifiedReply(r.public_key) : { status: 401, raw: '{"error":"wallet signature verification failed"}' }));
      const v = c.verify({ id: r.id, token: r.token, wallet_signature: "0x" + "ab".repeat(65) }).finally(() => io.restore());
      if (ok) await expect(v).resolves.toMatchObject({ fee_share_bps: 1 });
      else await expect(v).rejects.toThrow(/could not be verified/);
      const row = db.prepare("SELECT status, enc_privkey, account_id FROM connections").get() as ConnectRow;
      expect(row.status).toBe(ok ? "verified" : "failed");
      expect(row.enc_privkey === null).toBe(!ok);
      expect(io.sent[0]!.body).toEqual({ nonce: "0192f0c1-7b8e-7c3a-9d61-2f1e4b5a6c7d", wallet_signature: "0x" + "ab".repeat(65) });
    }
  });

  it("Stop cancels TUG's orders on the account, closes positions if asked, deletes the key and records it", async () => {
    const { db, c } = connect();
    let io = answerWith((_m, _u, body) => signatureReply(String(body?.public_key)));
    const r = await c.start({ network: "testnet", chain: "cardano", address: ADDRESS }).finally(() => io.restore());
    io = answerWith(() => verifiedReply(r.public_key));
    await c.verify({ id: r.id, token: r.token, wallet_signature: "{}".padEnd(20, " ") }).finally(() => io.restore());
    c.activate({ id: r.id, token: r.token, budget_usd: 50, accept_risk: true });
    expect(c.stop({ id: r.id, token: r.token, close_positions: false })).toEqual({ status: "stopping" });
    // One of TUG's orders rests on the account (a real open-orders reply, its client id set to this connection's).
    const prefix = `tug-v${rules.version}-${connectionNetwork(r.id)}-`;
    const order = JSON.parse(R.order_open!.raw) as Record<string, unknown>;
    const mine = { ...order, ClientOrderID: `${prefix}1-ETH-USD-0` };
    let cancelled = false;
    io = answerWith((method, url) => {
      if (method === "DELETE") {
        cancelled = true;
        // The shape of Strike's real cancel reply (testnet, stored 23 Oct), for this order.
        return { status: 200, raw: JSON.stringify({ order_id: Number(order.ID), client_order_id: mine.ClientOrderID, symbol: "ETH-USD", sequence_id: 94099703, message_id: "1792742470841-0" }) };
      }
      if (url.includes("/v2/openOrders")) return { status: 200, raw: JSON.stringify({ count: cancelled ? 0 : 1, orders: cancelled ? [] : [mine] }) };
      if (url.includes("/v2/positions")) return { status: 200, raw: '{"count":0,"positions":[]}' };
      return { status: 404, raw: "{}" };
    });
    const runner = new ConnectRunner(db, rules, { kek: KEK, strikeUrl: TESTNET, feeBps: 1, stateDir: "/nonexistent", killFile: "/nonexistent/kill", pollMs: 1 });
    try {
      await runner.tick();
    } finally {
      io.restore();
    }
    const row = db.prepare("SELECT * FROM connections").get() as ConnectRow;
    expect(row.status).toBe("ended");
    expect(row.enc_privkey).toBeNull();
    const report = JSON.parse(row.stop_report!) as { cancelled: string[]; open_orders_after: number };
    expect(report.cancelled).toEqual([`${prefix}1-ETH-USD-0`]);
    expect(report.open_orders_after).toBe(0);
    // Every order request carried the builder fee; the cancel did not need it.
    expect(io.sent.filter((s) => s.method === "DELETE").every((s) => s.headers["X-Builder-Fee-Bps"] === undefined)).toBe(true);
    expect(c.view(r.id, r.token)).toMatchObject({ status: "ended", key_held: false });
  });

  it("Stop keeps the key while an order placed during the cancel pass is still open, and finishes on the next pass", async () => {
    const { db, c, r, prefix, order } = await stoppingConnection();
    // Pass 1: one order is cancelled, but another (from a tick that was still running) is open on read-back.
    let open = [{ ...order, ClientOrderID: `${prefix}1-ETH-USD-0` }];
    let afterCancel = [{ ...order, ClientOrderID: `${prefix}2-ETH-USD-0` }];
    const runner = new ConnectRunner(db, rules, { kek: KEK, strikeUrl: TESTNET, feeBps: 1, stateDir: "/nonexistent", killFile: "/nonexistent/kill", pollMs: 1 });
    const strike = () =>
      answerWith((method, url, body) => {
        if (method === "DELETE") {
          open = open.filter((o) => o.ClientOrderID !== body?.client_order_id);
          if (open.length === 0) [open, afterCancel] = [afterCancel, []];
          return { status: 200, raw: JSON.stringify({ order_id: 1, client_order_id: body?.client_order_id, symbol: "ETH-USD", sequence_id: 1, message_id: "1-0" }) };
        }
        if (url.includes("/v2/openOrders")) return { status: 200, raw: JSON.stringify({ count: open.length, orders: open }) };
        if (url.includes("/v2/positions")) return { status: 200, raw: '{"count":0,"positions":[]}' };
        return { status: 404, raw: "{}" };
      });
    let io = strike();
    await runner.tick().finally(() => io.restore());
    let row = db.prepare("SELECT * FROM connections").get() as ConnectRow;
    expect(row.status).toBe("stopping");
    expect(row.enc_privkey).not.toBeNull();
    expect(JSON.parse(row.stop_report!)).toMatchObject({ tries: 1, open_orders_after: 1, key: "kept" });
    // Pass 2: the late order is cancelled, nothing is left, the key is deleted.
    io = strike();
    await runner.tick().finally(() => io.restore());
    row = db.prepare("SELECT * FROM connections").get() as ConnectRow;
    expect(row.status).toBe("ended");
    expect(row.enc_privkey).toBeNull();
    expect(JSON.parse(row.stop_report!)).toMatchObject({ tries: 2, open_orders_after: 0, key: "deleted", cancelled: [`${prefix}2-ETH-USD-0`] });
    expect(c.view(r.id, r.token).stop_report).toMatchObject({ strike_api_keys_page: "https://testnet.strikefinance.org/api-keys" });
  });

  it("Stop logs E-STOP-OPEN from the third try (once a minute at most) while an order will not go away, and never deletes the key meanwhile", async () => {
    const { db, prefix, order } = await stoppingConnection();
    const stuck = [{ ...order, ClientOrderID: `${prefix}9-ETH-USD-0` }];
    const runner = new ConnectRunner(db, rules, { kek: KEK, strikeUrl: TESTNET, feeBps: 1, stateDir: "/nonexistent", killFile: "/nonexistent/kill", pollMs: 1 });
    for (let i = 0; i < 5; i++) {
      const io = answerWith((method, url, body) =>
        method === "DELETE"
          ? { status: 200, raw: JSON.stringify({ order_id: 1, client_order_id: body?.client_order_id, symbol: "ETH-USD", sequence_id: 1, message_id: "1-0" }) }
          : url.includes("/v2/openOrders")
            ? { status: 200, raw: JSON.stringify({ count: 1, orders: stuck }) }
            : { status: 200, raw: '{"count":0,"positions":[]}' },
      );
      await runner.tick().finally(() => io.restore());
    }
    const row = db.prepare("SELECT status, enc_privkey FROM connections").get() as ConnectRow;
    expect(row.status).toBe("stopping");
    expect(row.enc_privkey).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE code='E-STOP-OPEN'").get() as { n: number }).n).toBe(1);
  });

  it("the budget check counts TUG's own resting orders on the same side", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "cabc", { trading: true, killFile: "/nonexistent/kill" });
    const t = new Trader(db, ex, rules, { network: "cabc", markets: rules.testnet_markets, tradingOn: () => true, pausedFile: "/nonexistent/p", keyFile: { hex: SECRET }, budgetUsd: 50 });
    const order = JSON.parse(R.order_open!.raw) as Record<string, unknown>;
    // No position; a resting TUG buy of 0.03 ETH ($72 at 2400); a new buy of 0.02 ($48) would make $120 > $100.
    const resting = { ...order, ClientOrderID: "tug-v1-cabc-1-ETH-USD-0", Side: "buy", Size: "0.03", Filled: "0" };
    const io = answerWith((_m, url) => (url.includes("/v2/openOrders") ? { status: 200, raw: JSON.stringify({ count: 1, orders: [resting] }) } : { status: 200, raw: '{"count":0,"positions":[]}' }));
    try {
      expect(await t.withinBudget({ symbol: "ETH-USD", side: "buy", price: "2400", size: "0.02" })).toBe(false);
      expect(await t.withinBudget({ symbol: "ETH-USD", side: "buy", price: "2400", size: "0.01" })).toBe(true);
    } finally {
      io.restore();
    }
  });

  it("a connection whose wallet never signed ends after 15 minutes with its key deleted", async () => {
    const { db, c } = connect();
    const io = answerWith((_m, _u, body) => signatureReply(String(body?.public_key)));
    await c.start({ network: "testnet", chain: "cardano", address: ADDRESS }).finally(() => io.restore());
    const runner = new ConnectRunner(db, rules, { kek: KEK, strikeUrl: TESTNET, feeBps: 1, stateDir: "/nonexistent", killFile: "/nonexistent/kill" });
    expect(runner.expireSigning(Date.now() + 14 * 60_000)).toBe(0);
    expect(runner.expireSigning(Date.now() + 16 * 60_000)).toBe(1);
    expect(db.prepare("SELECT status, enc_privkey FROM connections").get()).toEqual({ status: "failed", enc_privkey: null });
  });

  it("trader.stop() resolves only after a tick that was already running has finished", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "cabc", { trading: true, killFile: "/nonexistent/kill" });
    const t = new Trader(db, ex, rules, { network: "cabc", markets: rules.testnet_markets, tradingOn: () => true, pausedFile: "/nonexistent/p", keyFile: { hex: SECRET } });
    let finish!: () => void;
    let tickDone = false;
    void t.track(new Promise<void>((res) => (finish = res)).then(() => (tickDone = true)));
    const stopped = t.stop().then(() => tickDone);
    await new Promise((r) => setTimeout(r, 20));
    finish();
    expect(await stopped).toBe(true);
  });

  it("mainnet connections are refused until opened; once open they use Strike mainnet and the mainnet builder code, with a $1,000 budget cap", async () => {
    const { c } = connect();
    await expect(c.start({ network: "mainnet", chain: "cardano", address: ADDRESS })).rejects.toThrow(/testnet only/);
    expect(c.networks()).toEqual({ testnet: true, mainnet: false });
    const db = openDb(":memory:");
    const open = new Connect(db, { kek: KEK, code: "tug", feeBps: 1, strikeUrl: TESTNET, mainnet: { strikeUrl: "https://api.strikefinance.org", code: "tug-main" } });
    expect(open.networks()).toEqual({ testnet: true, mainnet: true });
    let io = answerWith((_m, _u, body) => signatureReply(String(body?.public_key)));
    const r = await open.start({ network: "mainnet", chain: "cardano", address: "addr1qxeqvvzmklh7vh90hmsq7kgqgrpqs0xwladsh33evwhz6gu9fz7pzym2ye4sm4tggpyr9m3r4lxal5fgvgstvm2y5qkq4gkcaw" }).finally(() => io.restore());
    expect(io.sent[0]!.url).toBe("https://api.strikefinance.org/auth/builder/request-signature");
    expect(io.sent[0]!.body).toMatchObject({ code: "tug-main", fee_share_bps: 1 });
    io = answerWith(() => verifiedReply(r.public_key));
    await open.verify({ id: r.id, token: r.token, wallet_signature: "{}".padEnd(20, " ") }).finally(() => io.restore());
    expect(io.sent[0]!.url).toBe("https://api.strikefinance.org/auth/builder/verify-signature");
    expect(() => open.activate({ id: r.id, token: r.token, budget_usd: 1_500, accept_risk: true })).toThrow(/at most \$1,000/);
    expect(open.activate({ id: r.id, token: r.token, budget_usd: 1_000, accept_risk: true })).toEqual({ status: "active", budget_usd: 1_000 });
    expect(open.view(r.id, r.token)).toMatchObject({ network: "mainnet", status: "active" });
  });

  it("every order a connected account sends carries X-Builder-Fee-Bps", async () => {
    const io = answerWith(() => R.order_accepted!);
    try {
      await new StrikeSigned(SECRET, "https://example.invalid", undefined, 1).call("POST", "/v2/order", { symbol: "ETH-USD" });
      await new StrikeSigned(SECRET, "https://example.invalid").call("POST", "/v2/order", { symbol: "ETH-USD" });
    } finally {
      io.restore();
    }
    expect(io.sent[0]!.headers["X-Builder-Fee-Bps"]).toBe("1");
    expect(io.sent[1]!.headers["X-Builder-Fee-Bps"]).toBeUndefined();
  });

  it("the key encryption fails on any changed byte", () => {
    const enc = encryptKey(KEK, SECRET);
    expect(decryptKey(KEK, enc)).toBe(SECRET);
    const b = Buffer.from(enc, "base64");
    b[b.length - 1] = b[b.length - 1]! ^ 1;
    expect(() => decryptKey(KEK, b.toString("base64"))).toThrow();
  });

  it("the API answers each step with a plain error, and not at all before TUG_KEK is set", async () => {
    const off = buildApi(openDb(":memory:"), { network: "mainnet", rulesSha256: "0".repeat(64), rulesVersion: 1, recordStartMs: 0, revision: "t" });
    expect((await off.inject({ method: "POST", url: "/api/v1/connect/start", payload: {} })).statusCode).toBe(503);
    await off.close();
    const { db, c } = connect();
    const on = buildApi(db, { network: "mainnet", rulesSha256: "0".repeat(64), rulesVersion: 1, recordStartMs: 0, revision: "t", connect: c });
    const bad = await on.inject({ method: "POST", url: "/api/v1/connect/start", payload: { network: "devnet", chain: "cardano", address: ADDRESS } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("E-INPUT");
    const closed = await on.inject({ method: "POST", url: "/api/v1/connect/start", payload: { network: "mainnet", chain: "cardano", address: ADDRESS } });
    expect(closed.json()).toMatchObject({ code: "E-CONN", message: "TUG in your account is open on testnet only right now." });
    expect((await on.inject({ url: "/api/v1/connect/networks" })).json()).toEqual({ testnet: true, mainnet: false });
    await on.close();
  });
});
