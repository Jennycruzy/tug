import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Rules } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { connectionNetwork, decryptKey, type ConnectRow } from "./connect.js";
import { logEvent, type Db } from "./db.js";
import { Executor } from "./executor.js";
import { Trader } from "./trader.js";

export const STRIKE_API_KEYS_PAGE = "https://testnet.strikefinance.org/api-keys";
export const STRIKE_KEY_NOTE = "TUG deleted its copy of the trading key. The key stays listed on your Strike account until you remove it on Strike's API keys page.";

interface StopReport {
  at: number;
  tries: number;
  cancelled: string[];
  closed: string[];
  open_orders_after: number;
  positions_after: string[];
  key: "kept" | "deleted";
  strike_key_note: string;
  strike_api_keys_page: string;
}

/**
 * Runs every connected account (`tug-trader@connect`, Strike testnet only): one Trader per active connection, on
 * the rules' testnet markets, sized on the budget cap and never past it, with the builder fee on every order.
 * A connection marked stopping is wound down here: TUG's orders are cancelled, positions are closed if the person
 * asked, and the encrypted key is deleted.
 */
export class ConnectRunner {
  private readonly running = new Map<string, { trader: Trader; ex: Executor }>();
  private readonly stopTries = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly rules: Rules,
    private readonly o: { kek: Buffer; strikeUrl: string; feeBps: number; stateDir: string; killFile: string; pollMs?: number },
  ) {
    // A deleted key's ciphertext is overwritten in the database file, not just unlinked.
    this.db.pragma("secure_delete = ON");
  }

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

  /** One pass: expire unsigned connections, start new active ones, wind down stopping ones. */
  async tick(): Promise<void> {
    this.expireSigning();
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

  /**
   * Stop: wait for any running tick, cancel TUG's orders, close positions if asked, then read back. The key is
   * deleted only when no TUG order is left open (and no position, if closing was asked); otherwise the connection
   * stays "stopping" and the next pass tries again, with E-STOP-OPEN logged from the third try. TUG deletes its own
   * copy of the key; Strike has no call for TUG to remove the key from the person's account (their API keys page does).
   */
  async wind(row: ConnectRow): Promise<void> {
    const running = this.running.get(row.id);
    if (running) {
      await running.trader.stop();
      this.running.delete(row.id);
    }
    const r = running ?? (row.enc_privkey ? this.build(row) : undefined);
    const tries = (this.stopTries.get(row.id) ?? 0) + 1;
    this.stopTries.set(row.id, tries);
    const report: StopReport = { at: Date.now(), tries, cancelled: [], closed: [], open_orders_after: 0, positions_after: [], key: "kept", strike_key_note: STRIKE_KEY_NOTE, strike_api_keys_page: STRIKE_API_KEYS_PAGE };
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
      report.positions_after = Object.keys(await r.ex.positions()).filter((x) => this.rules.testnet_markets.includes(x));
    }
    const now = Date.now();
    const clear = report.open_orders_after === 0 && (!row.close_on_stop || report.positions_after.length === 0);
    if (r && !clear) {
      // Something is still open: keep the key so TUG can still cancel or close it, and try again next pass.
      this.db.prepare("UPDATE connections SET stop_report=?, updated_at=? WHERE id=?").run(JSON.stringify(report), now, row.id);
      if (tries >= 3) logEvent(this.db, "connect", "error", "Stop could not clear TUG's orders or positions yet; trying again", "E-STOP-OPEN", { id: row.id, ...report });
      return;
    }
    report.key = "deleted";
    this.stopTries.delete(row.id);
    this.db.prepare("UPDATE connections SET status='ended', enc_privkey=NULL, stop_report=?, ended_at=?, updated_at=? WHERE id=?").run(JSON.stringify(report), now, now, row.id);
    logEvent(this.db, "connect", "info", "connection ended: TUG's copy of the key deleted", undefined, { id: row.id, ...report });
  }

  /** A connection whose wallet never signed keeps no key: after 15 minutes it ends as failed and the key is deleted. */
  expireSigning(now = Date.now()): number {
    return this.db
      .prepare("UPDATE connections SET status='failed', enc_privkey=NULL, nonce=NULL, error='no wallet signature within 15 minutes', updated_at=? WHERE status='signing' AND created_at < ?")
      .run(now, now - 15 * 60_000).changes;
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((r) => r.trader.stop()));
    this.running.clear();
  }
}
