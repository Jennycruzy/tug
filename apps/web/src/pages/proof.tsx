import { day, time, usd, useApi, type ProofReply } from "../api.js";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function ProofPage() {
  const load = useApi<ProofReply>("/api/v1/proof", 300_000);
  return (
    <section class="page">
      <h1>Proof</h1>
      <p class="lede">
        Every number on this site is computed from recorded data with published code. The data is in a public repository,
        every file with its SHA-256, and anyone can recompute the records from it: in this browser, or with one command.
      </p>
      <p>
        <a class="btn primary" href="/check">
          Check it yourself in this browser
        </a>
      </p>
      {load.state === "loading" && <p class="note">Loading…</p>}
      {load.state === "error" && <p class="note err">{load.message}</p>}
      {load.state === "ok" && <Proof p={load.data} />}
    </section>
  );
}

function Proof({ p }: { p: ProofReply }) {
  const r = p.rules[0];
  const f = p.fees_saved;
  const d = p.depth_added;
  return (
    <>
      <h2>Rules published before the record</h2>
      {r && (
        <div class="card kv">
          <span>Rules</span>
          <b>version {r.version}</b>
          <span>SHA-256</span>
          <b>
            <code class="wrap">{r.sha256}</code>
          </b>
          <span>Published in</span>
          <b>
            <a href={`${p.evidence.code}/commit/${r.published_commit}`}>commit {r.published_commit}</a>
          </b>
          <span>Record since</span>
          <b>
            {time(Date.parse(r.record_start))} on {day(Date.parse(r.record_start))}
          </b>
          <span>Snapshots since</span>
          <b>
            {p.snapshots_since_record_start.complete.toLocaleString("en-US")} complete, {p.snapshots_since_record_start.partial} partial
          </b>
          <span>Markets covered</span>
          <b>{p.mapping.markets_covered}</b>
        </div>
      )}
      <p class="note small">The engine refuses to trade under any rules file whose fingerprint was not published first.</p>

      <h2>Fees: copying one by one vs TUG</h2>
      {f ? (
        <div class="card kv">
          <span>Copy picks</span>
          <b>{f.baseline.subscriptions} Strike copy subscriptions</b>
          <span>One by one</span>
          <b>
            {usd(f.baseline.fees)} in taker fees, {f.baseline.orders.toLocaleString("en-US")} orders
          </b>
          <span>TUG</span>
          <b>{f.tug.fees <= 0 ? `${usd(-f.tug.fees)} in maker rebates` : `${usd(f.tug.fees)} in fees`}</b>
          <span>Difference</span>
          <b>{usd(f.saved)} on {usd(f.capital)}</b>
        </div>
      ) : (
        <p class="note">Computed after the first snapshots.</p>
      )}
      <p class="note small">
        A lower bound, from the model account (labelled MODEL on the Record page): snapshots every 5 minutes undercount real
        copied fills.
      </p>

      <h2>Depth added on Strike's books</h2>
      <p class="note small">
        Each minute a TUG order waits on Strike's book, TUG reads the public book: is the order at the best price, and what
        share of the size there is TUG's. Measured on the live account{d.since ? ` since ${time(d.since)} on ${day(d.since)}` : ""}.
      </p>
      <div class="card kv">
        <span>Minutes resting</span>
        <b>{d.minutes_resting.toLocaleString("en-US")}</b>
        <span>Maker fills</span>
        <b>
          {d.maker_fills} of {d.fills}
        </b>
        <span>Maker volume</span>
        <b>{usd(d.maker_volume)}</b>
        <span>Rebates earned</span>
        <b>${d.rebates.toFixed(5)}</b>
      </div>
      {d.markets.length > 0 && (
        <div class="scroll">
          <table class="members">
            <thead>
              <tr>
                <th>Market</th>
                <th>Minutes</th>
                <th>At best price</th>
                <th>Share of best</th>
                <th>Share of top 5</th>
              </tr>
            </thead>
            <tbody>
              {d.markets.map((m) => (
                <tr key={m.symbol}>
                  <td>
                    <a href={`/m/${m.symbol}`}>{m.symbol.replace("-USD", "")}</a>
                  </td>
                  <td>{m.minutes_resting}</td>
                  <td>{m.minutes_at_best}</td>
                  <td>{pct(m.avg_share_of_best)}</td>
                  <td>{pct(m.avg_share_of_top5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Check it yourself</h2>
      <p>
        In this browser: <a href="/check">/check</a> downloads the evidence, checks every SHA-256, recomputes the records and
        re-reads TUG's fills from Strike. On your machine, with no key:
      </p>
      <pre class="code">{`git clone https://github.com/Jennycruzy/tug && cd tug
pnpm i --frozen-lockfile
pnpm verify`}</pre>
      <h2>Evidence</h2>
      <ul class="links">
        <li>
          <a href={p.evidence.code}>Code</a>: the engine, the rules file and its fingerprint
        </li>
        <li>
          <a href={p.evidence.data}>Data</a>: recorded inputs by day, updated every hour
        </li>
        <li>
          <a href="/api/v1/evidence/MANIFEST.sha256">MANIFEST.sha256</a>: every file of the evidence with its SHA-256
        </li>
        <li>
          <a href="/status">Status</a>: the engine's heartbeats, snapshots and errors
        </li>
      </ul>
    </>
  );
}
