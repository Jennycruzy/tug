import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountStatusFrom, loadRules } from "@tug/core";
import { parseUserFrame, StrikeSigned } from "@tug/strike";
import { openDb } from "../src/db.js";
import { Executor } from "../src/executor.js";
import { Trader } from "../src/trader.js";

// Real Strike testnet replies from the stored call log (server, time and request in the file).
const R = JSON.parse(readFileSync(new URL("./fixtures/order-path-testnet-2026-10-22.json", import.meta.url), "utf8")).replies as Record<string, { status: number; raw: string }>;
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const { rules } = loadRules("rules/tug-rules-v1.json");

/** Answers each request with the matching real reply and records what was sent. */
function strikeReplies() {
  const sent: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, url, body });
    const r =
      method === "POST" ? R.order_accepted : url.includes("/v2/openOrders") ? R.open_orders_empty : url.includes("symbol=NOPE-USD") ? R.order_not_found : R.order_open;
    return new Response(r!.raw, { status: r!.status });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

describe("rebalance tick (real Strike testnet replies)", () => {
  it("T-EXEC-4 a dropped order is retried once with a new id, recorded, and the next market still gets its order", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "testnet", { trading: true, killFile: "/nonexistent/kill", pollMs: 1 });
    const trader = new Trader(db, ex, rules, { network: "testnet", markets: "all", tradingOn: () => true, pausedFile: "/nonexistent/paused", keyFile: "unused" });
    for (const s of ["NOPE-USD", "ETH-USD"]) ex.setLeverageConfirmedForCheck(s);
    const io = strikeReplies();
    try {
      const want = new Map([
        ["NOPE-USD", { symbol: "NOPE-USD", side: "buy" as const, price: "1.00", size: "1", why: "check" }],
        ["ETH-USD", { symbol: "ETH-USD", side: "buy" as const, price: "2384.50", size: "0.006", why: "check" }],
      ]);
      await trader.reconcileAll(["NOPE-USD", "ETH-USD"], want);
    } finally {
      io.restore();
    }
    const posts = io.sent.filter((s) => s.method === "POST");
    const nope = posts.filter((p) => p.body!.symbol === "NOPE-USD");
    expect(nope).toHaveLength(2);
    expect(nope[0]!.body!.client_order_id).not.toBe(nope[1]!.body!.client_order_id);
    expect(posts.filter((p) => p.body!.symbol === "ETH-USD")).toHaveLength(1);
    for (const p of posts) expect(p.body!.post_only).toBe(true);
    const rows = db.prepare("SELECT symbol, status FROM orders ORDER BY placed_at").all() as Array<{ symbol: string; status: string }>;
    expect(rows.filter((r) => r.symbol === "NOPE-USD").map((r) => r.status)).toEqual(["dropped", "dropped"]);
    expect(rows.find((r) => r.symbol === "ETH-USD")!.status).toBe("open");
    const drops = db.prepare("SELECT COUNT(*) AS n FROM events WHERE code='E-DROPPED'").get() as { n: number };
    expect(drops.n).toBeGreaterThanOrEqual(2);
    // The 404 reads behind each drop are stored, not only the 200s.
    expect((db.prepare("SELECT COUNT(*) AS n FROM strike_calls WHERE status=404").get() as { n: number }).n).toBeGreaterThanOrEqual(10);
  });
});

describe("account status from Strike fills", () => {
  const realFill = JSON.parse(R.order_open!.raw) as { AutoCloseType: string };
  it("a normal fill (auto_close_type empty, as Strike sends it) keeps the account trading", () => {
    expect(realFill.AutoCloseType).toBe("");
    expect(accountStatusFrom([{ auto_close_type: realFill.AutoCloseType }])).toBe("trading");
    expect(accountStatusFrom([])).toBe("trading");
  });
  it("Strike's documented liquidation close types halt the account; transfers do not", () => {
    for (const t of ["liquidation", "adl", "bankrupt"]) expect(accountStatusFrom([{ auto_close_type: "" }, { auto_close_type: t }])).toBe("liquidation");
    for (const t of ["if_transfer", "vault_withdrawal", "slp_transfer"]) expect(accountStatusFrom([{ auto_close_type: t }])).toBe("trading");
  });
});

