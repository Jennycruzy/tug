import { ago, day, signed, time, usd, useApi, type FillsReply, type LiveRecord, type RecordReply, type VaultRecord } from "../api.js";

/** Dollars and cents; a value that rounds to zero cents shows as $0.00, never −$0.00. */
const cents = (v: number) => `${v <= -0.005 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedCents = (v: number) => (Math.abs(v) < 0.005 ? "$0.00" : `${v > 0 ? "+" : "−"}${cents(Math.abs(v))}`);
import { LineChart } from "../chart.js";
import { useNow } from "../now.js";

export function RecordPage() {
  const load = useApi<RecordReply>("/api/v1/record");
  const now = useNow();
  return (
    <section class="page">
      <h1>Record</h1>
      {load.state === "loading" && <p class="note">Loading…</p>}
      {load.state === "error" && <p class="note err">{load.message}</p>}
      {load.state === "ok" && load.data.live && <Live l={load.data.live} now={now} />}
      {load.state === "ok" && load.data.vault && <Vault v={load.data.vault} now={now} />}
      {load.state === "ok" && load.data.paper && <Paper p={load.data.paper} now={now} />}
      {load.state === "ok" && !load.data.paper && <p class="note">The paper record starts with the first complete snapshot.</p>}
    </section>
  );
}

function Paper({ p, now }: { p: NonNullable<RecordReply["paper"]>; now: number }) {
  const change = p.equity - p.start_equity;
  return (
    <>
      <h2>
        <span class="tag">MODEL</span> Paper record
      </h2>
      <p class="lede">
        A $10,000 model account that follows TUG's targets at every rebalance (every 15 minutes), filled at Strike's
        mid price with the maker fee and charged Strike's hourly funding. Computed from real Strike prices; not real
        trades. It started when the rules were published, {time(p.start)} on {day(p.start)}.
      </p>
      <div class="card kv">
        <span>Equity</span>
        <b>
          {cents(p.equity)} ({signed((change / p.start_equity) * 100)}%)
        </b>
        <span>Started with</span>
        <b>{cents(p.start_equity)}</b>
        <span>Traded</span>
        <b>{usd(p.turnover)}</b>
        <span>Maker fees</span>
        <b>{p.fees <= 0 ? `${cents(-p.fees)} rebate earned` : `${cents(p.fees)} paid`}</b>
        <span>Funding</span>
        <b>{p.funding >= 0 ? `${cents(p.funding)} received` : `${cents(-p.funding)} paid`}</b>
        <span>Updated</span>
        <b>
          {ago(p.at, now)} (snapshot #{p.snapshot_id})
        </b>
      </div>
      <h2>Equity since the start</h2>
      <LineChart points={p.curve.map((c) => ({ at: c.at, v: c.equity }))} label="Paper record equity over time" format={usd} />
      <h2>Positions now</h2>
      {p.positions.length === 0 ? (
        <p class="note">Flat.</p>
      ) : (
        <table class="members">
          <thead>
            <tr>
              <th>Market</th>
              <th>Position</th>
            </tr>
          </thead>
          <tbody>
            {p.positions.map((x) => (
              <tr key={x.symbol}>
                <td>
                  <a href={`/m/${x.symbol}`}>{x.symbol}</a>
                </td>
                <td>{`${x.notional > 0 ? "Long" : "Short"} ${usd(Math.abs(x.notional))}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Small amounts (a rebate is a fraction of a cent) keep enough digits to be seen. */
