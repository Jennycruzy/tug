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
import { existsSync, writeFileSync } from "node:fs";
import { adminPortFor, listenAdmin } from "./admin.js";

const loaded = loadRules(RULES_FILE);
assertPublished(loaded, JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Fingerprint[]);
const keyFile = process.env.TUG_ACCOUNT_KEY_FILE;
if (!keyFile) throw new Error("TUG_ACCOUNT_KEY_FILE is not set: this network has no trading account yet.");
const db = openDb(DB_FILE);
// `tug-trader@vault` runs the testnet vault: the leader's key, its rows under the network name "vault".
const vaultId = process.env.TUG_TRADE_VAULT === "on" ? process.env.TUG_VAULT_ID : undefined;
if (process.env.TUG_TRADE_VAULT === "on" && !vaultId) throw new Error("TUG_TRADE_VAULT is on but TUG_VAULT_ID is not set.");
const ex = new Executor(db, StrikeSigned.fromFile(keyFile), NETWORK, { trading: TRADING, killFile: KILL_FILE, vaultId });
const trader = new Trader(db, ex, loaded.rules, {
  network: NETWORK,
  markets: NETWORK === "mainnet" ? "all" : loaded.rules.testnet_markets,
  tradingOn: () => TRADING && !existsSync(KILL_FILE),
  pausedFile: join(STATE_DIR, `PAUSED-${NETWORK}`),
  startEquity: process.env.TUG_START_EQUITY ? Number(process.env.TUG_START_EQUITY) : undefined,
  keyFile,
  vaultId,
});

// POST /admin/pause (loopback only, §9.7): turns the kill switch on and cancels every TUG order at once.
// It is bound before the trader starts: if the port is taken, the service exits having sent nothing to Strike.
const ADMIN_PORT = Number(process.env.TUG_ADMIN_PORT ?? adminPortFor(NETWORK));
try {
  await listenAdmin(ADMIN_PORT, () => {
    writeFileSync(KILL_FILE, JSON.stringify({ at: new Date().toISOString(), reason: "admin pause" }) + "\n");
    logEvent(db, "trader", "warn", "admin pause: kill switch on", "E-KILLED");
    return trader.riskTick();
  });
} catch (e) {
  logEvent(db, "trader", "error", `admin port ${ADMIN_PORT} could not be bound; trader not started: ${(e as Error).message}`, "E-ADMIN-PORT");
  console.error(JSON.stringify({ t: new Date().toISOString(), msg: "admin port bind failed; trader not started", data: { port: ADMIN_PORT, error: (e as Error).message } }));
  db.close();
  process.exit(1);
}
logEvent(db, "trader", "info", "trader start", undefined, { network: NETWORK, trading: TRADING, adminPort: ADMIN_PORT });
console.log(JSON.stringify({ t: new Date().toISOString(), msg: "trader start", data: { network: NETWORK, trading: TRADING, adminPort: ADMIN_PORT } }));
trader.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    trader.stop();
    db.close();
    process.exit(0);
  });
}
