import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TugError } from "@tug/core";
import { StrikeSigned, markets } from "@tug/strike";
import { DB_FILE, KILL_FILE, NETWORK, RUNS_DIR, TRADING } from "../config.js";
import { openDb } from "../db.js";
import { Executor } from "../executor.js";

export function executorFromEnv(): { executor: Executor; db: ReturnType<typeof openDb> } {
  const keyFile = process.env.TUG_ACCOUNT_KEY_FILE;
  if (!keyFile) throw new TugError("E-KEY", "TUG_ACCOUNT_KEY_FILE is not set.");
  const db = openDb(DB_FILE);
  const executor = new Executor(db, StrikeSigned.fromFile(keyFile), NETWORK, { trading: TRADING, killFile: KILL_FILE });
  return { executor, db };
}

export async function marketSymbols(): Promise<string[]> {
  return Object.keys((await markets()).markets).sort();
}

/** Writes a run's full record (every request and reply it made) next to the database. */
export function saveRun(name: string, data: unknown): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const file = join(RUNS_DIR, `${name}-${NETWORK}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(data, null, 1) + "\n");
  return file;
}

export function callsSince(db: ReturnType<typeof openDb>, since: number): unknown[] {
  return db.prepare("SELECT * FROM strike_calls WHERE network=? AND ts>=? ORDER BY id").all(NETWORK, since);
}
