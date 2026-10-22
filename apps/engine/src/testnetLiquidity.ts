// Testnet only: Strike's testnet books have few other traders, so TUG's waiting orders rarely fill there.
// This separate test account (keys/testnet-liquidity.key) can quote a small post-only bid and ask ±0.2%
// around the ETH-USD mark, or fill one of TUG's waiting orders by trading against it. Labelled TESTNET;
// disclosed in docs/method.md. It refuses to run on any other network.
//   pnpm liquidity quote          post-only bid and ask ±0.2% around the mark
//   pnpm liquidity take <client_order_id>   fill that waiting TUG order with an IOC order at its price
//   pnpm liquidity cancel         cancel this account's orders
import { toStep } from "@tug/core";
import { markets, StrikeSigned } from "@tug/strike";
import { NETWORK } from "./config.js";
import { saveRun } from "./cli/shared.js";

if (NETWORK !== "testnet" || !process.env.STRIKE_API_URL?.includes("testnet")) {
  throw new Error("The liquidity account exists on Strike testnet only.");
}
const SYMBOL = "ETH-USD";
const keyFile = process.env.TUG_LIQUIDITY_KEY_FILE ?? "/home/tug/tug-private/keys/testnet-liquidity.key";
const leaderKey = process.env.TUG_ACCOUNT_KEY_FILE!;
const liq = StrikeSigned.fromFile(keyFile);
const calls: unknown[] = [];
const call = async (c: StrikeSigned, method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
  const r = await c.call(method, path, body);
  calls.push({ at: new Date(r.at).toISOString(), method, path, body, status: r.status, reply: r.raw.slice(0, 2000) });
  return r;
};

const cmd = process.argv[2];
const m = (await markets()).markets[SYMBOL]!;
const tick = String(m.order_tick_price);
const step = String(m.order_limit_step_size);
if (cmd === "quote") {
  const size = toStep(25 / m.mark_price!, step, "up");
  const bid = toStep(m.mark_price! * 0.998, tick, "down");
  const ask = toStep(m.mark_price! * 1.002, tick, "up");
  const stamp = Date.now();
  for (const [side, price] of [["buy", bid], ["sell", ask]] as const) {
    await call(liq, "POST", "/v2/order", { symbol: SYMBOL, side, type: "limit", price, size, time_in_force: "GTC", post_only: true, client_order_id: `liq-${side}-${stamp}` });
  }
} else if (cmd === "take") {
  const target = process.argv[3]!;
  const leader = StrikeSigned.fromFile(leaderKey);
  const o = (await call(leader, "GET", `/v2/order?symbol=${SYMBOL}&client_order_id=${encodeURIComponent(target)}`)).json as Record<string, string>;
  if (o.Status !== "open" && o.Status !== "partially_filled") throw new Error(`TUG order ${target} is ${o.Status}, not waiting in the book.`);
  const remaining = toStep(Number(o.Size) - Number(o.Filled), step, "down");
  const side = o.Side === "buy" ? "sell" : "buy";
  await call(liq, "POST", "/v2/order", { symbol: SYMBOL, side, type: "limit", price: String(Number(o.Price)), size: remaining, time_in_force: "IOC", client_order_id: `liq-take-${Date.now()}` });
} else if (cmd === "cancel") {
  await call(liq, "DELETE", "/v2/order/cancel-all", { symbol: SYMBOL });
} else {
  throw new Error("usage: liquidity quote | take <client_order_id> | cancel");
}
await new Promise((r) => setTimeout(r, 3_000));
await call(liq, "GET", `/v2/openOrders?symbol=${SYMBOL}`);
console.log(JSON.stringify({ network: NETWORK, label: "TESTNET", cmd, file: saveRun(`liquidity-${cmd}`, { network: NETWORK, label: "TESTNET", cmd, mark: m.mark_price, calls }) }, null, 1));
