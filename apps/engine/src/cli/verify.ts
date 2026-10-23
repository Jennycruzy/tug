// `pnpm verify [evidence dir] [--offline]`: checks the evidence bundle and recomputes every record from it (§16.2).
// With no dir it clones Jennycruzy/tug-evidence. Unless --offline, it also re-reads TUG's live fills from Strike's
// public API (no key). Exits 1 if any check fails.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../config.js";
import { verifyBundle } from "../verify.js";

/** TUG's live Strike account (public: Strike's trader page @tug-mainnet). */
const LIVE_ACCOUNT = "01a16637-81cb-7682-b614-4728271550aa";
const args = process.argv.slice(2);
const offline = args.includes("--offline");
let dir = args.find((a) => !a.startsWith("--"));
if (!dir) {
  dir = join(mkdtempSync(join(tmpdir(), "tug-evidence-")), "tug-evidence");
  console.log(`downloading the evidence: git clone https://github.com/Jennycruzy/tug-evidence ${dir}`);
  execFileSync("git", ["clone", "-q", "--depth", "1", "https://github.com/Jennycruzy/tug-evidence", dir], { stdio: "inherit" });
}
const fp = (JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Array<{ file: string; sha256: string }>)[0]!;
const checks = await verifyBundle(dir, {
  rulesSha256: fp.sha256,
  strikeFills: offline
    ? undefined
    : async () => {
        const r = await fetch(`https://api.strikefinance.org/v2/history/fill?account_id=${LIVE_ACCOUNT}&limit=1000`, { headers: { "user-agent": "tug-verify" } });
        const j = (await r.json()) as { fills?: Array<Record<string, string | number>> | null };
        return (j.fills ?? []).map((f) => ({ id: Number(f.id), order_id: Number(f.order_id), price: Number(f.price), size: Number(f.size), fee: Number(f.fee) }));
      },
});
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(15)} ${c.detail}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `${failed} check(s) failed` : "every check passed");
process.exit(failed ? 1 : 0);
