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
    private readonly opts: { trading: boolean; killFile: string },
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
      await sleep(3_000);
      const r = await this.client.call("GET", path);
      if (r.status === 200) {
        this.db
          .prepare("INSERT INTO strike_calls (network, ts, method, path, body, status, reply) VALUES (?,?,'GET',?,NULL,?,?)")
          .run(this.network, r.at, path, r.status, r.raw);
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
    logEvent(this.db, "executor", report.openAfter === 0 ? "info" : "error", "kill switch done", undefined, report);
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