describe("risk exits log their own reason", () => {
  it("a margin reduce logs E-MARGIN, a stop E-STOP, a manual close E-EXIT; each is read back", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "testnet", { trading: true, killFile: "/nonexistent/kill", pollMs: 1 });
    const real = globalThis.fetch;
    const sent: Array<{ method: string; body: Record<string, unknown> | null }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      sent.push({ method, body: init.body ? JSON.parse(String(init.body)) : null });
      const r = method === "POST" ? R.order_accepted : url.includes("/v2/positions") ? R.positions_one : R.order_open;
      return new Response(r!.raw, { status: r!.status });
    }) as typeof fetch;
    try {
      await ex.riskExit("ETH-USD", "tug-v1-testnet-1-reduce", "margin", "0.010", "E-MARGIN");
      await ex.riskExit("ETH-USD", "tug-v1-testnet-2-stop", "stop");
      await ex.riskExit("ETH-USD", "tug-v1-testnet-3-manual", "cleanup", undefined, "E-EXIT");
    } finally {
      globalThis.fetch = real;
    }
    const codes = (db.prepare("SELECT code FROM events WHERE component='executor' ORDER BY rowid").all() as Array<{ code: string }>).map((r) => r.code);
    expect(codes).toEqual(["E-MARGIN", "E-STOP", "E-EXIT"]);
    const posts = sent.filter((s) => s.method === "POST").map((s) => s.body!);
    expect(posts[0]).toMatchObject({ type: "market", reduce_only: true, size: "0.010" });
    expect(posts[0]!.close_position).toBeUndefined();
    expect(posts[1]).toMatchObject({ type: "market", reduce_only: true, close_position: true });
    const rows = (db.prepare("SELECT status FROM orders ORDER BY placed_at").all() as Array<{ status: string }>).map((r) => r.status);
    expect(rows.every((s) => s !== "pending" && s !== "sent")).toBe(true);
  });
});

// Real Strike testnet replies for the leverage step (BTC-USD 20x → 5x, read back, and a refused value).
const L = JSON.parse(readFileSync(new URL("./fixtures/leverage-testnet-2026-10-23.json", import.meta.url), "utf8")).replies as Record<string, { status: number; raw: string }>;

/** Serves /v2/symbols from `symbols` in turn (the last one repeats), POST /v2/leverage and orders from real replies. */
function leverageReplies(symbols: string[], leverage = "leverage_set") {
  const sent: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  const real = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, url, body });
    const r = url.includes("/v2/symbols")
      ? L[symbols[Math.min(reads++, symbols.length - 1)]!]
      : url.includes("/v2/leverage")
        ? L[leverage]
        : method === "POST"
          ? R.order_accepted
          : url.includes("/v2/openOrders")
            ? R.open_orders_empty
            : R.order_open;
    return new Response(r!.raw, { status: r!.status });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

