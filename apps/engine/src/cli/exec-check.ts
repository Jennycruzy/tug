// Testnet only. Runs TUG's execution rules against Strike testnet with real orders and stores every reply:
//   T-EXEC-1 every order the executor sends is post-only (checked over every stored testnet order request)
//   T-EXEC-2 a post-only order that would take is re-quoted one tick away
//   T-EXEC-3 a resting order no longer at the best price is replaced at the next reprice
//   T-EXEC-4 an order Strike accepts but never places (201, then 404 on read) is recorded as E-DROPPED
// `pnpm exec:check`; exits 1 if any check fails. Cancels its own orders at the end.
import { join } from "node:path";
import { loadRules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { KILL_FILE, NETWORK, RULES_FILE, STATE_DIR } from "../config.js";
import { openDb } from "../db.js";
import { Executor } from "../executor.js";
import { DB_FILE } from "../config.js";
import { Trader } from "../trader.js";
import { callsSince, saveRun } from "./shared.js";

if (NETWORK !== "testnet") throw new Error("exec:check runs on testnet only.");
const started = Date.now();
const { rules } = loadRules(RULES_FILE);
const db = openDb(DB_FILE);
const keyFile = process.env.TUG_ACCOUNT_KEY_FILE!;
const ex = new Executor(db, StrikeSigned.fromFile(keyFile), NETWORK, { trading: true, killFile: KILL_FILE });
const trader = new Trader(db, ex, rules, { network: NETWORK, markets: ["ETH-USD"], tradingOn: () => true, pausedFile: join(STATE_DIR, `PAUSED-${NETWORK}`), keyFile });
await trader.readMarkets();
const results: Record<string, { pass: boolean; evidence: unknown }> = {};
const S = "ETH-USD";
const book = (await import("@tug/strike")).bookTickers;
const tickOf = async () => (await (await import("@tug/strike")).markets()).markets[S]!.order_tick_price!;

// T-EXEC-2: a post-only buy at the best ask would take; Strike cancels it, TUG re-quotes one tick lower.
{
  const b = (await book())[S]!;
  const tick = Number(await tickOf());
  const d = String(await tickOf()).split(".")[1]?.length ?? 0;
  const before = Date.now();
  await trader.placeWithRequote({ symbol: S, side: "buy", price: b.ask.toFixed(d), size: "0.006", why: "exec check: post-only at the ask" }, 0);
  const rows = db.prepare("SELECT client_order_id, price, status FROM orders WHERE network=? AND placed_at>=? ORDER BY placed_at").all(NETWORK, before) as Array<{ client_order_id: string; price: string; status: string }>;
  const first = rows[0];
  const second = rows[1];
  results["T-EXEC-2"] = {
    pass: Boolean(first && second && first.status === "rejected" && Math.abs(Number(second.price) - (Number(first.price) - tick)) < tick / 2),
    evidence: { ask: b.ask, bid: b.bid, orders: rows },
  };
}

const clear = async () => {
  for (const o of (await ex.openOrders(S)).filter((x) => x.ClientOrderID.startsWith("tug-v1-testnet-"))) await ex.cancel(S, o.ClientOrderID);
  await new Promise((r) => setTimeout(r, 2_000));
};
await clear();

// T-EXEC-3: move away from the best bid, then one reprice tick puts TUG back at the best bid.
{
  await trader.readMarkets();
  const before = Date.now();
  await trader.tradeTickForCheck(S, "buy", "0.006");
  const rows = db.prepare("SELECT client_order_id, price, status FROM orders WHERE network=? AND placed_at>=? ORDER BY placed_at").all(NETWORK, before) as Array<{ client_order_id: string; price: string; status: string }>;
  const b = (await book())[S]!;
  results["T-EXEC-3"] = { pass: rows.length >= 2 && rows[0]!.status === "canceled" && Number(rows[rows.length - 1]!.price) === b.bid, evidence: { bid: b.bid, orders: rows } };
}

// T-EXEC-4: an unknown market is accepted (201 pending) and then never exists (404): E-DROPPED.
{
  const ex4 = new Executor(db, StrikeSigned.fromFile(keyFile), NETWORK, { trading: true, killFile: KILL_FILE, pollMs: 1_000 });
  let code = "";
  try {
    await ex4.placePostOnly({ symbol: "NOPE-USD", side: "buy", price: "1.00", size: "1", clientOrderId: `tug-v1-testnet-check-drop-${Date.now()}`, reason: "exec check: silent drop" });
  } catch (e) {
    code = (e as { code?: string }).code ?? "";
  }
  results["T-EXEC-4"] = { pass: code === "E-DROPPED", evidence: { code } };
}

// Clean up: cancel this run's resting orders.
const mine = (await ex.openOrders(S)).filter((o) => o.ClientOrderID.startsWith("tug-v1-testnet-"));
for (const o of mine) await ex.cancel(S, o.ClientOrderID);

// T-EXEC-1: every order request the executor ever sent on testnet was post-only, except labelled risk exits.
{
  const sent = db.prepare("SELECT body FROM strike_calls WHERE network=? AND method='POST' AND path='/v2/order'").all(NETWORK) as Array<{ body: string }>;
  const tug = sent.map((r) => JSON.parse(r.body) as { post_only?: boolean; reduce_only?: boolean; client_order_id?: string }).filter((b) => b.client_order_id?.startsWith("tug-"));
  const bad = tug.filter((b) => b.post_only !== true && b.reduce_only !== true);
  results["T-EXEC-1"] = { pass: tug.length > 0 && bad.length === 0, evidence: { tug_orders: tug.length, not_post_only: bad } };
}

const ok = Object.values(results).every((r) => r.pass);
const file = saveRun("exec-check", { network: NETWORK, label: "TESTNET", results, calls: callsSince(db, started) });
console.log(JSON.stringify({ ok, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.pass])), file }, null, 1));
process.exitCode = ok ? 0 : 1;
process.exit();
