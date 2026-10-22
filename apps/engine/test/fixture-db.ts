import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { openDb, type Db } from "../src/db.js";

/** Real rows exported unchanged from the mainnet recorder database: snapshots 4–15 of 2026-10-22. */
export const FIXTURE = JSON.parse(
  gunzipSync(readFileSync(new URL("./fixtures/record-2026-10-22-s4-15.json.gz", import.meta.url))).toString("utf8"),
) as Record<string, Array<Record<string, unknown>>>;

const TABLES = ["crowd_versions", "crowd_members", "snapshots", "positions", "marks", "leans"] as const;

/** An in-memory database holding the fixture's recorded inputs (no derived records). */
export function fixtureDb(): Db {
  const db = openDb(":memory:");
  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    for (const t of TABLES) {
      for (const fixtureRow of FIXTURE[t]!) {
        // Each member's raw discover item is left out of the fixture; the column only needs a value.
        const row = t === "crowd_members" ? { ...fixtureRow, raw_json: "null" } : fixtureRow;
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => row[c] as never));
      }
    }
  })();
  return db;
}
