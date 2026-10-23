/**
 * The public API's OpenAPI 3.1 document. Tests check every live reply against these schemas, so the
 * document and the server cannot drift apart.
 */
type Schema = Record<string, unknown>;

const num: Schema = { type: "number" };
const int: Schema = { type: "integer" };
const str: Schema = { type: "string" };
const bool: Schema = { type: "boolean" };
const nullable = (s: Schema): Schema => ({ ...s, type: [s.type as string, "null"] });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const arr = (items: Schema): Schema => ({ type: "array", items });
const nullOr = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });

const paperSummary: Record<string, Schema> = {
  label: { type: "string", enum: ["MODEL"] },
  start_equity: num,
  start: int,
  at: int,
  snapshot_id: int,
  equity: num,
  turnover: num,
  fees: num,
  funding: num,
  positions: arr(obj({ symbol: str, notional: num })),
};

const schemas: Record<string, Schema> = {
  Error: obj({ code: str, message: str }),
  Side: obj({ long: num, short: num, lean: num, n: int }),
  Position: obj({ side: { type: "string", enum: ["long", "short", "flat"] }, notional: num }),
  Market: obj({
    symbol: str,
    copy: ref("Side"),
    fade: ref("Side"),
    gap: num,
    tradable: bool,
    reason: { type: "string", enum: ["two_crowds", "copy_only", "fade_only", "none"] },
    mark: nullable(num),
    funding_rate: nullable(num),
    bid: nullable(num),
    ask: nullable(num),
    position: obj({ live: ref("Position"), model: ref("Position") }),
  }),
  Member: obj({ id: str, notional: num, score: nullable(num) }),
  Tug: obj({
    network: str,
    snapshot: obj({ id: int, at: int, finished_at: nullable(int), read_copy: nullable(num), read_fade: nullable(num) }),
    rules: obj({ version: int, sha256: str, record_start: int }),
    crowds: nullOr(obj({ id: int, pulled_at: int, copy_count: int, fade_count: int, member_hash: str })),
    model: nullOr(obj({ equity: num, start_equity: num, at: int })),
    live: obj({ trading: bool, account: nullable(str) }),
    markets: arr(ref("Market")),
  }),
  TugMarket: obj({
    network: str,
    snapshot: obj({ id: int, at: int }),
    market: ref("Market"),
    top: obj({ copy: arr(ref("Member")), fade: arr(ref("Member")) }),
    strike: obj({ copy: arr(ref("Member")), fade: obj({ n: int, net: nullable(num) }) }),
    history: arr(obj({ at: int, lean_copy: num, lean_fade: num, n_copy: int, n_fade: int, gap: num })),
  }),
  Crowds: obj({
    network: str,
    version: obj({ id: int, pulled_at: int, member_hash: str, raw_sha256: str }),
    counts: obj({
      copy: obj({ total: int, hyperliquid: int, strike: int }),
      fade: obj({ total: int, hyperliquid: int, strike: int }),
    }),
    score_range: obj({ copy: nullOr(obj({ min: num, max: num })), fade: nullOr(obj({ min: num, max: num })) }),
    members: obj({
      hyperliquid: arr(obj({ address: str, crowd: { type: "string", enum: ["copy", "fade"] }, score: nullable(num) })),
      strike_copy: arr(obj({ id: str, score: nullable(num) })),
      strike_fade: obj({ n: int }),
    }),
  }),
  RecordPaper: obj({ ...paperSummary, curve: arr(obj({ at: int, equity: num })) }),
  RecordLive: obj({
    label: { type: "string", enum: ["LIVE", "TESTNET"] },
    account: nullable(str),
    start_equity: num,
    start: int,
    at: int,
    equity: num,
    fills: int,
    maker_fills: int,
    traded: num,
    fees: num,
    realized: num,
    positions: arr(obj({ symbol: str, size: num, entry: num, upnl: num })),
    money_moves: arr(obj({ at: int, type: { type: "string", enum: ["deposit", "withdraw"] }, amount: num, tx_hash: nullable(str) })),
    links: nullOr(obj({ strike_page: str, strike_fills: str, strike_positions: str, strike_deposits: str })),
    curve: arr(obj({ at: int, equity: num, put_in: num, result: num })),
  }),
  Fill: obj({
    at: int,
    symbol: str,
    side: str,
    role: nullable(str),
    price: num,
    size: num,
    fee: num,
    realized: num,
    order_id: nullable(int),
    client_order_id: nullable(str),
  }),
  RecordVault: obj({
    label: { type: "string", enum: ["TESTNET"] },
    vault_id: str,
    name: str,
    status: str,
    lockup_days: nullable(int),
    leader_fee_bps: nullable(int),
    start: int,
    at: int,
    share_price: num,
    start_share_price: num,
    equity: num,
    total_shares: num,
    fills: int,
    maker_fills: int,
    traded: num,
    fees: num,
    realized: num,
    positions: arr(obj({ symbol: str, size: num, entry: num, upnl: num })),
    moves: arr(
      obj({
        id: str,
        type: { type: "string", enum: ["deposit", "withdrawal"] },
        who: { type: "string", enum: ["leader", "depositor"] },
        account: nullable(str),
        status: str,
        at: int,
        usd: nullable(num),
        shares: nullable(num),
        share_price: nullable(num),
        execute_at: nullable(int),
        executed_at: nullable(int),
      }),
    ),
    links: obj({ strike_vault_page: str, strike_vault: str, strike_history: str, strike_fills: str, strike_positions: str }),
    curve: arr(obj({ at: int, share_price: num, equity: num })),
  }),
  Record: obj({
    network: { type: "string", enum: ["mainnet", "testnet"] },
    live: nullOr(ref("RecordLive")),
    vault: nullOr(ref("RecordVault")),
    paper: nullOr(ref("RecordPaper")),
  }),
  Fills: obj({ network: { type: "string", enum: ["mainnet", "testnet", "vault"] }, strike_fills: nullable(str), fills: arr(ref("Fill")) }),
  Paper: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...paperSummary,
      last_rebalance: nullOr(obj({ snapshot_id: int, targets: arr(obj({ symbol: str, target: num })) })),
      curve: arr(obj({ snapshot_id: int, at: int, equity: num, turnover: num, fees: num, funding: num })),
    },
    required: ["last_rebalance", "curve"],
  },
  Scoreboard: obj({
    since_record_start: nullOr(
      obj({
        from: int,
        to: int,
        snapshots: int,
        copy: obj({ pnl: num, up: int, active: int }),
        fade: obj({ pnl: num, up: int, active: int }),
        markets: arr(obj({ symbol: str, copy: num, fade: num })),
      }),
    ),
    before_record: {
      type: "object",
      required: ["label", "copy_picks", "fade_picks"],
      properties: { label: str, copy_picks: { type: "object" }, fade_picks: { type: "object" } },
    },
  }),
  Proof: obj({
    rules: arr({ type: "object", required: ["version", "sha256", "record_start"], properties: { version: int, sha256: str, record_start: str } }),
    mapping: obj({ version: int, fingerprint: nullable(str), markets_covered: int }),
    snapshots_since_record_start: obj({ complete: int, partial: int, interrupted: int }),
    fees_saved: nullOr({
      type: "object",
      required: ["computed_at"],
      properties: {
        computed_at: int,
        capital: num,
        saved: num,
        baseline: { type: "object", properties: { subscriptions: int, turnover: num, fees: num, orders: int, unsized: int } },
        tug: { type: "object", properties: { turnover: num, fees: num } },
      },
    }),
    depth_added: obj({
      network: str,
      since: nullable(int),
      minutes_resting: int,
      markets: arr(obj({ symbol: str, minutes_resting: int, minutes_at_best: int, avg_share_of_best: num, avg_share_of_top5: num })),
      maker_fills: int,
      fills: int,
      maker_volume: num,
      rebates: num,
    }),
    evidence: obj({ code: str, data: str }),
  }),
  Status: obj({
    network: str,
    now: int,
    engine: obj({ started_at: int, revision: str, rules_sha256: str }),
    recorder: obj({
      last_complete: nullOr(obj({ id: int, at: int, finished_at: nullable(int), read_copy: nullable(num), read_fade: nullable(num) })),
      recent: arr(obj({ id: int, at: int, status: str, errors: int })),
    }),
    crowds: nullOr(obj({ id: int, pulled_at: int, copy_count: int, fade_count: int })),
    trading: obj({
      mainnet: { type: "string", enum: ["on", "off"] },
      kill_switch: obj({ mainnet: { type: "string", enum: ["on", "off"] }, testnet: { type: "string", enum: ["on", "off"] }, vault: { type: "string", enum: ["on", "off"] } }),
    }),
    orders: obj({
      open: { type: "object", additionalProperties: int },
      recent: arr(
        obj({
          client_order_id: str,
          network: str,
          order_id: nullable(int),
          symbol: str,
          side: str,
          price: str,
          size: str,
          status: str,
          placed_at: int,
          updated_at: int,
        }),
      ),
    }),
    errors_24h: obj({
      warn: int,
      error: int,
      recent: arr(obj({ ts: int, network: nullable(str), component: str, level: str, code: nullable(str), message: str })),
    }),
  }),
};

