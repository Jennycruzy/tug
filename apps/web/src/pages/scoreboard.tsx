import { day, time, usd, useApi, type ScoreboardReply } from "../api.js";

const money = (v: number) => `${v >= 0 ? "+" : "−"}${usd(Math.abs(v))}`;

export function ScoreboardPage() {
  const load = useApi<ScoreboardReply>("/api/v1/scoreboard");
  return (
    <section class="page">
      <h1>Scoreboard</h1>
      <p class="lede">
        How the traders Strike tags copy and the traders it tags fade have done on Strike's markets, from their real
        positions marked to Strike's prices every 5 minutes.
      </p>
      {load.state === "loading" && <p class="note">Loading…</p>}
      {load.state === "error" && <p class="note err">{load.message}</p>}
      {load.state === "ok" && <Body d={load.data} />}
    </section>
  );
}

function Body({ d }: { d: ScoreboardReply }) {
  const s = d.since_record_start;
  const b = d.before_record;
  return (
    <>
      {s && (
        <>
          <h2>Since the record started</h2>
          <p class="updated">
            {time(s.from)} on {day(s.from)} to {time(s.to)} · {s.snapshots} snapshots
          </p>
          <div class="crowds">
            <div class="card">
              <h3 class="c-copy">Strike's copy picks</h3>
              <div class="kv">
                <span>Result</span>
                <b>{money(s.copy.pnl)}</b>
                <span>Up</span>
                <b>
                  {s.copy.up} of {s.copy.active}
                </b>
              </div>
            </div>
            <div class="card">
              <h3 class="c-fade">Strike's fade picks</h3>
              <div class="kv">
                <span>Result</span>
                <b>{money(s.fade.pnl)}</b>
                <span>Up</span>
                <b>
                  {s.fade.up} of {s.fade.active}
                </b>
              </div>
            </div>
          </div>
          <h2>By market</h2>
          <table class="members">
            <thead>
              <tr>
                <th>Market</th>
                <th>Copy picks</th>
                <th>Fade picks</th>
              </tr>
            </thead>
            <tbody>
              {[...s.markets]
                .sort((x, y) => Math.abs(y.copy) + Math.abs(y.fade) - Math.abs(x.copy) - Math.abs(x.fade))
                .map((m) => (
                  <tr key={m.symbol}>
                    <td>
                      <a href={`/m/${m.symbol}`}>{m.symbol}</a>
                    </td>
                    <td class="c-copy">{money(m.copy)}</td>
                    <td class="c-fade">{money(m.fade)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
      <h2>{b.label}</h2>
      <div class="card kv">
        <span>Copy picks</span>
        <b>
          {b.copy_picks.up} of {b.copy_picks.active} gained ({b.copy_picks.group})
        </b>
        <span>Fade picks</span>
        <b>
          {b.fade_picks.down} of {b.fade_picks.active} lost ({b.fade_picks.group})
        </b>
      </div>
      <p class="fine">Closed trades on Strike-listed markets in the 7 days before the record, from Hyperliquid fills.</p>
    </>
  );
}