describe("leverage is set and read back before TUG trades a market", () => {
  const exFor = (network = "testnet", trading = true) => {
    const db = openDb(":memory:");
    return { db, ex: new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), network, { trading, killFile: "/nonexistent/kill", pollMs: 1 }) };
  };

  it("a market at 20x is set to the rules' 5x cross and confirmed from /v2/symbols", async () => {
    const { db, ex } = exFor();
    const io = leverageReplies(["symbols_before", "symbols_after"]);
    let r;
    try {
      r = await ex.ensureLeverage("BTC-USD", rules.leverage_setting, rules.margin_mode);
    } finally {
      io.restore();
    }
    expect(rules.leverage_setting).toBe(5);
    expect(r).toEqual({ symbol: "BTC-USD", before: { margin_mode: "cross", leverage: 20 }, after: { margin_mode: "cross", leverage: 5 } });
    expect(io.sent.filter((s) => s.method === "POST").map((s) => s.body)).toEqual([{ symbol: "BTC-USD", leverage: 5 }]);
    expect(ex.leverageConfirmed("BTC-USD")).toBe(true);
    expect((db.prepare("SELECT message FROM events WHERE component='executor'").get() as { message: string }).message).toBe("leverage BTC-USD 5x cross");
  });

  it("a market already at 5x cross is only read; a market with no setting reads the account default", async () => {
    const { ex } = exFor();
    const io = leverageReplies(["symbols_after"]);
    try {
      await ex.ensureLeverage("ETH-USD", 5, "cross");
      await expect(ex.ensureLeverage("XRP-USD", 5, "cross")).rejects.toMatchObject({ code: "E-LEVERAGE" });
    } finally {
      io.restore();
    }
    // ETH-USD: read only. XRP-USD (no setting, default 10x): asked once, still reads 10x, so it is refused.
    expect(io.sent.filter((s) => s.method === "POST").map((s) => s.body)).toEqual([{ symbol: "XRP-USD", leverage: 5 }]);
    expect(ex.leverageConfirmed("ETH-USD")).toBe(true);
    expect(ex.leverageConfirmed("XRP-USD")).toBe(false);
  });

  it("a refused leverage request places no order on that market", async () => {
    const { db, ex } = exFor();
    const trader = new Trader(db, ex, rules, { network: "testnet", markets: "all", tradingOn: () => true, pausedFile: "/nonexistent/paused", keyFile: "unused" });
    const io = leverageReplies(["symbols_before"], "leverage_bad");
    try {
      await trader.reconcileAll(["BTC-USD"], new Map([["BTC-USD", { symbol: "BTC-USD", side: "buy" as const, price: "100000", size: "0.001", why: "check" }]]));
    } finally {
      io.restore();
    }
    expect(io.sent.filter((s) => s.url.includes("/v2/order") && s.method === "POST")).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM strike_calls WHERE path='/v2/leverage' AND status=400").get() as { n: number }).n).toBe(1);
  });

  it("the order goes out only after the leverage read-back", async () => {
    const { db, ex } = exFor();
    const trader = new Trader(db, ex, rules, { network: "testnet", markets: "all", tradingOn: () => true, pausedFile: "/nonexistent/paused", keyFile: "unused" });
    const io = leverageReplies(["symbols_before", "symbols_after"]);
    try {
      await trader.reconcileAll(["BTC-USD"], new Map([["BTC-USD", { symbol: "BTC-USD", side: "buy" as const, price: "100000", size: "0.001", why: "check" }]]));
    } finally {
      io.restore();
    }
    const order = io.sent.findIndex((s) => s.method === "POST" && /\/v2\/order$/.test(s.url));
    const readBack = io.sent.map((s, i) => (s.url.includes("/v2/symbols") ? i : -1)).filter((i) => i >= 0);
    expect(order).toBeGreaterThan(0);
    expect(readBack.length).toBe(2);
    expect(readBack[1]!).toBeLessThan(order);
    expect(io.sent[order]!.body).toMatchObject({ symbol: "BTC-USD", post_only: true });
  });

  it("with trading off on mainnet nothing is sent", async () => {
    const { ex } = exFor("mainnet", false);
    const io = leverageReplies(["symbols_before"]);
    try {
      await expect(ex.ensureLeverage("BTC-USD", 5, "cross")).rejects.toMatchObject({ code: "E-TRADING-OFF" });
    } finally {
      io.restore();
    }
    expect(io.sent).toHaveLength(0);
  });
});

// Real Strike mainnet replies (23 Oct): a post-only buy accepted as pending, refused on the user stream, 404 over REST.
const M = JSON.parse(readFileSync(new URL("./fixtures/order-rejected-mainnet-2026-10-23.json", import.meta.url), "utf8")) as {
  replies: Record<string, { status: number; raw: string; body?: Record<string, string> }>;
  stream: { order_rejected: { raw: string } };
};

