import { ago, time, usd, useApi, type Market, type ProofReply, type StatusReply, type TugReply } from "../api.js";
import { HeroRope } from "../hero.js";
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
    <>
      <section class="hero">
        <div class="hero-copy">
          <LivePill />
          <h1 class="display">
            Strike already knows who wins and who loses. <em>TUG trades the gap.</em>
          </h1>
          <p class="lede">
            Strike marks some traders as worth copying and others as worth betting against. TUG watches what both
            groups hold in every market. Where they pull opposite ways, it takes the copy picks' side, with orders that
            wait in the book.
          </p>
          <div class="cta">
            <a class="btn primary" href="#markets">
              Watch every market
            </a>
            <a class="btn" href="/record">
              See the record
            </a>
          </div>
        </div>
        {load.state === "ok" ? <HeroRope markets={load.data.markets} /> : <HeroRope markets={[]} />}
      </section>

      {load.state === "ok" && <Facts data={load.data} now={now} />}

      <section class="how" aria-labelledby="how-h">
        <h2 id="how-h" class="eyebrow">
          How TUG decides
        </h2>
        <ol class="steps">
          <li>
            <b>Read both crowds</b>
            <p>Every 5 minutes TUG reads the open positions of Strike's copy picks and fade picks, market by market.</p>
          </li>
          <li>
            <b>Find the gap</b>
            <p>For each market it measures how far apart the two groups lean. A small gap is ignored.</p>
          </li>
          <li>
            <b>Hold the copy picks' side</b>
            <p>TUG places an order and waits for someone to trade with it. On Strike, waiting earns a rebate instead of paying a fee.</p>
          </li>
        </ol>
      </section>

      <section class="page wide" id="markets" aria-labelledby="markets-h">
        <h2 id="markets-h" class="section-h">
          Every market, live
        </h2>
        <p class="lede small">Each rope is one Strike market. Tap one to see who holds what.</p>
        <Legend />
        {load.state === "loading" && <p class="note">Loading the latest snapshot…</p>}
        {load.state === "error" && <p class="note err">{load.message}</p>}
        {load.state === "ok" && <Ropes data={load.data} now={now} />}
        <FeesSaved />
        <Guards />
      </section>
    </>
  );
}

/** "Trading live on Strike" only while the engine reports mainnet trading on; otherwise "Recording live". */
function LivePill() {
  const s = useApi<StatusReply>("/api/v1/status", 60_000);
  const on = s.state === "ok" && s.data.trading.mainnet === "on";
  return (
    <p class={`pill ${on ? "on" : ""}`}>
      <i class="pulse" aria-hidden="true" /> {on ? "Trading live on Strike" : "Recording live from Strike"}
    </p>
  );
}

function Facts({ data, now }: { data: TugReply; now: number }) {
  const live = data.markets.filter((m) => m.tradable).length;
  return (
    <section class="facts" aria-label="Right now">
      <div>
        <b>{data.markets.length}</b>
        <span>Strike markets read</span>
      </div>
      <div>
        <b>{live}</b>
        <span>with a gap right now</span>
      </div>
      {data.crowds && (
        <div>
          <b>
            <span class="c-copy">{data.crowds.copy_count}</span> / <span class="c-fade">{data.crowds.fade_count}</span>
          </b>
          <span>copy picks / fade picks</span>
        </div>
      )}
      <div>
        <b>{ago(data.snapshot.at, now).replace(" ago", "")}</b>
        <span>since the last read</span>
      </div>
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

function FeesSaved() {
  const load = useApi<ProofReply>("/api/v1/proof", 300_000);
  if (load.state !== "ok" || !load.data.fees_saved) return null;
  const f = load.data.fees_saved;
  return (
    <div class="card fees">
      <h2>Fees saved</h2>
      <p>
        Copying all {f.baseline.subscriptions} of Strike's copy picks one by one with {usd(f.capital)} would have paid{" "}
        <b>{usd(f.baseline.fees)}</b> in taker fees over {f.baseline.orders.toLocaleString("en-US")} copied orders since the record
        started. TUG's model account on the same {usd(f.capital)}{" "}
        {f.tug.fees <= 0 ? (
          <>
            earned <b>{usd(-f.tug.fees)}</b> in maker rebates
          </>
        ) : (
          <>
            paid <b>{usd(f.tug.fees)}</b>
          </>
        )}
        .
      </p>
      <p class="fine">
        A lower bound: snapshots every 5 minutes undercount real fills. Strike copy subscriptions need at least $20 each, so
        the one-by-one baseline needs {usd(f.baseline.subscriptions * 20)} or more to start.
      </p>
    </div>
  );
}

/** The promises the engine keeps, each one enforced in code and visible on the Status page. */
function Guards() {
  return (
    <div class="guards">
      <div>
        <b>Rules locked first</b>
        <p>TUG's rules were published before its record started. Their fingerprint is shown above and never changes.</p>
      </div>
      <div>
        <b>It stops itself</b>
        <p>If the account falls a quarter below where it started, TUG closes everything and pauses until its owner says go.</p>
      </div>
      <div>
        <b>Open to check</b>
        <p>
          Every read, order and fill is stored. The <a href="/api">public API</a> and <a href="/status">status page</a> show them.
        </p>
      </div>
    </div>
  );
}
