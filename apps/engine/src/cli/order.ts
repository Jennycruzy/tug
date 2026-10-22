// Places one post-only buy that rests 1% under the mark, so it waits in the book without filling.
// Used to show the path from TUG to Strike's book end to end: `pnpm order:rest [SYMBOL]`.
import { toStep } from "@tug/core";
import { markets } from "@tug/strike";
import { NETWORK } from "../config.js";
import { callsSince, executorFromEnv, saveRun } from "./shared.js";

const symbol = process.argv[2] ?? "ETH-USD";
const started = Date.now();
const { executor, db } = executorFromEnv();
const m = (await markets()).markets[symbol];
if (!m?.mark_price || !m.order_tick_price || !m.order_limit_step_size) throw new Error(`${symbol}: market rules not found`);
const tick = m.order_tick_price;
const below = m.mark_price * 0.99;
const priceNum = m.ask1_price ? Math.min(below, m.ask1_price - Number(tick)) : below;
const price = toStep(priceNum, tick, "down");
const size = toStep(((m.order_min_notional ?? 5) * 1.2) / Number(price), m.order_limit_step_size, "up");
const clientOrderId = `tug-v1-${NETWORK}-rest-${symbol}-${started}`;
const order = await executor.placePostOnly({
  symbol,
  side: "buy",
  price,
  size,
  clientOrderId,
  reason: "Resting order 1% under the mark that shows the order path; cancelled by the kill switch.",
});
const file = saveRun("order", { network: NETWORK, symbol, mark: m.mark_price, order, calls: callsSince(db, started) });
console.log(JSON.stringify({ network: NETWORK, orderId: order.ID, clientOrderId, status: order.Status, price, size, file }, null, 1));
db.close();
