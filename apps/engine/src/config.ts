import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ROOT = process.env.TUG_ROOT ?? process.cwd();
export const NETWORK = process.env.TUG_NETWORK ?? "mainnet";
export const RULES_FILE = process.env.TUG_RULES_FILE ?? join(ROOT, "rules/tug-rules-v1.json");
export const DB_FILE = process.env.TUG_DB ?? join(ROOT, "data/tug.db");
export const RAW_DIR = process.env.TUG_RAW_DIR ?? join(ROOT, "data/raw");
/** Present while a cycle (crowd refresh + snapshot) runs; per network. Kept next to the database. */
export const BUSY_FILE = join(dirname(DB_FILE), `BUSY-${NETWORK}`);
export const REVISION = existsSync(join(ROOT, "REVISION")) ? readFileSync(join(ROOT, "REVISION"), "utf8").trim() : "unknown";