const ok = (schema: string, description: string) => ({
  description,
  content: { "application/json": { schema: ref(schema) } },
});
const err = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });
const networkParam = { name: "network", in: "query", required: false, schema: { type: "string", enum: ["mainnet", "testnet"], default: "mainnet" } };

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "TUG public API",
    version: "1",
    description:
      "Strike's copy picks and fade picks, market by market, and where TUG stands. Free, no key, 60 requests per minute per IP. Every reply comes from stored snapshots taken every 5 minutes.",
  },
  servers: [{ url: "https://tug.38-49-216-59.sslip.io" }],
  paths: {
    "/api/v1/tug": { get: { summary: "Every market: both crowds, the gap, TUG's position", responses: { "200": ok("Tug", "Latest complete snapshot"), "503": err("No snapshot yet") } } },
    "/api/v1/tug/{symbol}": {
      get: {
        summary: "One market with 24 hours of lean history",
        parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string", example: "ETH-USD" } }],
        responses: { "200": ok("TugMarket", "One market"), "400": err("Not a market symbol"), "404": err("Not a market TUG reads"), "503": err("No snapshot yet") },
      },
    },
    "/api/v1/crowds": { get: { summary: "The current crowd lists from Strike's own scores", responses: { "200": ok("Crowds", "Current crowd version"), "503": err("No crowd list yet") } } },
    "/api/v1/record": { get: { summary: "Records: live account, vault and the paper record (MODEL)", parameters: [networkParam], responses: { "200": ok("Record", "Records"), "400": err("Unknown network") } } },
    "/api/v1/record/fills": { get: { summary: "Fills with Strike order ids (network=vault: the testnet vault's fills)", parameters: [{ ...networkParam, schema: { type: "string", enum: ["mainnet", "testnet", "vault"], default: "mainnet" } }], responses: { "200": ok("Fills", "Fills"), "400": err("Unknown network") } } },
    "/api/v1/paper": { get: { summary: "The paper record (MODEL): equity, turnover, fees, funding, targets", responses: { "200": ok("Paper", "Paper record") } } },
    "/api/v1/scoreboard": { get: { summary: "How Strike's copy picks and fade picks have done since the record started", responses: { "200": ok("Scoreboard", "Scoreboard") } } },
    "/api/v1/proof": { get: { summary: "Rules fingerprint, mapping, fees saved, evidence links", responses: { "200": ok("Proof", "Proof") } } },
    "/api/v1/evidence/{path}": {
      get: {
        summary: "One file of the evidence bundle (MANIFEST.sha256, or a file it lists), byte for byte",
        parameters: [{ name: "path", in: "path", required: true, schema: str }],
        responses: { "200": { description: "The file", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, "404": err("Not a file of the bundle") },
      },
    },
    "/api/v1/status": { get: { summary: "Engine heartbeats, snapshots, orders and errors", responses: { "200": ok("Status", "Status") } } },
  },
  components: { schemas },
} as const;

