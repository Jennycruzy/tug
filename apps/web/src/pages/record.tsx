import { ago, day, signed, time, usd, useApi, type RecordReply } from "../api.js";

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
