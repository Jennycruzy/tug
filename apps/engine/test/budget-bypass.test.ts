import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { Connect } from "../src/connect.js";
import { openDb } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { Trader } from "../src/trader.js";

// Attempts to push a connected account past its budget. Each must fail. Replies are built from Strike's real
// testnet shapes (positions and open orders from the stored order path), with the sizes each attack needs.
const { rules } = loadRules("rules/tug-rules-v1.json");
const R = JSON.parse(readFileSync(new URL("./fixtures/order-path-testnet-2026-10-22.json", import.meta.url), "utf8")).replies as Record<string, { status: number; raw: string }>;
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const POSITION = (JSON.parse(R.positions_one!.raw) as { positions: Array<Record<string, unknown>> }).positions[0]!;
const ORDER = JSON.parse(R.order_open!.raw) as Record<string, unknown>;
const NET = "cbadbeef";
const BUDGET = 50; // limit: 50 × gross cap 2 = $100
const PRICE = 2000;

/** An account with these positions and these resting orders (on ETH-USD unless a symbol is given); TUG may trade ETH-USD and BTC-USD. */
function account(positions: Array<{ symbol: string; size: number }>, resting: Array<{ side: "buy" | "sell"; size: number; mine?: boolean; symbol?: string }> = []) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.includes("/v2/openOrders")) {
      const sym = new URL(url).searchParams.get("symbol");
      const orders = resting
        .filter((o) => (o.symbol ?? "ETH-USD") === sym)
        .map((o, i) => ({ ...ORDER, Symbol: sym, Price: String(PRICE), ClientOrderID: o.mine === false ? `someone-${i}` : `tug-v1-${NET}-${i}-${sym}-0`, Side: o.side, Size: String(o.size), Filled: "0" }));
      return new Response(JSON.stringify({ count: orders.length, orders }), { status: 200 });
    }
    const list = positions.map((p) => ({ ...POSITION, symbol: p.symbol, size: String(p.size) }));
    return new Response(JSON.stringify({ count: list.length, positions: list }), { status: 200 });
  }) as typeof fetch;
  const db = openDb(":memory:");
  const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), NET, { trading: true, killFile: "/nonexistent/kill" });
  const t = new Trader(db, ex, rules, { network: NET, markets: ["ETH-USD", "BTC-USD"], tradingOn: () => true, pausedFile: "/nonexistent/p", keyFile: { hex: SECRET }, budgetUsd: BUDGET });
  return { t, db, restore: () => (globalThis.fetch = real) };
}
const order = (side: "buy" | "sell", usd: number) => ({ symbol: "ETH-USD", side, price: String(PRICE), size: (usd / PRICE).toFixed(4) });

describe("budget bypass attempts (each must fail)", () => {
  it("many small orders: each looks small, but resting TUG orders add up and the one that crosses the limit is refused", async () => {
    // $90 already resting in nine $10 buys; a tenth and an eleventh $10 buy.
    const a = account([], Array.from({ length: 9 }, () => ({ side: "buy" as const, size: 10 / PRICE })));
    try {
      expect(await a.t.withinBudget(order("buy", 10))).toBe(true); // $100: at the limit
      expect(await a.t.withinBudget(order("buy", 10.5))).toBe(false); // $100.50: past it
    } finally {
      a.restore();
    }
  });

  it("exposure parked in another market counts: a $90 BTC position leaves room for $10 of ETH, not more", async () => {
    const a = account([{ symbol: "BTC-USD", size: 90 / PRICE }]);
    try {
      expect(await a.t.withinBudget(order("buy", 10))).toBe(true);
      expect(await a.t.withinBudget(order("buy", 20))).toBe(false);
    } finally {
      a.restore();
    }
  });

  it("an opposite resting order does not make room: long $90 with a $90 sell waiting, a $60 buy is refused", async () => {
    const a = account([{ symbol: "ETH-USD", size: 90 / PRICE }], [{ side: "sell", size: 90 / PRICE }]);
    try {
      expect(await a.t.withinBudget(order("buy", 60))).toBe(false);
    } finally {
      a.restore();
    }
  });

  it("flipping sides in one order is measured on the new side: short $40, buy $180 (long $140) is refused", async () => {
    const a = account([{ symbol: "ETH-USD", size: -40 / PRICE }]);
    try {
      expect(await a.t.withinBudget(order("buy", 180))).toBe(false);
      expect(await a.t.withinBudget(order("buy", 40))).toBe(true); // closing only: always allowed
    } finally {
      a.restore();
    }
  });

  it("resting orders that are not TUG's are not TUG's to count, and do not let TUG past the limit either", async () => {
    const a = account([{ symbol: "ETH-USD", size: 95 / PRICE }], [{ side: "sell", size: 95 / PRICE, mine: false }]);
    try {
      expect(await a.t.withinBudget(order("buy", 10))).toBe(false);
    } finally {
      a.restore();
    }
  });

  it("a TUG order waiting in another market counts: a $90 BTC buy waiting, then a $90 ETH buy is refused (the reviewer's probe)", async () => {
    const a = account([], [{ symbol: "BTC-USD", side: "buy", size: 90 / PRICE }]);
    try {
      expect(await a.t.withinBudget(order("buy", 90))).toBe(false);
      expect(await a.t.withinBudget(order("buy", 10))).toBe(true); // $90 + $10 = $100: at the limit
      expect(await a.t.withinBudget({ symbol: "BTC-USD", side: "buy", price: String(PRICE), size: (20 / PRICE).toFixed(4) })).toBe(false);
    } finally {
      a.restore();
    }
  });

  it("targets never exceed the budget, however large the account is", () => {
    const a = account([]);
    a.restore();
    expect(a.t.sizingEquity(1_000_000)).toBe(BUDGET);
  });

  it("every refusal is logged with E-BUDGET and the numbers", async () => {
    const a = account([{ symbol: "BTC-USD", size: 99 / PRICE }]);
    try {
      await a.t.withinBudget(order("buy", 20));
    } finally {
      a.restore();
    }
    const row = a.db.prepare("SELECT code, data_json FROM events WHERE code='E-BUDGET'").get() as { code: string; data_json: string };
    expect(JSON.parse(row.data_json)).toMatchObject({ limit: 100, budget: BUDGET });
  });
});

