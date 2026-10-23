// `tug-connect` (testnet) and `tug-connect-mainnet`: trade the accounts people connected on /join (Builder
// Connect) on one Strike network (TUG_CONNECT_NETWORK). Every 10 s it starts newly active connections and winds down
// stopped ones (orders cancelled, key deleted). Mainnet runs only with TUG_CONNECT_MAINNET=on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublished, loadRules, type Fingerprint } from "@tug/core";
import { DB_FILE, ROOT, RULES_FILE, STATE_DIR, STRIKE_MAINNET_URL, STRIKE_TESTNET_URL, killFileFor } from "./config.js";
import { kekFrom } from "./connect.js";
import { ConnectRunner } from "./connectRunner.js";
import { logEvent, openDb } from "./db.js";

const loaded = loadRules(RULES_FILE);
assertPublished(loaded, JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Fingerprint[]);
const db = openDb(DB_FILE);
const network = process.env.TUG_CONNECT_NETWORK === "mainnet" ? "mainnet" : "testnet";
const want = network === "mainnet" ? STRIKE_MAINNET_URL : STRIKE_TESTNET_URL;
const refused =
  network === "mainnet" && process.env.TUG_CONNECT_MAINNET !== "on"
    ? "Mainnet connections are not open (TUG_CONNECT_MAINNET is not on)."
    : process.env.STRIKE_API_URL !== want
      ? `Connected ${network} accounts run on ${want}; STRIKE_API_URL is ${process.env.STRIKE_API_URL ?? "unset"}.`
      : null;
if (refused) {
  const msg = refused;
  logEvent(db, "connect", "error", msg, "E-NETWORK");
  console.error(JSON.stringify({ t: new Date().toISOString(), msg: "connect runner not started", data: { error: msg } }));
  db.close();
  process.exit(1);
}
const runner = new ConnectRunner(db, loaded.rules, {
  kek: kekFrom(process.env.TUG_KEK),
  strikeUrl: want,
  feeBps: Number(process.env.TUG_BUILDER_FEE_BPS ?? 1),
  stateDir: STATE_DIR,
  killFile: killFileFor(network === "mainnet" ? "connect-mainnet" : "connect"),
  network,
});
console.log(JSON.stringify({ t: new Date().toISOString(), msg: "connect runner start", data: { network, feeBps: Number(process.env.TUG_BUILDER_FEE_BPS ?? 1) } }));
let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try {
    await runner.tick();
  } finally {
    busy = false;
  }
};
void tick();
const timer = setInterval(() => void tick(), 10_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    void runner.stopAll().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