const fine = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v) < 0.01 ? Math.abs(v).toFixed(5) : Math.abs(v).toFixed(2)}`;

function Live({ l, now }: { l: LiveRecord; now: number }) {
  const change = l.equity - l.start_equity;
  return (
    <>
      <h2>
        <span class="tag live">{l.label}</span> {l.label === "LIVE" ? "Live account, real money" : "Test account"}
      </h2>
      <p class="lede">
        TUG's own Strike account{l.account ? <> (<code>{l.account}</code>, nickname tug-mainnet)</> : null}, trading by the published rules
        since {time(l.start)} on {day(l.start)}. The result is measured against all the money put in, top-ups included.
        Every number here comes from Strike's replies, stored as they arrived.
      </p>
      <div class="card kv">
        <span>Equity</span>
        <b>
          {cents(l.equity)} ({signed((change / l.start_equity) * 100)}%)
        </b>
        <span>Result</span>
        <b>{signedCents(change)}</b>
        <span>Money put in</span>
        <b>{cents(l.start_equity)}</b>
        <span>Fills</span>
        <b>
          {l.fills} ({l.maker_fills} as maker)
        </b>
        <span>Traded</span>
        <b>{cents(l.traded)}</b>
        <span>Fees</span>
        <b>{l.fees <= 0 ? `${fine(-l.fees)} rebate earned` : `${fine(l.fees)} paid`}</b>
        <span>Closed trades</span>
        <b>{l.realized === 0 ? "None closed yet" : signedCents(l.realized)}</b>
        <span>Updated</span>
        <b>{ago(l.at, now)}</b>
      </div>
      {l.links && (
        <p class="strike-links">
          On Strike: <a href={l.links.strike_page}>TUG's public trader page</a> · <a href={l.links.strike_fills}>fills</a> ·{" "}
          <a href={l.links.strike_positions}>positions</a> · <a href={l.links.strike_deposits}>deposits</a>
        </p>
      )}
      <h2>Result over time</h2>
      <p class="note small">Equity minus the money put in up to that moment, so a top-up is never drawn as a gain.</p>
      <LineChart points={l.curve.map((c) => ({ at: c.at, v: c.result }))} label="Live result over time: equity minus money put in" format={signedCents} />
      {l.money_moves.length > 0 && (
        <>
          <h2>Money put in</h2>
          <table class="members">
            <thead>
              <tr>
                <th>Time</th>
                <th>Amount</th>
                <th>Cardano transaction</th>
              </tr>
            </thead>
            <tbody>
              {l.money_moves.map((m) => (
                <tr key={`${m.at}-${m.amount}`}>
                  <td>
                    {time(m.at)} {day(m.at).slice(5)}
                  </td>
                  <td>
                    {m.type === "deposit" ? "Deposit" : "Withdrawal"} {cents(Math.abs(m.amount))}
                  </td>
                  <td>
                    {m.tx_hash ? (
                      <a href={`https://cardanoscan.io/transaction/${m.tx_hash.split("#")[0]}`}>
                        <code>{m.tx_hash.slice(0, 10)}…</code>
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Live positions</h2>
      {l.positions.length === 0 ? (
        <p class="note">Flat: no open position.</p>
      ) : (
        <table class="members">
          <thead>
            <tr>
              <th>Market</th>
              <th>Position</th>
              <th>Entry</th>
              <th>Open result</th>
            </tr>
          </thead>
          <tbody>
            {l.positions.map((x) => (
              <tr key={x.symbol}>
                <td>
                  <a href={`/m/${x.symbol}`}>{x.symbol}</a>
                </td>
                <td>{`${x.size > 0 ? "Long" : "Short"} ${Math.abs(x.size)}`}</td>
                <td>{x.entry}</td>
                <td>{signedCents(x.upnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Fills</h2>
      <FillsTable path="/api/v1/record/fills" />
      <p class="fine">Fee shown as money received: a plus means Strike paid TUG a maker rebate.</p>
    </>
  );
}

/** Every fill of one account, newest first, with its fee (a plus is a maker rebate received). */
function FillsTable({ path }: { path: string }) {
  const fills = useApi<FillsReply>(path);
  return (
    <>
      {fills.state === "ok" && fills.data.fills.length > 0 ? (
        <div class="scroll">
          <table class="members">
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Side</th>
                <th>Price</th>
                <th>Size</th>
                <th>Fee</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {fills.data.fills.map((f) => (
                <tr key={`${f.order_id}-${f.at}`}>
                  <td>
                    {time(f.at)} {day(f.at).slice(5)}
                  </td>
                  <td>{f.symbol.replace("-USD", "")}</td>
                  <td>
                    {f.side === "buy" ? "Buy" : "Sell"}
                    {f.role === "maker" ? " · maker" : f.role ? ` · ${f.role}` : ""}
                  </td>
                  <td>{f.price}</td>
                  <td>{f.size}</td>
                  <td class={f.fee < 0 ? "ok" : ""}>{f.fee < 0 ? `+${fine(-f.fee)}` : fine(-f.fee)}</td>
                  <td>{f.realized === 0 ? "—" : cents(f.realized)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="note">{fills.state === "loading" ? "Loading fills…" : "No fills yet."}</p>
      )}
    </>
  );
}

function Vault({ v, now }: { v: VaultRecord; now: number }) {
  const change = v.share_price / v.start_share_price - 1;
  const moveUsd = (m: VaultRecord["moves"][number]) => (m.usd === null ? "—" : cents(m.usd));
  return (
    <>
      <h2 id="vault">
        <span class="tag">TESTNET</span> TUG as a Strike vault
      </h2>
      <p class="lede">
        The same engine and rules trading a Strike vault on testnet ({v.positions.length ? v.positions.map((p) => p.symbol).join(", ") : "ETH-USD"}). Anyone with a
        testnet account can deposit; each deposit buys shares at the share price of that moment, and a withdrawal is paid
        {v.lockup_days ? ` ${v.lockup_days} day${v.lockup_days === 1 ? "" : "s"}` : ""} after it is asked for, at the share price then. Test money, not real money.
      </p>
      <div class="card kv">
        <span>Share price</span>
        <b>
          {v.share_price.toFixed(4)} ({signed(change * 100)}%)
        </b>
        <span>Vault equity</span>
        <b>{cents(v.equity)}</b>
        <span>Shares</span>
        <b>{v.total_shares.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>
        <span>Fills</span>
        <b>
          {v.fills} ({v.maker_fills} as maker)
        </b>
        <span>Fees</span>
        <b>{v.fills === 0 ? "No fills yet" : v.fees === 0 ? "$0.00 (no fee on testnet)" : v.fees < 0 ? `${fine(-v.fees)} rebate earned` : `${fine(v.fees)} paid`}</b>
        <span>Leader fee</span>
        <b>{v.leader_fee_bps === null ? "—" : `${v.leader_fee_bps / 100}% of depositors' profit`}</b>
        <span>Updated</span>
        <b>{ago(v.at, now)}</b>
      </div>
      <p class="strike-links">
        On Strike testnet: <a href={v.links.strike_vault_page}>the vault's page</a> · <a href={v.links.strike_vault}>share price</a> ·{" "}
        <a href={v.links.strike_history}>deposits and withdrawals</a> · <a href={v.links.strike_fills}>fills</a> · <a href={v.links.strike_positions}>positions</a>
      </p>
      <h2>Share price over time</h2>
      <LineChart points={v.curve.map((c) => ({ at: c.at, v: c.share_price }))} label="Vault share price over time" format={(x) => x.toFixed(4)} />
      <h2>Deposits and withdrawals</h2>
      <table class="members">
        <thead>
          <tr>
            <th>Time</th>
            <th>What</th>
            <th>Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {v.moves.map((m) => (
            <tr key={m.id}>
              <td>
                {time(m.at)} {day(m.at).slice(5)}
              </td>
              <td>
                {m.type === "deposit" ? "Deposit" : "Withdrawal"} by {m.who === "leader" ? "TUG (leader)" : <code>{m.account ?? "a depositor"}</code>}
              </td>
              <td>
                {moveUsd(m)}
                {m.shares !== null ? ` · ${m.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })} shares` : ""}
              </td>
              <td>
                {m.status === "pending" && m.execute_at
                  ? `Pending: paid ${time(m.execute_at)} on ${day(m.execute_at)}`
                  : m.status === "completed"
                    ? m.type === "withdrawal" && m.executed_at
                      ? `Paid ${time(m.executed_at)} ${day(m.executed_at).slice(5)}`
                      : "Done"
                    : m.status}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Vault positions</h2>
      {v.positions.length === 0 ? (
        <p class="note">Flat: no open position.</p>
      ) : (
        <table class="members">
          <thead>
            <tr>
              <th>Market</th>
              <th>Position</th>
              <th>Entry</th>
              <th>Open result</th>
            </tr>
          </thead>
          <tbody>
            {v.positions.map((x) => (
              <tr key={x.symbol}>
                <td>{x.symbol}</td>
                <td>{`${x.size > 0 ? "Long" : "Short"} ${Math.abs(x.size)}`}</td>
                <td>{x.entry}</td>
                <td>{signedCents(x.upnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Vault fills</h2>
      <FillsTable path="/api/v1/record/fills?network=vault" />
    </>
  );
}
