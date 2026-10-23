import { useRoute } from "preact-iso";
import { ago, day, time, usd, useApi, type MarketReply, type MemberRow, type Side } from "../api.js";
import { useNow } from "../now.js";
import { Rope, sideWords } from "../rope.js";

export function MarketPage() {
  const { params } = useRoute();
  const symbol = (params.symbol ?? "").toUpperCase();
  const load = useApi<MarketReply>(`/api/v1/tug/${encodeURIComponent(symbol)}`);
  const now = useNow();
  return (
    <section class="page">
      <p class="crumb">
        <a href="/">← All ropes</a>
      </p>
      <h1>{symbol}</h1>
      {load.state === "loading" && <p class="note">Loading {symbol}…</p>}
      {load.state === "error" && <p class="note err">{load.message}</p>}
      {load.state === "ok" && <Body d={load.data} now={now} />}
    </section>
  );
}

function Body({ d, now }: { d: MarketReply; now: number }) {
  const m = d.market;
  return (
    <>
      <p class="updated">
        Snapshot {ago(d.snapshot.at, now)} ({time(d.snapshot.at)})
      </p>
      <div class="card">
        <Rope m={m} />
        <div class="kv">
          <span>Copy picks</span>
          <b class="c-copy">{leaning(m.copy)}</b>
          <span>Fade picks</span>
          <b class="c-fade">{leaning(m.fade)}</b>
          <span>TUG's side</span>
          <b>{why(m.reason, m.tradable)}</b>
          <span>How strong</span>
          <b>{m.tradable ? `${Math.round(Math.abs(m.gap) * 100)} out of 100` : "No trade here"}</b>
          <span>TUG now (real money)</span>
          <b>{sideWords(m.position.live)}</b>
          <span>Model account ($10,000)</span>
          <b>{sideWords(m.position.model)}</b>
        </div>
      </div>
      <h2>TUG's trades here</h2>
      <Trades t={d.trades} />
      <h2>Who is pulling</h2>
      <div class="crowds">
        <Crowd title="Copy picks" cls="c-copy" s={m.copy} />
        <Crowd title="Fade picks" cls="c-fade" s={m.fade} />
      </div>
      <h2>Which way each group leaned, last 24 hours</h2>
      <History h={d.history} />
      <h2>Biggest positions here (Hyperliquid traders)</h2>
      <div class="crowds">
        <Members title="Copy picks" rows={d.top.copy} />
        <Members title="Fade picks" rows={d.top.fade} />
      </div>
      <h2>Strike's own traders</h2>
      <div class="crowds">
        <div>
          <h3 class="c-copy">Copy picks</h3>
          {d.strike.copy.length === 0 ? (
            <p class="note">None holding {m.symbol}.</p>
          ) : (
            <MemberTable rows={d.strike.copy} label="Strike trader" />
          )}
        </div>
        <div>
          <h3 class="c-fade">Fade picks</h3>
          <p class="note">
            {d.strike.fade.n === 0
              ? `None holding ${m.symbol}.`
              : d.strike.fade.net === null
                ? `${d.strike.fade.n} holding. Their size is shown only when at least three hold this market.`
                : `${d.strike.fade.n} holding, net ${d.strike.fade.net >= 0 ? "long" : "short"} ${usd(Math.abs(d.strike.fade.net))}. Shown as a total only.`}
          </p>
        </div>
      </div>
      <h2>Strike market</h2>
      <div class="kv card">
        <span>Mark</span>
        <b>{price(m.mark)}</b>
        <span>Best bid / ask</span>
        <b>
          {price(m.bid)} / {price(m.ask)}
        </b>
        <span>Funding rate (Strike, latest)</span>
        <b>{m.funding_rate === null ? "—" : `${(m.funding_rate * 100).toFixed(4)}%`}</b>
      </div>
    </>
  );
}

/** "87% short", "all long", "even", or "none holding". */
function leaning(s: Side): string {
  if (s.n === 0) return "none holding";
  const p = Math.round(Math.abs(s.lean) * 100);
  if (p === 0) return "even";
  return p === 100 ? `all ${s.lean > 0 ? "long" : "short"}` : `${p}% ${s.lean > 0 ? "long" : "short"}`;
}

