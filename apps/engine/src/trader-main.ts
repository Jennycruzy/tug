// The trading service for one network (`tug-trader@mainnet`, `tug-trader@testnet`): runs the Trader on the
// account whose API wallet key is in TUG_ACCOUNT_KEY_FILE. The recorder and the public API run separately.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublished, loadRules, type Fingerprint } from "@tug/core";
import { StrikeSigned } from "@tug/strike";
import { DB_FILE, KILL_FILE, NETWORK, ROOT, RULES_FILE, STATE_DIR, TRADING } from "./config.js";
import { logEvent, openDb } from "./db.js";
import { Executor } from "./executor.js";
import { Trader } from "./trader.js";
import { existsSync } from "node:fs";

const loaded = loadRules(RULES_FILE);
assertPublished(loaded, JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Fingerprint[]);
const keyFile = process.env.TUG_ACCOUNT_KEY_FILE;
if (!keyFile) throw new Error("TUG_ACCOUNT_KEY_FILE is not set: this network has no trading account yet.");
const db = openDb(DB_FILE);
const ex = new Executor(db, StrikeSigned.fromFile(keyFile), NETWORK, { trading: TRADING, killFile: KILL_FILE });
const trader = new Trader(db, ex, loaded.rules, {
  network: NETWORK,
  markets: NETWORK === "testnet" ? loaded.rules.testnet_markets : "all",
  tradingOn: () => TRADING && !existsSync(KILL_FILE),
  pausedFile: join(STATE_DIR, `PAUSED-${NETWORK}`),
  startEquity: process.env.TUG_START_EQUITY ? Number(process.env.TUG_START_EQUITY) : undefined,
  keyFile,
  vaultId: process.env.TUG_TRADE_VAULT === "on" ? process.env.TUG_VAULT_ID : undefined,
});
logEvent(db, "trader", "info", "trader start", undefined, { network: NETWORK, trading: TRADING });
console.log(JSON.stringify({ t: new Date().toISOString(), msg: "trader start", data: { network: NETWORK, trading: TRADING } }));
trader.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    trader.stop();
    db.close();
    process.exit(0);
  });
}
