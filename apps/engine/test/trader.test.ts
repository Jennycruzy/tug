import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountStatusFrom, loadRules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
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
