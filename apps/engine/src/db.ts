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
  pages INTEGER NOT NULL,
  network TEXT NOT NULL DEFAULT 'mainnet',
  mapping_json TEXT
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
  errors INTEGER NOT NULL DEFAULT 0,
  network TEXT NOT NULL DEFAULT 'mainnet'
);
CREATE TABLE IF NOT EXISTS positions (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  platform TEXT NOT NULL,
  member_id TEXT NOT NULL,
  crowd TEXT NOT NULL,
  symbol TEXT NOT NULL,
  signed_notional REAL NOT NULL,
  account_value REAL
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
CREATE TABLE IF NOT EXISTS paper (
  snapshot_id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  turnover REAL NOT NULL,
  fees REAL NOT NULL,
  funding REAL NOT NULL,
  positions_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scoreboard (
  crowd TEXT NOT NULL,
  symbol TEXT NOT NULL,
  pnl_usd REAL NOT NULL,
  PRIMARY KEY (crowd, symbol)
);
CREATE TABLE IF NOT EXISTS scoreboard_summary (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  from_ts INTEGER, to_ts INTEGER,
  copy_pnl REAL, fade_pnl REAL,
  copy_up INTEGER, copy_active INTEGER, fade_up INTEGER, fade_active INTEGER,
  snapshots INTEGER
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
CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  order_id INTEGER,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  price TEXT NOT NULL,
  size TEXT NOT NULL,
  post_only INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  placed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  snapshot_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  target_usd REAL NOT NULL,
  PRIMARY KEY (snapshot_id, symbol)
);
CREATE TABLE IF NOT EXISTS user_frames (
  network TEXT NOT NULL,
  ts INTEGER NOT NULL,
  raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_frames_ts ON user_frames(ts);
CREATE TABLE IF NOT EXISTS live_equity (
  network TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  positions_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_equity_ts ON live_equity(network, ts);
CREATE TABLE IF NOT EXISTS fills (
  network TEXT NOT NULL,
  fill_id INTEGER NOT NULL,
  trade_id INTEGER NOT NULL,
  order_id INTEGER,
  client_order_id TEXT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  role TEXT,
  price REAL NOT NULL,
  size REAL NOT NULL,
  fee REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  ts INTEGER NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (network, fill_id)
);
CREATE TABLE IF NOT EXISTS records_json (
  name TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  network TEXT NOT NULL,
  id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT,
  tx_hash TEXT,
  raw TEXT NOT NULL,
  PRIMARY KEY (network, id)
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL,
  network TEXT NOT NULL,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  api_pubkey TEXT NOT NULL,
  enc_privkey TEXT,
  nonce TEXT,
  account_id TEXT,
  fee_share_bps INTEGER,
  budget_usd REAL,
  close_on_stop INTEGER NOT NULL DEFAULT 0,
  start_equity REAL,
  status TEXT NOT NULL,
  error TEXT,
  stop_report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS depth_samples (
  network TEXT NOT NULL,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  tug_size REAL NOT NULL,
  at_best INTEGER NOT NULL,
  best_total REAL NOT NULL,
  top5_total REAL NOT NULL,
  PRIMARY KEY (network, ts, symbol, side)
);
CREATE TABLE IF NOT EXISTS vault_points (
  vault_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  share_price REAL NOT NULL,
  equity REAL NOT NULL,
  total_shares REAL NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (vault_id, ts)
);
CREATE TABLE IF NOT EXISTS vault_moves (
  vault_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  account_id TEXT,
  status TEXT NOT NULL,
  ts INTEGER NOT NULL,
  usd REAL,
  shares REAL,
  share_price REAL,
  execute_at INTEGER,
  executed_at INTEGER,
  raw TEXT NOT NULL,
  PRIMARY KEY (vault_id, id)
);
CREATE TABLE IF NOT EXISTS strike_calls (
  id INTEGER PRIMARY KEY,
  network TEXT NOT NULL,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT,
  status INTEGER,
  reply TEXT
);
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
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
  db.prepare("INSERT INTO events (ts, network, component, level, code, message, data_json) VALUES (?,?,?,?,?,?,?)").run(
    Date.now(),
    process.env.TUG_NETWORK ?? "mainnet",
    component,
    level,
    code ?? null,
    message,
    data === undefined ? null : JSON.stringify(data),
  );
}

/** Adds columns introduced after the first deployment; safe to run on every start. */
function migrate(db: Db): void {
  const add = (table: string, col: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add("crowd_versions", "network", "network TEXT NOT NULL DEFAULT 'mainnet'");
  add("crowd_versions", "mapping_json", "mapping_json TEXT");
  add("snapshots", "network", "network TEXT NOT NULL DEFAULT 'mainnet'");
  add("positions", "account_value", "account_value REAL");
  add("snapshots", "mapping_version", "mapping_version INTEGER");
  add("marks", "bid", "bid REAL");
  add("marks", "ask", "ask REAL");
  add("marks", "min_notional", "min_notional REAL");
  // Rows written before this column existed keep NULL: their network was not recorded.
  add("events", "network", "network TEXT");
  // Signed position size in base units; rows recorded before it were filled from the stored raw replies.
  add("positions", "size", "size REAL");
}