export const LLMS_TXT = `# TUG on Strike

TUG reads Strike's own trader scores, adds up the live positions of the traders Strike says to copy (copy
picks) and the traders Strike says to fade (fade picks), and holds the difference on Strike with orders
that wait in the book. This file tells software agents how to read TUG's free public data.

Base URL: https://tug.38-49-216-59.sslip.io
No key. 60 requests per minute per IP. Data refreshes every 5 minutes; polling faster returns the same reply.
OpenAPI 3.1: https://tug.38-49-216-59.sslip.io/api/openapi.json

## Endpoints
- GET /api/v1/tug: every Strike market. For each: copy picks and fade picks (long $, short $, lean from -1
  to +1, members holding), the gap, whether TUG trades it, and TUG's position. Sorted by the size of the gap.
- GET /api/v1/tug/ETH-USD: one market, the largest members, and 24 hours of lean history.
- GET /api/v1/crowds: the current crowd lists, built from Strike's /v2/copy/discover scores and tags.
- GET /api/v1/record: records. "live" is the real account (label LIVE on mainnet, TESTNET on testnet): equity, fills,
  fees (negative = maker rebate), realized result, positions, money put in (Strike's own deposit records), a curve
  whose "result" is equity minus money put in so far, and links to Strike's public records of the account. "paper" is labelled MODEL: a calculation from real
  Strike prices, not trades.
- GET /api/v1/record/fills: the live account's fills, newest first, with Strike order ids (fee negative = rebate).
  ?network=vault: the testnet vault's fills. GET /api/v1/record also carries "vault" (TESTNET): share price each
  minute, every deposit and withdrawal with its status, and links to Strike's public vault records.
- GET /api/v1/paper: the paper record (MODEL) with the targets of the last rebalance.
- GET /api/v1/scoreboard: how Strike's copy picks and fade picks did since the record started, per market.
- GET /api/v1/proof: the rules fingerprint (SHA-256, published before the record started), the market
  mapping, snapshot counts, fees saved, and depth added: each minute a TUG order rests on Strike's book, its
  share of the size at the best price and in the top 5 levels; plus maker fills, maker volume and rebates.
- GET /api/v1/evidence/MANIFEST.sha256 and /api/v1/evidence/<path>: the evidence bundle file by file, the same
  bytes as the tug-evidence repository; "pnpm verify" and the /check page recompute every record from it.
- GET /api/v1/status: heartbeats, recent snapshots, orders and errors.

## Words
- lean: (long - short) / (long + short) for a crowd in one market; +1 all long, -1 all short.
- gap: half the difference between the copy picks' lean and the fade picks' lean. TUG trades only where
  the gap is large and the two crowds pull opposite ways, on the copy picks' side.
- MODEL: computed from real prices, not real trades. TESTNET: Strike's test network with test money.

Built on Strike's public API. Not investment advice. Perpetuals can lose all deposited funds.
`;
