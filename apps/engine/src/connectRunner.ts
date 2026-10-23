import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Rules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { connectionNetwork, decryptKey, type ConnectRow } from "./connect.js";
import { logEvent, type Db } from "./db.js";
import { Executor } from "./executor.js";
import { Trader } from "./trader.js";

/**
 * Runs every connected account (`tug-trader@connect`, Strike testnet only): one Trader per active connection, on
 * the rules' testnet markets, sized on the budget cap and never past it, with the builder fee on every order.
 * A connection marked stopping is wound down here: TUG's orders are cancelled, positions are closed if the person
 * asked, and the encrypted key is deleted.
 */
export class ConnectRunner {
  private readonly running = new Map<string, { trader: Trader; ex: Executor }>();

  constructor(
    private readonly db: Db,
    private readonly rules: Rules,
    private readonly o: { kek: Buffer; strikeUrl: string; feeBps: number; stateDir: string; killFile: string; pollMs?: number },
  ) {}

  private build(row: ConnectRow): { trader: Trader; ex: Executor } {
    const hex = decryptKey(this.o.kek, row.enc_privkey!);
    const net = connectionNetwork(row.id);
    const ex = new Executor(this.db, new StrikeSigned(hex, this.o.strikeUrl, undefined, this.o.feeBps), net, { trading: true, killFile: this.o.killFile, pollMs: this.o.pollMs });
    const trader = new Trader(this.db, ex, this.rules, {
      network: net,
      markets: this.rules.testnet_markets,
      tradingOn: () => !existsSync(this.o.killFile),
      pausedFile: join(this.o.stateDir, `PAUSED-${net}`),
      keyFile: { hex },
      budgetUsd: row.budget_usd ?? 0,
      startEquity: row.start_equity ?? undefined,
    });
    return { trader, ex };
  }

  /** One pass: start new active connections, wind down stopping ones. */
  async tick(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM connections WHERE status IN ('active','stopping') AND network='testnet'").all() as ConnectRow[];
    for (const row of rows) {
      try {
        if (row.status === "active" && !this.running.has(row.id) && row.enc_privkey) {
          let start = row.start_equity;
          if (start === null) {
            // The drawdown stop is measured from the equity TUG starts with, capped at the budget.
            const acct = await this.build(row).ex.account();
            start = Math.min(acct.equity, row.budget_usd ?? acct.equity);
            this.db.prepare("UPDATE connections SET start_equity=?, updated_at=? WHERE id=?").run(start, Date.now(), row.id);
          }
          const r = this.build({ ...row, start_equity: start });
          r.trader.start();
          this.running.set(row.id, r);
          logEvent(this.db, "connect", "info", "trading a connected account", undefined, { id: row.id, budget: row.budget_usd });
        } else if (row.status === "stopping") {
          await this.wind(row);
        }
      } catch (e) {
        logEvent(this.db, "connect", "error", (e as Error).message, (e as { code?: string }).code ?? "E-CONN", { id: row.id });
      }
    }
  }

  /** Stop: cancel TUG's orders, close positions if asked, delete the key, and record what was done. */
  async wind(row: ConnectRow): Promise<void> {
    const r = this.running.get(row.id) ?? (row.enc_privkey ? this.build(row) : undefined);
    this.running.get(row.id)?.trader.stop();
    this.running.delete(row.id);
    const report: { at: number; cancelled: string[]; closed: string[]; open_orders_after: number; positions_after: string[] } = { at: Date.now(), cancelled: [], closed: [], open_orders_after: 0, positions_after: [] };
    if (r) {
      const prefix = `tug-v${this.rules.version}-${connectionNetwork(row.id)}-`;
      for (const s of this.rules.testnet_markets) {
        for (const o of (await r.ex.openOrders(s)).filter((x) => x.ClientOrderID.startsWith(prefix))) {
          await r.ex.cancel(s, o.ClientOrderID);
          report.cancelled.push(o.ClientOrderID);
        }
      }
      if (row.close_on_stop) {
        for (const s of Object.keys(await r.ex.positions()).filter((x) => this.rules.testnet_markets.includes(x))) {
          await r.ex.riskExit(s, `${prefix}${Date.now()}-stop-${s}`.slice(0, 64), "closed on Stop", undefined, "E-EXIT");
          report.closed.push(s);
        }
      }
      for (const s of this.rules.testnet_markets) report.open_orders_after += (await r.ex.openOrders(s)).filter((x) => x.ClientOrderID.startsWith(prefix)).length;
      report.positions_after = Object.keys(await r.ex.positions());
    }
    const now = Date.now();
    this.db.prepare("UPDATE connections SET status='ended', enc_privkey=NULL, stop_report=?, ended_at=?, updated_at=? WHERE id=?").run(JSON.stringify(report), now, now, row.id);
    logEvent(this.db, "connect", "info", "connection ended: key deleted", undefined, { id: row.id, ...report });
  }

  stopAll(): void {
    for (const r of this.running.values()) r.trader.stop();
    this.running.clear();
  }
}