describe("a refusal seen only on the user stream (mainnet)", () => {
  it("is returned as rejected with Strike's reason, not logged as a dropped order", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "mainnet", { trading: true, killFile: "/nonexistent/kill", pollMs: 5 });
    const body = M.replies.order_pending!.body!;
    const real = globalThis.fetch;
    const sent: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      sent.push(method);
      const r = method === "POST" ? M.replies.order_pending! : M.replies.order_not_found!;
      if (method === "POST") {
        // Strike's stream frame arrives about 40 ms after the order is sent.
        const f = parseUserFrame(JSON.parse(M.stream.order_rejected.raw));
        setTimeout(() => {
          if (f.kind === "order") ex.noteStreamOrder(f.order.c, f.order.X, String((f.order as { cr?: string }).cr ?? ""), f.order.i);
        }, 40);
      }
      return new Response(r.raw, { status: r.status });
    }) as typeof fetch;
    let order;
    try {
      order = await ex.placePostOnly({ symbol: body.symbol!, side: body.side as "buy", price: body.price!, size: body.size!, clientOrderId: body.client_order_id!, reason: "check" });
    } finally {
      globalThis.fetch = real;
    }
    expect(order.Status).toBe("rejected");
    expect((order as { CloseReason?: string }).CloseReason).toBe("order_would_match_immediately");
    expect((db.prepare("SELECT status FROM orders").get() as { status: string }).status).toBe("rejected");
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE code='E-DROPPED'").get() as { n: number }).n).toBe(0);
    expect(sent.filter((m) => m === "POST")).toHaveLength(1);
  });

  it("an order with no REST record and no stream update is still reported as dropped", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "mainnet", { trading: true, killFile: "/nonexistent/kill", pollMs: 1 });
    const body = M.replies.order_pending!.body!;
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const r = (init.method ?? "GET") === "POST" ? M.replies.order_pending! : M.replies.order_not_found!;
      return new Response(r.raw, { status: r.status });
    }) as typeof fetch;
    try {
      await expect(ex.placePostOnly({ symbol: body.symbol!, side: "buy", price: body.price!, size: body.size!, clientOrderId: body.client_order_id!, reason: "check" })).rejects.toMatchObject({ code: "E-DROPPED" });
    } finally {
      globalThis.fetch = real;
    }
  });
});

// Real Strike mainnet replies (23 Oct, DRAM-USD): a post-only sell that filled within a second; REST answered 404.
const F = JSON.parse(readFileSync(new URL("./fixtures/order-filled-at-once-mainnet-2026-10-23.json", import.meta.url), "utf8")) as {
  replies: Record<string, { status: number; raw: string; body?: Record<string, string> }>;
  stream: Array<{ raw: string }>;
};

describe("an order that fills at once (mainnet)", () => {
  it("is confirmed as filled from the user stream and never retried", async () => {
    const db = openDb(":memory:");
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "mainnet", { trading: true, killFile: "/nonexistent/kill", pollMs: 5 });
    const body = F.replies.order_pending!.body!;
    const real = globalThis.fetch;
    const posts: unknown[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      if (method === "POST") {
        posts.push(init.body);
        // Strike's OPEN and FILLED frames arrive within a second of the order, in this order.
        F.stream.forEach((fr, k) => {
          const f = parseUserFrame(JSON.parse(fr.raw));
          setTimeout(() => {
            if (f.kind === "order") ex.noteStreamOrder(f.order.c, f.order.X, String((f.order as { cr?: string }).cr ?? ""), f.order.i);
          }, 2 + k);
        });
      }
      const r = method === "POST" ? F.replies.order_pending! : F.replies.order_not_found!;
      return new Response(r.raw, { status: r.status });
    }) as typeof fetch;
    let order;
    try {
      order = await ex.placePostOnly({ symbol: body.symbol!, side: body.side as "sell", price: body.price!, size: body.size!, clientOrderId: body.client_order_id!, reason: "check" });
    } finally {
      globalThis.fetch = real;
    }
    expect(F.stream.map((s) => JSON.parse(s.raw).data.X)).toEqual(["OPEN", "FILLED", "FILLED"]);
    expect(order.Status).toBe("filled");
    expect((db.prepare("SELECT status FROM orders").get() as { status: string }).status).toBe("filled");
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE code='E-DROPPED'").get() as { n: number }).n).toBe(0);
    expect(posts).toHaveLength(1);
  });
});
