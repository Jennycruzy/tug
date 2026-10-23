// `tug-trader@connect`: trades the accounts people connected on /join (Builder Connect), Strike testnet only.
// Every 10 s it starts newly active connections and winds down stopped ones (orders cancelled, key deleted).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPublished, loadRules, type Fingerprint } from "@tug/core";
import { DB_FILE, ROOT, RULES_FILE, STATE_DIR, STRIKE_TESTNET_URL, killFileFor } from "./config.js";
import { kekFrom } from "./connect.js";
import { ConnectRunner } from "./connectRunner.js";
import { logEvent, openDb } from "./db.js";

const loaded = loadRules(RULES_FILE);
assertPublished(loaded, JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Fingerprint[]);
const db = openDb(DB_FILE);
if (process.env.STRIKE_API_URL !== STRIKE_TESTNET_URL) {
  const msg = `Connected accounts run on ${STRIKE_TESTNET_URL} only; STRIKE_API_URL is ${process.env.STRIKE_API_URL ?? "unset (mainnet)"}.`;
  logEvent(db, "connect", "error", msg, "E-NETWORK");
  console.error(JSON.stringify({ t: new Date().toISOString(), msg: "connect runner not started", data: { error: msg } }));
  db.close();
  process.exit(1);
}
const runner = new ConnectRunner(db, loaded.rules, {
  kek: kekFrom(process.env.TUG_KEK),
  strikeUrl: STRIKE_TESTNET_URL,
  feeBps: Number(process.env.TUG_BUILDER_FEE_BPS ?? 1),
  stateDir: STATE_DIR,
  killFile: killFileFor("connect"),
});
console.log(JSON.stringify({ t: new Date().toISOString(), msg: "connect runner start", data: { feeBps: Number(process.env.TUG_BUILDER_FEE_BPS ?? 1) } }));
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
    runner.stopAll();
    db.close();
    process.exit(0);
  });
}
