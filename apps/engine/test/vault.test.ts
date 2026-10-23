import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { buildApi } from "../src/api.js";
import { Executor } from "../src/executor.js";
import { Trader } from "../src/trader.js";
import { OPENAPI } from "../src/openapi.js";
import { fixtureDb } from "./fixture-db.js";
import { check } from "./schema-check.js";

// Real public replies for the TUG testnet vault: after the second testnet account deposited 50 and asked to
// withdraw 10 shares (23 Oct, server and time in the file).
const VF = JSON.parse(readFileSync(new URL("./fixtures/vault-testnet-2026-10-23.json", import.meta.url), "utf8")) as {
  vault: { status: number; raw: string };
  history: { status: number; raw: string };
};
// Real replies of the order path (testnet), reused for the vault: Strike answers vault orders with the same shapes.
const R = JSON.parse(readFileSync(new URL("./fixtures/order-path-testnet-2026-10-22.json", import.meta.url), "utf8")).replies as Record<string, { status: number; raw: string }>;
const VAULT = "d7e255eb-509f-5cd7-8e15-ab95ef639c3f";
const LEADER = "01a163bf-fb0a-77b0-86c0-03a62889ee01";
const SECRET = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const { rules } = loadRules("rules/tug-rules-v1.json");
const root = OPENAPI as unknown as { components: { schemas: Record<string, Record<string, unknown>> }; paths: Record<string, Record<string, { responses: Record<string, { content: { "application/json": { schema: Record<string, unknown> } } }> }>> };
const schemaOf = (path: string) => root.paths[path]!.get!.responses["200"]!.content["application/json"].schema;
const ctx = { network: "mainnet", rulesSha256: "0".repeat(64), rulesVersion: 1, recordStartMs: 0, revision: "test" };

/** Answers with the given replies by URL and records every request. */
function stub(answer: (method: string, url: string) => { status: number; raw: string }) {
  const sent: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, url, body });
    const r = answer(method, url);
    return new Response(r.raw, { status: r.status });
  }) as typeof fetch;
  return { sent, restore: () => (globalThis.fetch = real) };
}

const vaultReplies = (history = VF.history.raw) => (_m: string, url: string) =>
  url.includes(`/v2/vault/${VAULT}/history`) ? { status: 200, raw: history } : { status: 200, raw: VF.vault.raw };

function vaultTrader() {
  const db = fixtureDb();
  const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "vault", { trading: true, killFile: "/nonexistent/kill", pollMs: 1, vaultId: VAULT });
  const trader = new Trader(db, ex, rules, { network: "vault", markets: rules.testnet_markets, tradingOn: () => true, pausedFile: "/nonexistent/paused", keyFile: "unused", vaultId: VAULT });
  return { db, ex, trader };
}

describe("the executor on a vault (Strike's vault-leader rules)", () => {
  it("every write carries vault_id in the body and every read carries it as a query parameter", async () => {
    const { ex } = vaultTrader();
    ex.setLeverageConfirmedForCheck("ETH-USD");
    const io = stub((method, url) => (method === "POST" ? R.order_accepted! : url.includes("/v2/positions") ? R.positions_one! : R.order_open!));
    try {
      await ex.placePostOnly({ symbol: "ETH-USD", side: "buy", price: "2384.50", size: "0.006", clientOrderId: "tug-v1-vault-1-ETH-USD-0", reason: "check" });
      await ex.positions();
    } finally {
      io.restore();
    }
    const post = io.sent.find((s) => s.method === "POST")!;
    expect(post.body).toMatchObject({ symbol: "ETH-USD", post_only: true, vault_id: VAULT });
    const reads = io.sent.filter((s) => s.method === "GET");
    expect(reads.length).toBeGreaterThan(1);
    for (const r of reads) expect(new URL(r.url).searchParams.get("vault_id")).toBe(VAULT);
  });

  it("an account without a vault sends no vault_id", async () => {
    const db = fixtureDb();
    const ex = new Executor(db, new StrikeSigned(SECRET, "https://example.invalid"), "testnet", { trading: true, killFile: "/nonexistent/kill", pollMs: 1 });
    const io = stub(() => ({ status: 200, raw: '{"count":0,"positions":[]}' }));
    try {
      await ex.positions();
    } finally {
      io.restore();
    }
    expect(io.sent[0]!.url).not.toContain("vault_id");
  });
});