describe("budget changes outside the rules (each must fail)", () => {
  const KEK = Buffer.alloc(32, 7);
  async function active(c: Connect, network: "testnet" | "mainnet") {
    const r = await verified(c, network);
    c.activate({ id: r.id, token: r.token, budget_usd: 50, accept_risk: true });
    return r;
  }
  async function verified(c: Connect, network: "testnet" | "mainnet") {
    const real = globalThis.fetch;
    let pub = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (url.endsWith("/request-signature")) {
        pub = String(body.public_key);
        return new Response(JSON.stringify({ nonce: "0192f0c1-7b8e-7c3a-9d61-2f1e4b5a6c7d", message_to_sign: "m" }), { status: 200 });
      }
      return new Response(JSON.stringify({ account_id: "01a144dc-27e4-706c-ac46-9c2c1e77d60b", fee_share_bps: 1, api_wallet_public_key: pub }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await c.start({ network, chain: "solana", address: "Ee16BW5P6zYLfvKFXiTPVqhtWH5UuHqB9JX1DDjNRt6w" });
      await c.verify({ id: r.id, token: r.token, wallet_signature: "x".repeat(20) });
      return r;
    } finally {
      globalThis.fetch = real;
    }
  }

  it("a running connection's budget cannot be raised, and a stopped one cannot be started again", async () => {
    const c = new Connect(openDb(":memory:"), { kek: KEK, code: "tug", feeBps: 1, strikeUrl: "https://example.invalid" });
    const r = await active(c, "testnet");
    expect(() => c.activate({ id: r.id, token: r.token, budget_usd: 5_000, accept_risk: true })).toThrow(/Connect a wallet first/);
    c.stop({ id: r.id, token: r.token, close_positions: false });
    expect(() => c.activate({ id: r.id, token: r.token, budget_usd: 50, accept_risk: true })).toThrow();
  });

  it("another connection's token controls nothing", async () => {
    const c = new Connect(openDb(":memory:"), { kek: KEK, code: "tug", feeBps: 1, strikeUrl: "https://example.invalid", mainnet: { strikeUrl: "https://example.invalid", code: "tug" } });
    const a = await active(c, "testnet");
    const b = await active(c, "mainnet");
    expect(() => c.stop({ id: a.id, token: b.token, close_positions: false })).toThrow(/could not be verified/);
    expect(c.view(b.id, b.token)).toMatchObject({ network: "mainnet", budget_usd: 50 });
  });

  it("on a fresh verified connection, nonsense budgets and a missing risk acknowledgement are refused, and a good budget then starts it", async () => {
    const c = new Connect(openDb(":memory:"), { kek: KEK, code: "tug", feeBps: 1, strikeUrl: "https://example.invalid", mainnet: { strikeUrl: "https://example.invalid", code: "tug" } });
    for (const network of ["testnet", "mainnet"] as const) {
      const r = await verified(c, network);
      const bad = [-1, 0, 9.99, Number.NaN, Number.POSITIVE_INFINITY, 1e12, "50", 10_001, ...(network === "mainnet" ? [1_001] : [])];
      for (const budget of bad) expect(() => c.activate({ id: r.id, token: r.token, budget_usd: budget, accept_risk: true }), `${network} ${String(budget)}`).toThrow();
      expect(() => c.activate({ id: r.id, token: r.token, budget_usd: 50, accept_risk: false })).toThrow();
      expect(c.view(r.id, r.token).status).toBe("verified");
      expect(c.activate({ id: r.id, token: r.token, budget_usd: 50, accept_risk: true })).toEqual({ status: "active", budget_usd: 50 });
    }
  });
});
