import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TugError } from "@tug/core";
import { CancelAckSchema, OpenOrderSchema, OpenOrdersSchema, OrderAckSchema, type OpenOrder, type SignedReply, type StrikeSigned } from "@tug/strike";
import { logEvent, type Db } from "./db.js";

export interface PostOnlyOrder {
  symbol: string;
  side: "buy" | "sell";
  /** Decimal strings already rounded to the market's tick and step. */
  price: string;
  size: string;
  clientOrderId: string;
  /** One plain line saying why the order exists; shown on the site. */
  reason: string;
}

export interface KillReport {
  at: number;
  reason: string;
  cancelled: Array<{ symbol: string; orders: number; reply: unknown }>;
  openAfter: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Places and cancels TUG's orders on one Strike account. Every order waits in the book (post-only);
 * every request and reply is stored in `strike_calls`, every order in `orders`.
 */
export class Executor {
  constructor(
    private readonly db: Db,
    private readonly client: StrikeSigned,
    readonly network: string,
    private readonly opts: { trading: boolean; killFile: string; pollMs?: number },
  ) {}

  isKilled(): boolean {
    return existsSync(this.opts.killFile);
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<SignedReply> {
    const r = await this.client.call(method, path, body);
    this.db
      .prepare("INSERT INTO strike_calls (network, ts, method, path, body, status, reply) VALUES (?,?,?,?,?,?,?)")
      .run(this.network, r.at, method, path, body === undefined ? null : JSON.stringify(body), r.status, r.raw);
    if (r.status < 200 || r.status >= 300) {
      throw new TugError("E-STRIKE", `Strike replied ${r.status} to ${method} ${path}: ${r.raw.slice(0, 300)}`);
    }
    return r;
  }

  private setStatus(clientOrderId: string, status: string, orderId?: number): void {
    this.db
      .prepare("UPDATE orders SET status=?, order_id=COALESCE(?, order_id), updated_at=? WHERE client_order_id=?")
      .run(status, orderId ?? null, Date.now(), clientOrderId);
  }

  /** Places one post-only GTC limit order and confirms it by a REST read within 30 s. */
  async placePostOnly(o: PostOnlyOrder): Promise<OpenOrder> {
    if (this.isKilled()) throw new TugError("E-KILLED", "The kill switch is on; no order is placed until it is cleared.");
    if (this.network === "mainnet" && !this.opts.trading) {
      throw new TugError("E-TRADING-OFF", "Trading is off on mainnet; no order is placed.");
    }
    this.db
      .prepare(
        "INSERT INTO orders (client_order_id, network, symbol, side, price, size, post_only, reason, status, placed_at, updated_at) VALUES (?,?,?,?,?,?,1,?,'sent',?,?)",
      )
      .run(o.clientOrderId, this.network, o.symbol, o.side, o.price, o.size, o.reason, Date.now(), Date.now());
    try {
      const r = await this.call("POST", "/v2/order", {
        symbol: o.symbol,
        side: o.side,
        type: "limit",
        price: o.price,
        size: o.size,
        time_in_force: "GTC",
        post_only: true,
        client_order_id: o.clientOrderId,
      });
      OrderAckSchema.parse(r.json);
      this.setStatus(o.clientOrderId, "pending");
    } catch (e) {
      this.setStatus(o.clientOrderId, "rejected");
      logEvent(this.db, "executor", "error", (e as Error).message, (e as TugError).code ?? "E-STRIKE", { order: o });
      throw e;
    }
    const path = `/v2/order?symbol=${encodeURIComponent(o.symbol)}&client_order_id=${encodeURIComponent(o.clientOrderId)}`;
    for (let i = 0; i < 10; i++) {
      await sleep(this.opts.pollMs ?? 3_000);
      const r = await this.client.call("GET", path);
      // Every read is stored, the 404s of an order that never appeared included.
      this.db
        .prepare("INSERT INTO strike_calls (network, ts, method, path, body, status, reply) VALUES (?,?,'GET',?,NULL,?,?)")
        .run(this.network, r.at, path, r.status, r.raw);
      if (r.status === 200) {
        const order = (r.json as { ID?: number; Status?: string }) ?? {};
        if (order.ID && order.Status) {
          this.setStatus(o.clientOrderId, order.Status, order.ID);
          logEvent(this.db, "executor", "info", `order ${order.Status}`, undefined, { clientOrderId: o.clientOrderId, orderId: order.ID });
          return OpenOrderSchema.parse(r.json);
        }
      }
    }
    this.setStatus(o.clientOrderId, "dropped");
    logEvent(this.db, "executor", "error", "Strike accepted the order but it never appeared.", "E-DROPPED", { clientOrderId: o.clientOrderId });
    throw new TugError("E-DROPPED", "Strike accepted the order but it never appeared within 30 seconds.");
  }

  /** The account's equity and margin as Strike reports them (cross margin balance includes unrealised PnL). */
  async account(): Promise<{ accountId: string; equity: number; available: number; maintenanceMargin: number; marginRatio: number; raw: unknown }> {
    const r = await this.call("GET", "/v2/account");
    const a = r.json as Record<string, string>;
    const equity = Number(a.margin_balance);
    const maintenance = Number(a.maintenance_margin ?? 0);
    if (!Number.isFinite(equity)) throw new TugError("E-STRIKE", "Strike's account reply has no margin_balance.");
    return { accountId: a.account_id!, equity, available: Number(a.available_balance), maintenanceMargin: maintenance, marginRatio: equity > 0 ? maintenance / equity : 1, raw: a };
  }

  /** Open positions: signed size (base units) per market. */
  async positions(): Promise<Record<string, { size: string; entry: number; upnl: number }>> {
    const r = await this.call("GET", "/v2/positions");
    const list = ((r.json as { positions?: Array<Record<string, string>> | null }).positions ?? []) as Array<Record<string, string>>;
    return Object.fromEntries(list.filter((p) => Number(p.size) !== 0).map((p) => [p.symbol!, { size: String(p.size), entry: Number(p.entry_price), upnl: Number(p.upnl) }]));
  }

  /**
   * A risk exit (§9.7): a reduce-only market order closing the whole position. The only order TUG ever
   * sends that takes liquidity; allowed while trading is paused or killed, because it only removes risk.
   */
  /** A signed read whose request and reply are stored like every other call. */
  async read(path: string): Promise<unknown> {
    return (await this.call("GET", path)).json;
  }

  /** `code` is the reason's own event code: E-STOP (equity stop), E-MARGIN (margin reduce) or E-EXIT (manual). */
  async riskExit(symbol: string, clientOrderId: string, reason: string, size?: string, code = "E-STOP"): Promise<unknown> {
    this.db
      .prepare(
        "INSERT INTO orders (client_order_id, network, symbol, side, price, size, post_only, reason, status, placed_at, updated_at) VALUES (?,?,?,?,?,?,0,?,'sent',?,?)",
      )
      .run(clientOrderId, this.network, symbol, "sell", "market", "position", `Risk exit: ${reason}`, Date.now(), Date.now());
    const held = (await this.positions())[symbol];
    if (!held) {
      this.setStatus(clientOrderId, "not_needed");
      return { symbol, flat: true };
    }
    const side = Number(held.size) > 0 ? "sell" : "buy";
    this.db.prepare("UPDATE orders SET side=? WHERE client_order_id=?").run(side, clientOrderId);
    // The whole position closes with close_position; a partial reduction sends its own size, reduce-only.
    const r = await this.call("POST", "/v2/order", {
      symbol,
      side,
      type: "market",
      size: size ?? held.size.replace("-", ""),
      reduce_only: true,
      ...(size ? {} : { close_position: true }),
      client_order_id: clientOrderId,
    });
    this.setStatus(clientOrderId, "pending");
    logEvent(this.db, "executor", "warn", `risk exit ${symbol}: ${reason}`, code, { symbol, side, size: size ?? held.size });
    // Strike answers 201 to every well-formed order and decides later: read the exit back to its final status.
    const path = `/v2/order?symbol=${encodeURIComponent(symbol)}&client_order_id=${encodeURIComponent(clientOrderId)}`;
    for (let i = 0; i < 10; i++) {
      await sleep(this.opts.pollMs ?? 3_000);
      const back = await this.client.call("GET", path);
      this.db
        .prepare("INSERT INTO strike_calls (network, ts, method, path, body, status, reply) VALUES (?,?,'GET',?,NULL,?,?)")
        .run(this.network, back.at, path, back.status, back.raw);
      const o = (back.status === 200 ? back.json : {}) as { ID?: number; Status?: string };
      if (o.ID && o.Status && o.Status !== "pending") {
        this.setStatus(clientOrderId, o.Status, o.ID);
        return { reply: r.json, final: o };
      }
    }
    this.setStatus(clientOrderId, "unconfirmed");
    logEvent(this.db, "executor", "error", `risk exit ${symbol} not confirmed by Strike within 30 s`, "E-STOP-OPEN", { symbol, clientOrderId });
    return { reply: r.json, final: null };
  }

  async openOrders(symbol: string): Promise<OpenOrder[]> {
    const r = await this.call("GET", `/v2/openOrders?symbol=${encodeURIComponent(symbol)}`);
    return OpenOrdersSchema.parse(r.json).orders ?? [];
  }

  /**
   * The kill switch: turns trading off (the kill file blocks every new order, across restarts) and
   * cancels every open order on the given markets, then re-reads to confirm none is left.
   */
  async kill(reason: string, symbols: string[]): Promise<KillReport> {
    mkdirSync(dirname(this.opts.killFile), { recursive: true });
    writeFileSync(this.opts.killFile, JSON.stringify({ at: new Date().toISOString(), reason }) + "\n");
    logEvent(this.db, "executor", "warn", `kill switch on: ${reason}`, "E-KILLED");
    const report: KillReport = { at: Date.now(), reason, cancelled: [], openAfter: 0 };
    for (const symbol of symbols) {
      const open = await this.openOrders(symbol);
      if (open.length === 0) continue;
      const r = await this.call("DELETE", "/v2/order/cancel-all", { symbol });
      report.cancelled.push({ symbol, orders: open.length, reply: r.json });
      for (const o of open) this.setStatus(o.ClientOrderID, "canceled", o.ID);
    }
    await sleep(3_000);
    for (const symbol of report.cancelled.map((c) => c.symbol)) report.openAfter += (await this.openOrders(symbol)).length;
    logEvent(this.db, "executor", report.openAfter === 0 ? "info" : "error", "kill switch done", report.openAfter === 0 ? undefined : "E-KILL-LEFT", report);
    return report;
  }

  /** Cancels one order by its client id (normal operation, not the kill switch). */
  async cancel(symbol: string, clientOrderId: string): Promise<unknown> {
    const r = await this.call("DELETE", "/v2/order/cancel", { symbol, client_order_id: clientOrderId });
    CancelAckSchema.parse(r.json);
    this.setStatus(clientOrderId, "canceled");
    return r.json;
  }

  clearKill(): void {
    rmSync(this.opts.killFile, { force: true });
    logEvent(this.db, "executor", "info", "kill switch cleared");
  }
}
