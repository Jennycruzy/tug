import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROOT = process.env.TUG_ROOT ?? process.cwd();
export const NETWORK = process.env.TUG_NETWORK ?? "mainnet";
export const RULES_FILE = process.env.TUG_RULES_FILE ?? join(ROOT, "rules/tug-rules-v1.json");
export const DB_FILE = process.env.TUG_DB ?? join(ROOT, "data/tug.db");
export const RAW_DIR = process.env.TUG_RAW_DIR ?? join(ROOT, "data/raw");
/** Run state (busy flag, kill files, run logs) lives next to the database, outside the deployed tree. */
export const STATE_DIR = dirname(DB_FILE);
/** Present while a cycle (crowd refresh + snapshot) runs; per network. */
export const BUSY_FILE = join(STATE_DIR, `BUSY-${NETWORK}`);
export const RUNS_DIR = process.env.TUG_RUNS_DIR ?? join(STATE_DIR, "runs");
/** One kill file per network: a kill on testnet never stops mainnet, and the reverse. */
export const killFileFor = (network: string) => join(STATE_DIR, `KILL-${network}`);
export const KILL_FILE = killFileFor(NETWORK);
export const TRADING = process.env.TUG_TRADING === "on";
export const API_PORT = Number(process.env.TUG_API_PORT ?? 8790);
export const REVISION = existsSync(join(ROOT, "REVISION")) ? readFileSync(join(ROOT, "REVISION"), "utf8").trim() : "unknown";
