import { ago, time, usd, useApi, type Market, type TugReply } from "../api.js";
import { useNow } from "../now.js";
import { netWords, Rope, ropeLabel, sideWords } from "../rope.js";

const REASON: Record<Market["reason"], string> = {
  two_crowds: "The crowds pull opposite ways",
  copy_only: "Copy picks only, leaning hard",
  fade_only: "Fade picks only, leaning hard",
  none: "No clear gap",
};

function RopeRow({ m }: { m: Market }) {
  return (
    <a class={`row ${m.tradable ? "live" : "quiet"}`} href={`/m/${m.symbol}`} aria-label={`${ropeLabel(m)}. TUG ${sideWords(m.position.live)}. Open ${m.symbol}.`}>
      <div class="row-head">
        <span class="sym">{m.symbol.replace("-USD", "")}</span>
        <span class="why">{REASON[m.reason]}</span>
        <span class="tug">
          TUG <b>{sideWords(m.position.live)}</b>
        </span>
      </div>
      <Rope m={m} />
      <div class="row-foot">
        <span class="c-copy">
          Copy picks {m.copy.n} · {netWords(m.copy)}
        </span>
        <span class="c-fade">
          Fade picks {m.fade.n} · {netWords(m.fade)}
        </span>
      </div>
      <div class="row-model">
        <span class="tag">MODEL</span> {sideWords(m.position.model)}
      </div>
    </a>
  );
}

export function Home() {
  const load = useApi<TugReply>("/api/v1/tug");
  const now = useNow();
  return (
    <section class="page">
      <h1 class="line">Strike already knows who wins and who loses. TUG trades the gap.</h1>
      <p class="lede">
        Each rope is one Strike market. Strike's copy picks pull one way and its fade picks the other; where they pull
        opposite ways, TUG holds the copy picks' side with orders that wait in the book.
      </p>
      <Legend />
      {load.state === "loading" && <p class="note">Loading the latest snapshot…</p>}
      {load.state === "error" && <p class="note err">{load.message}</p>}
      {load.state === "ok" && <Ropes data={load.data} now={now} />}
    </section>
  );
}

function Legend() {
  return (
    <div class="legend" aria-hidden="true">
      <span>
        <i class="pin copy" /> copy picks
      </span>
      <span>
        <i class="pin fade" /> fade picks
      </span>
      <span>
        <i class="knot" /> the gap
      </span>
      <span class="ends">
        short <span class="arrow">◀ ▶</span> long
      </span>
    </div>
  );
}

function Ropes({ data, now }: { data: TugReply; now: number }) {
  const live = data.markets.filter((m) => m.tradable).length;
  return (
    <>
      <p class="updated">
        Updated {ago(data.snapshot.at, now)} ({time(data.snapshot.at)}) · {data.markets.length} markets · gap in {live}
        {data.crowds && (
          <>
            {" "}
            · {data.crowds.copy_count} copy picks, {data.crowds.fade_count} fade picks
          </>
        )}
      </p>
      <div class="ropes">
        {data.markets.map((m) => (
          <RopeRow key={m.symbol} m={m} />
        ))}
      </div>
      {data.model && (
        <p class="model">
          <span class="tag">MODEL</span> Paper record from real Strike prices since {time(data.rules.record_start)} on{" "}
          {new Date(data.rules.record_start).toISOString().slice(0, 10)}: {usd(data.model.equity)} from{" "}
          {usd(data.model.start_equity)}. Not real trades.
        </p>
      )}
      <p class="fine">
        Rules fingerprint <code>{data.rules.sha256.slice(0, 16)}…</code> (version {data.rules.version}), published before
        the record started.
      </p>
    </>
  );
}
