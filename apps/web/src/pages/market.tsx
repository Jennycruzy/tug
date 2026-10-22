import { useRoute } from "preact-iso";
import { ago, signed, time, usd, useApi, type MarketReply, type MemberRow, type Side } from "../api.js";
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
          <span>TUG live</span>
          <b>{sideWords(m.position.live)}</b>
          <span>
            <span class="tag">MODEL</span> position
          </span>
          <b>{sideWords(m.position.model)}</b>
          <span>The gap</span>
          <b>{signed(m.gap)}</b>
          <span>Why</span>
          <b>{why(m.reason, m.tradable)}</b>
        </div>
      </div>
      <h2>Who is pulling</h2>
      <div class="crowds">
        <Crowd title="Copy picks" cls="c-copy" s={m.copy} />
        <Crowd title="Fade picks" cls="c-fade" s={m.fade} />
      </div>
      <h2>Lean over the last 24 hours</h2>
      <History h={d.history} />
      <h2>Largest Hyperliquid members</h2>
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

/** Prices to six significant digits. */
const price = (v: number | null) => (v === null ? "—" : String(Number(v.toPrecision(6))));

function why(reason: string, tradable: boolean): string {
  if (!tradable) return "No clear gap: TUG holds nothing here";
  if (reason === "two_crowds") return "The two crowds pull opposite ways; TUG holds the copy picks' side";
  if (reason === "copy_only") return "Only the copy picks hold enough here, and they lean hard";
  return "Only the fade picks hold enough here, and they lean hard; TUG takes the other side";
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
        <span>Lean</span>
        <b>{s.n === 0 ? "—" : `${s.lean > 0 ? "long" : s.lean < 0 ? "short" : "even"} ${Math.round(Math.abs(s.lean) * 100)}%`}</b>
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
          long +1 at the top, short −1 at the bottom · {time(t0)} to {time(t1)}
        </span>
        <span>
          <i class="pin copy" /> copy picks{none("copy") ? " (none holding)" : ""} <i class="pin fade" /> fade picks
          {none("fade") ? " (none holding)" : ""}
        </span>
      </figcaption>
    </figure>
  );
}
