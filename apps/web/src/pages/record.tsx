import { ago, day, signed, time, usd, useApi, type FillsReply, type LiveRecord, type RecordReply } from "../api.js";

const cents = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  const fills = useApi<FillsReply>("/api/v1/record/fills");
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
        <b>{l.realized === 0 ? "None closed yet" : `${l.realized > 0 ? "+" : "−"}${cents(Math.abs(l.realized)).replace("−", "")}`}</b>
        <span>Updated</span>
        <b>{ago(l.at, now)}</b>
      </div>
      <h2>Live equity</h2>
      <LineChart points={l.curve.map((c) => ({ at: c.at, v: c.equity }))} label="Live account equity over time" format={cents} />
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
                <td>{cents(x.upnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Fills</h2>
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
      <p class="fine">Fee shown as money received: a plus means Strike paid TUG a maker rebate.</p>
    </>
  );
}
