import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crowd_versions (
  id INTEGER PRIMARY KEY,
  pulled_at INTEGER NOT NULL,
  rules_sha256 TEXT NOT NULL,
  copy_count INTEGER NOT NULL,
  fade_count INTEGER NOT NULL,
  member_hash TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  pages INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS crowd_members (
  version_id INTEGER NOT NULL REFERENCES crowd_versions(id),
  platform TEXT NOT NULL,
  member_id TEXT NOT NULL,
  crowd TEXT NOT NULL CHECK (crowd IN ('copy','fade')),
  copy_score REAL,
  style TEXT,
  account_value REAL,
  pnl_30d REAL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (version_id, platform, member_id)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  crowd_version INTEGER NOT NULL REFERENCES crowd_versions(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  read_copy REAL,
  read_fade REAL,
  status TEXT NOT NULL,
  raw_sha256 TEXT,
  errors INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS positions (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  platform TEXT NOT NULL,
  member_id TEXT NOT NULL,
  crowd TEXT NOT NULL,
  symbol TEXT NOT NULL,
  signed_notional REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS positions_snapshot ON positions(snapshot_id);
CREATE TABLE IF NOT EXISTS marks (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  symbol TEXT NOT NULL,
  mark REAL NOT NULL,
  funding_rate REAL,
  PRIMARY KEY (snapshot_id, symbol)
);
CREATE TABLE IF NOT EXISTS leans (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  symbol TEXT NOT NULL,
  long_copy REAL NOT NULL, short_copy REAL NOT NULL, lean_copy REAL NOT NULL, n_copy INTEGER NOT NULL,
  long_fade REAL NOT NULL, short_fade REAL NOT NULL, lean_fade REAL NOT NULL, n_fade INTEGER NOT NULL,
  gap REAL NOT NULL,
  tradable INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, symbol)
);
CREATE TABLE IF NOT EXISTS events (
  ts INTEGER NOT NULL,
  component TEXT NOT NULL,
  level TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function logEvent(
  db: Db,
  component: string,
  level: "info" | "warn" | "error",
  message: string,
  code?: string,
  data?: unknown,
): void {
  db.prepare("INSERT INTO events (ts, component, level, code, message, data_json) VALUES (?,?,?,?,?,?)").run(
    Date.now(),
    component,
    level,
    code ?? null,
    message,
    data === undefined ? null : JSON.stringify(data),
  );
}