/** TUG's live fills in this market, newest first, each with the line its order was placed for. */
function Trades({ t }: { t: MarketReply["trades"] }) {
  if (t.length === 0) return <p class="note">No live trades in this market yet.</p>;
  return (
    <div class="scroll">
      <table class="members">
        <thead>
          <tr>
            <th>When</th>
            <th>Trade</th>
            <th>Fee</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {t.map((x) => (
            <tr key={`${x.order_id}-${x.at}`}>
              <td>
                {time(x.at)} {day(x.at).slice(5)}
              </td>
              <td>
                {x.side === "buy" ? "Bought" : "Sold"} {x.size} at {x.price}
                {x.role === "maker" ? " (waited in the book)" : ""}
              </td>
              <td class={x.fee < 0 ? "ok" : ""}>{x.fee < 0 ? `+$${(-x.fee).toFixed(5)} rebate` : `$${x.fee.toFixed(5)}`}</td>
              <td>{x.why ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Prices to six significant digits. */
const price = (v: number | null) => (v === null ? "—" : String(Number(v.toPrecision(6))));

function why(reason: string, tradable: boolean): string {
  if (!tradable) return "None: the two groups don't pull clearly apart here";
  if (reason === "two_crowds") return "With the copy picks: the two groups pull opposite ways";
  if (reason === "copy_only") return "With the copy picks: few fade picks hold it, and the copy picks lean hard one way";
  return "Against the fade picks: few copy picks hold it, and the fade picks lean hard one way";
}

function Crowd({ title, cls, s }: { title: string; cls: string; s: Side }) {
  return (
    <div class="card">
      <h3 class={cls}>{title}</h3>
      <div class="kv">
        <span>Holding</span>
        <b>{s.n}</b>
        <span>Long</span>
        <b>{usd(s.long)}</b>
        <span>Short</span>
        <b>{usd(s.short)}</b>
        <span>Leaning</span>
        <b>{leaning(s)}</b>
      </div>
    </div>
  );
}

function Members({ title, rows }: { title: string; rows: MemberRow[] }) {
  return (
    <div>
      <h3 class={title.startsWith("Copy") ? "c-copy" : "c-fade"}>{title}</h3>
      {rows.length === 0 ? <p class="note">None holding.</p> : <MemberTable rows={rows} />}
    </div>
  );
}

function MemberTable({ rows, label }: { rows: MemberRow[]; label?: string }) {
  return (
    <table class="members">
      <thead>
        <tr>
          <th>Trader</th>
          <th>Position</th>
          <th>Strike score</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>
              <code>{label ? `${label} ${r.id}` : r.id}</code>
            </td>
            <td>{`${r.notional >= 0 ? "Long" : "Short"} ${usd(Math.abs(r.notional))}`}</td>
            <td>{r.score === null ? "—" : Math.round(r.score)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Two lines over 24 h, lean from −1 (short) to +1 (long), from stored snapshots only. */
function History({ h }: { h: MarketReply["history"] }) {
  if (h.length < 2) return <p class="note">The chart fills in as snapshots arrive (one every 5 minutes).</p>;
  const W = 600;
  const H = 160;
  const t0 = h[0]!.at;
  const t1 = h[h.length - 1]!.at;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => ((1 - v) / 2) * H;
  // A crowd holding nothing has no lean: the line breaks there instead of reading as an even split at 0.
  const path = (k: "copy" | "fade") => {
    let pen = false;
    return h
      .map((p) => {
        if (p[`n_${k}`] === 0) return ((pen = false), "");
        const cmd = `${pen ? "L" : "M"}${x(p.at).toFixed(1)},${y(p[`lean_${k}`]).toFixed(1)}`;
        pen = true;
        return cmd;
      })
      .join(" ");
  };
  const none = (k: "copy" | "fade") => h.every((p) => p[`n_${k}`] === 0);
  return (
    <figure class="chart card">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Lean of each crowd over the last 24 hours">
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} class="axis" />
        <path d={path("copy")} class="ln copy" />
        <path d={path("fade")} class="ln fade" />
      </svg>
      <figcaption>
        <span>
          all long at the top, all short at the bottom · {time(t0)} to {time(t1)}
        </span>
        <span>
          <i class="pin copy" /> copy picks{none("copy") ? " (none holding)" : ""} <i class="pin fade" /> fade picks
          {none("fade") ? " (none holding)" : ""}
        </span>
      </figcaption>
    </figure>
  );
}
