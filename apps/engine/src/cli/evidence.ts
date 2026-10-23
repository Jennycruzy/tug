// The hourly evidence push (`tug-evidence.timer`): writes the bundle into the tug-evidence checkout, then commits
// and pushes it when TUG_EVIDENCE_PUSH=on. Data only; one commit per run that changed anything.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_FILE, ROOT } from "../config.js";
import { openDb } from "../db.js";
import { exportEvidence } from "../evidence.js";

const dir = process.env.TUG_EVIDENCE_REPO_DIR;
const saltFile = process.env.TUG_EVIDENCE_SALT_FILE;
if (!dir || !saltFile) throw new Error("TUG_EVIDENCE_REPO_DIR and TUG_EVIDENCE_SALT_FILE must be set.");
const fp = (JSON.parse(readFileSync(join(ROOT, "evidence/rules-fingerprints.json"), "utf8")) as Array<{ file: string; record_start?: string; frozen_at: string }>)[0]!;
const db = openDb(DB_FILE);
const r = exportEvidence(db, dir, { recordStartMs: Date.parse(fp.record_start ?? fp.frozen_at), salt: readFileSync(saltFile, "utf8").trim(), rulesFile: readFileSync(join(ROOT, fp.file)) });
db.close();
console.log(JSON.stringify({ t: new Date().toISOString(), msg: "evidence written", data: { changed: r.written.length, files: r.files } }));
if (process.env.TUG_EVIDENCE_PUSH === "on" && r.written.length > 0) {
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("add", "-A");
  git("commit", "-q", "-m", `data ${new Date().toISOString().slice(0, 16)}Z`);
  git("push", "-q", "origin", "HEAD");
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: "evidence pushed", data: { head: git("rev-parse", "--short", "HEAD").trim() } }));
}
