import { useEffect, useState } from "preact/hooks";

export interface Side {
  long: number;
  short: number;
  lean: number;
  n: number;
}

export interface Market {
  symbol: string;
  copy: Side;
  fade: Side;
  gap: number;
  tradable: boolean;
  reason: "two_crowds" | "copy_only" | "fade_only" | "none";
  mark: number | null;
  funding_rate: number | null;
  bid: number | null;
  ask: number | null;
  position: {
    live: { side: "long" | "short" | "flat"; notional: number };
    model: { side: "long" | "short" | "flat"; notional: number };
  };
}

export interface TugReply {
  network: string;
  snapshot: { id: number; at: number; finished_at: number | null; read_copy: number | null; read_fade: number | null };
  rules: { version: number; sha256: string; record_start: number };
  crowds: { id: number; pulled_at: number; copy_count: number; fade_count: number; member_hash: string } | null;
  model: { equity: number; start_equity: number; at: number } | null;
  live: { trading: boolean; account: string | null };
  markets: Market[];
}

export interface MemberRow {
  id: string;
  notional: number;
  score: number | null;
}

export interface MarketReply {
  snapshot: { id: number; at: number };
  market: Market;
  top: { copy: MemberRow[]; fade: MemberRow[] };
  strike: { copy: MemberRow[]; fade: { n: number; net: number | null } };
  history: Array<{ at: number; lean_copy: number; lean_fade: number; n_copy: number; n_fade: number; gap: number }>;
}

export interface StatusReply {
  now: number;
  engine: { started_at: number; revision: string; rules_sha256: string };
  recorder: {
    last_complete: { id: number; at: number; finished_at: number | null; read_copy: number | null; read_fade: number | null } | null;
    recent: Array<{ id: number; at: number; status: string; errors: number }>;
  };
  crowds: { id: number; pulled_at: number; copy_count: number; fade_count: number } | null;
  trading: { mainnet: "on" | "off"; kill_switch: { mainnet: "on" | "off"; testnet: "on" | "off" } };
  orders: {
    open: Record<string, number>;
    recent: Array<{ client_order_id: string; network: string; order_id: number | null; symbol: string; side: string; price: string; size: string; status: string; placed_at: number; updated_at: number }>;
  };
  errors_24h: { warn: number; error: number; recent: Array<{ ts: number; component: string; level: string; code: string | null; message: string }> };
}

export type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; data: T };

/** Fetches JSON from the engine's public API and refreshes it on an interval. */
export function useApi<T>(path: string, refreshMs = 60_000): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    const get = async () => {
      try {
        const res = await fetch(path, { headers: { accept: "application/json" } });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) setLoad({ state: "error", message: body?.message ?? `The API replied ${res.status}.` });
        else setLoad({ state: "ok", data: body as T });
      } catch {
        if (alive) setLoad((l) => (l.state === "ok" ? l : { state: "error", message: "The API could not be reached. Retrying every minute." }));
      }
    };
    void get();
    const t = setInterval(get, refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, refreshMs]);
  return load;
}

export const usd = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(a < 10 ? 2 : 0);
  return `${v < 0 ? "−" : ""}$${s}`;
};

export const signed = (v: number, digits = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${(m / 60).toFixed(1)} h ago`;
}

export const time = (ts: number) => new Date(ts).toISOString().slice(11, 16) + " UTC";

export interface PaperSummary {
  label: "MODEL";
  start_equity: number;
  start: number;
  at: number;
  snapshot_id: number;
  equity: number;
  turnover: number;
  fees: number;
  funding: number;
  positions: Array<{ symbol: string; notional: number }>;
}

export interface LiveRecord {
  label: "LIVE" | "TESTNET";
  account: string | null;
  start_equity: number;
  start: number;
  at: number;
  equity: number;
  fills: number;
  maker_fills: number;
  traded: number;
  fees: number;
  realized: number;
  positions: Array<{ symbol: string; size: number; entry: number; upnl: number }>;
  money_moves: Array<{ at: number; type: "deposit" | "withdraw"; amount: number; tx_hash: string | null }>;
  links: { strike_page: string; strike_fills: string; strike_positions: string; strike_deposits: string } | null;
  curve: Array<{ at: number; equity: number; put_in: number; result: number }>;
}

export interface Fill {
  at: number;
  symbol: string;
  side: string;
  role: string | null;
  price: number;
  size: number;
  fee: number;
  realized: number;
  order_id: number | null;
  client_order_id: string | null;
}

export interface VaultRecord {
  label: "TESTNET";
  vault_id: string;
  name: string;
  status: string;
  lockup_days: number | null;
  leader_fee_bps: number | null;
  start: number;
  at: number;
  share_price: number;
  start_share_price: number;
  equity: number;
  total_shares: number;
  fills: number;
  maker_fills: number;
  traded: number;
  fees: number;
  realized: number;
  positions: Array<{ symbol: string; size: number; entry: number; upnl: number }>;
  moves: Array<{
    id: string;
    type: "deposit" | "withdrawal";
    who: "leader" | "depositor";
    account: string | null;
    status: string;
    at: number;
    usd: number | null;
    shares: number | null;
    share_price: number | null;
    execute_at: number | null;
    executed_at: number | null;
  }>;
  links: { strike_vault_page: string; strike_vault: string; strike_history: string; strike_fills: string; strike_positions: string };
  curve: Array<{ at: number; share_price: number; equity: number }>;
}

export interface FillsReply {
  network: "mainnet" | "testnet" | "vault";
  strike_fills: string | null;
  fills: Fill[];
}

export interface RecordReply {
  network: "mainnet" | "testnet";
  live: LiveRecord | null;
  vault: VaultRecord | null;
  paper: (PaperSummary & { curve: Array<{ at: number; equity: number }> }) | null;
}

export interface CrowdResult {
  pnl: number;
  up: number;
  active: number;
}

export interface ScoreboardReply {
  since_record_start: {
    from: number;
    to: number;
    snapshots: number;
    copy: CrowdResult;
    fade: CrowdResult;
    markets: Array<{ symbol: string; copy: number; fade: number }>;
  } | null;
  before_record: {
    label: string;
    copy_picks: { group: string; active: number; up: number };
    fade_picks: { group: string; active: number; down: number };
  };
}

export interface ProofReply {
  rules: Array<{ version: number; sha256: string; published_commit: string; record_start: string }>;
  mapping: { version: number; fingerprint: string | null; markets_covered: number };
  snapshots_since_record_start: { complete: number; partial: number; interrupted: number };
  fees_saved: {
    computed_at: number;
    fromTs: number;
    toTs: number;
    capital: number;
    baseline: { subscriptions: number; perSubscriptionUsd: number; turnover: number; fees: number; orders: number };
    tug: { turnover: number; fees: number };
    saved: number;
  } | null;
  depth_added: {
    network: string;
    since: number | null;
    minutes_resting: number;
    markets: Array<{ symbol: string; minutes_resting: number; minutes_at_best: number; avg_share_of_best: number; avg_share_of_top5: number }>;
    maker_fills: number;
    fills: number;
    maker_volume: number;
    rebates: number;
  };
  evidence: { code: string; data: string };
}

export const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
