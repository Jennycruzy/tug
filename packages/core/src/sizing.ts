import { toStep } from "./rounding.js";

/** A market's order rules, as Strike's `/v2/markets` publishes them. */
export interface MarketRules {
  tick: string;
  step: string;
  minSize: string;
  maxSize: string;
  minNotional: number;
}

export interface Holding {
  /** Signed position size in base units, as a decimal string (0 when flat). */
  size: string;
  mark: number;
}

export interface PlannedOrder {
  symbol: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  notional: number;
  /** Whether the order only shrinks or closes the position. */
  reduces: boolean;
  /** One plain line saying why the order exists. */
  why: string;
}

export interface Skipped {
  symbol: string;
  why: string;
}

/** Reads the order rules of every market from a `/v2/markets` reply. */
export function marketRulesFrom(markets: Record<string, Record<string, unknown>>): Record<string, MarketRules> {
  const out: Record<string, MarketRules> = {};
  for (const [symbol, m] of Object.entries(markets)) {
    out[symbol] = {
      tick: String(m.order_tick_price),
      step: String(m.order_limit_step_size),
      minSize: String(m.order_limit_min_size),
      maxSize: String(m.order_limit_max_size),
      minNotional: Number(m.order_min_notional),
    };
  }
  return out;
}

const side = (n: number): "long" | "short" => (n > 0 ? "long" : "short");

/**
 * Turns target notionals into one post-only order per market (§9.5 steps 3–5): the delta between target
 * and holding, skipped inside the rebalance band, sized down to the market's step, priced at the best
 * bid (buys) or best ask (sells) rounded to the tick so the order waits in the book, never above the
 * market's maximum size and never below its minimum notional. A market whose target is zero is closed
 * with its exact size. Pure and deterministic: the same inputs give the same orders.
 */
export function planOrders(
  targets: Record<string, number>,
  holdings: Record<string, Holding>,
  books: Record<string, { bid: number; ask: number }>,
  rules: Record<string, MarketRules>,
  bandFraction: number,
): { orders: PlannedOrder[]; skipped: Skipped[] } {
  const orders: PlannedOrder[] = [];
  const skipped: Skipped[] = [];
  const symbols = [...new Set([...Object.keys(targets), ...Object.keys(holdings)])].sort();
  for (const symbol of symbols) {
    const r = rules[symbol];
    const book = books[symbol];
    if (!r) {
      skipped.push({ symbol, why: "Strike's order rules for this market were not read." });
      continue;
    }
    if (!book || !(book.bid > 0) || !(book.ask > book.bid)) {
      skipped.push({ symbol, why: "No usable best bid and ask for this market." });
      continue;
    }
    const held = holdings[symbol];
    const heldSize = held ? Number(held.size) : 0;
    const current = held ? heldSize * held.mark : 0;
    const target = targets[symbol] ?? 0;
    const delta = target - current;

    if (target === 0 && heldSize === 0) continue;
    if (target !== 0 && Math.abs(delta) < Math.max(r.minNotional, bandFraction * Math.abs(target))) {
      skipped.push({ symbol, why: "Within the rebalance band; no order." });
      continue;
    }

    const buy = delta > 0;
    const price = buy ? toStep(book.bid, r.tick, "down") : toStep(book.ask, r.tick, "up");
    const px = Number(price);
    const closing = target === 0;
    let size = closing ? toStep(Math.abs(heldSize), r.step, "down") : toStep(Math.abs(delta) / px, r.step, "down");
    if (Number(size) > Number(r.maxSize)) size = r.maxSize;
    const notional = Number(size) * px;
    const reduces = heldSize !== 0 && Math.sign(delta) !== Math.sign(heldSize) && Math.abs(Number(size)) <= Math.abs(heldSize) + 1e-12;
    if (Number(size) < Number(r.minSize) || Number(size) === 0) {
      skipped.push({ symbol, why: "The change is smaller than the market's minimum size." });
      continue;
    }
    if (notional < r.minNotional && !(closing && reduces)) {
      skipped.push({ symbol, why: "The change is below the market's minimum order value." });
      continue;
    }
    const why =
      target === 0
        ? `The gap closed: close the ${side(heldSize)} position.`
        : current === 0
          ? `Open ${side(target)} toward the target.`
          : Math.sign(target) !== Math.sign(current)
            ? `The gap flipped: move from ${side(current)} toward ${side(target)}.`
            : Math.abs(target) > Math.abs(current)
              ? `Add to the ${side(target)} position toward the target.`
              : `Trim the ${side(target)} position toward the target.`;
    orders.push({ symbol, side: buy ? "buy" : "sell", price, size, notional, reduces, why });
  }
  return { orders, skipped };
}