describe("the vault record (real testnet vault replies)", () => {
  it("stores Strike's share price and every deposit and withdrawal, and serves them labelled TESTNET", async () => {
    const { db, trader } = vaultTrader();
    const io = stub(vaultReplies());
    try {
      await trader.syncMoney();
    } finally {
      io.restore();
    }
    // Only Strike's public vault reads, no signed call.
    expect(io.sent.every((s) => s.method === "GET" && s.url.includes(`/v2/vault/${VAULT}`))).toBe(true);
    const app = buildApi(db, ctx);
    const r = await app.inject({ url: "/api/v1/record" });
    expect(check(r.json(), schemaOf("/api/v1/record"), root)).toEqual([]);
    const v = r.json().vault;
    expect(v.label).toBe("TESTNET");
    expect(v.vault_id).toBe(VAULT);
    expect(v.equity).toBe(260);
    expect(v.total_shares).toBe(260);
    expect(v.share_price).toBe(1);
    expect(v.lockup_days).toBe(1);
    expect(v.moves.map((m: { type: string; who: string; status: string; usd: number }) => [m.type, m.who, m.status, m.usd])).toEqual([
      ["withdrawal", "depositor", "pending", 10],
      ["deposit", "depositor", "completed", 50],
      ["deposit", "leader", "completed", 10],
      ["deposit", "leader", "completed", 200],
    ]);
    const wd = v.moves[0];
    expect(wd.shares).toBe(10);
    expect(wd.execute_at - wd.at).toBe(24 * 3600_000);
    expect(v.links.strike_vault_page).toBe(`https://testnet.strikefinance.org/vaults/${VAULT}`);
    expect(v.links.strike_fills).toContain(`vault_id=${VAULT}`);
    // The leader's own account id is never shown; depositors are shortened.
    expect(JSON.stringify(v.moves)).not.toContain(LEADER);
    await app.close();
  });

  it("a withdrawal's status follows Strike's: the pending row becomes completed, it is not added twice", async () => {
    const { db, trader } = vaultTrader();
    // Strike's history after the lockup, built from the real reply: the same row marked completed with its payout.
    const later = JSON.parse(VF.history.raw) as { history: Array<Record<string, unknown>> };
    Object.assign(later.history[0]!, { status: "completed", actual_usd: "9.95", execution_share_price: "0.995", executed_timestamp: Number(later.history[0]!.execute_at_timestamp) + 1_000 });
    for (const h of [VF.history.raw, JSON.stringify(later)]) {
      const io = stub(vaultReplies(h));
      try {
        await trader.syncMoney();
      } finally {
        io.restore();
      }
    }
    const rows = db.prepare("SELECT status, usd, executed_at FROM vault_moves WHERE type='withdrawal'").all() as Array<{ status: string; usd: number; executed_at: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "completed", usd: 9.95 });
    expect(rows[0]!.executed_at).toBeGreaterThan(0);
  });

  it("the vault's stop is on the share price: a payout lowers the start with the shares, so it never reads as a loss", async () => {
    const { db, trader } = vaultTrader();
    const io = stub(vaultReplies());
    try {
      await trader.syncMoney();
    } finally {
      io.restore();
    }
    const start = (trader as unknown as { startEquity(e: number): number }).startEquity.bind(trader);
    expect(start(260)).toBe(260);
    // After a payout of 100 shares at the same price, equity and shares both fall: the start falls with them.
    db.prepare("INSERT INTO vault_points (vault_id, ts, share_price, equity, total_shares, raw) VALUES (?,?,?,?,?,?)").run(VAULT, Date.now() + 60_000, 1, 160, 160, VF.vault.raw);
    expect(start(160)).toBe(160);
  });

  it("no vault data: the record's vault is null", async () => {
    const app = buildApi(fixtureDb(), ctx);
    const r = await app.inject({ url: "/api/v1/record" });
    expect(r.json().vault).toBeNull();
    expect(check(r.json(), schemaOf("/api/v1/record"), root)).toEqual([]);
    await app.close();
  });

  it("vault fills are served with network=vault and link to Strike's vault fills", async () => {
    const { db, trader } = vaultTrader();
    const io = stub(vaultReplies());
    try {
      await trader.syncMoney();
    } finally {
      io.restore();
    }
    const app = buildApi(db, ctx);
    const r = await app.inject({ url: "/api/v1/record/fills?network=vault" });
    expect(r.statusCode).toBe(200);
    expect(check(r.json(), schemaOf("/api/v1/record/fills"), root)).toEqual([]);
    expect(r.json().strike_fills).toBe(`https://api-v2-testnet.strikefinance.org/v2/history/fill?vault_id=${VAULT}`);
    await app.close();
  });
});
