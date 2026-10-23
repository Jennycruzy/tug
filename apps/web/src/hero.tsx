import { useEffect, useState } from "preact/hooks";
import type { Market } from "./api.js";

/** Rope proportions: phones get a shorter, thicker rope so the marks stay readable. */
const WIDE = { W: 1000, SPAN: 420, R: 17 };
const NARROW = { W: 560, SPAN: 225, R: 24 };

function useNarrow(): boolean {
  const q = typeof matchMedia === "function" ? matchMedia("(max-width: 560px)") : null;
  const [narrow, setNarrow] = useState(q?.matches ?? false);
  useEffect(() => {
    if (!q) return;
    const on = () => setNarrow(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}

const leanWords = (s: { lean: number; n: number }) =>
  s.n === 0 ? "none holding" : s.lean > 0 ? `${Math.round(s.lean * 100)}% long` : s.lean < 0 ? `${Math.round(-s.lean * 100)}% short` : "even";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The opening picture: one real market's tug of war, drawn as a rope. The copy picks and the fade picks stand
 * where their money leans; the knot sits where TUG pulls. It steps through the strongest pulls every few seconds.
 */
export function HeroRope({ markets }: { markets: Market[] }) {
  const top = markets.filter((m) => m.tradable && m.gap !== 0).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 5);
  const [i, setI] = useState(0);
  const [settled, setSettled] = useState(false);
  const { W, SPAN, R } = useNarrow() ? NARROW : WIDE;
  const MID = W / 2;
  /** −1 (all short) … +1 (all long) to an x position on the hero rope. */
  const x = (lean: number) => MID + Math.max(-1, Math.min(1, lean)) * SPAN;
  useEffect(() => {
    const t0 = setTimeout(() => setSettled(true), 60);
    if (top.length < 2 || reduced()) return () => clearTimeout(t0);
    const t = setInterval(() => setI((v) => (v + 1) % top.length), 6_500);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [top.length]);
  const m = top[i % Math.max(1, top.length)];
  if (!m) return <RopeArt W={W} />;
  const short = m.gap < 0;
  const pos = (lean: number) => (settled ? x(lean) : MID);
  return (
    <figure class="hero-rope">
      <div class="hero-mkt" aria-live="polite">
        <span class="hero-sym">{m.symbol.replace("-USD", "")}</span>
        <span class={`hero-side ${short ? "short" : "long"}`}>TUG pulls {short ? "short" : "long"}</span>
      </div>
      <svg viewBox={`0 0 ${W} 190`} role="img" aria-label={`${m.symbol}: copy picks ${leanWords(m.copy)}, fade picks ${leanWords(m.fade)}. TUG pulls ${short ? "short" : "long"}.`}>
        <RopeDefs />
        <text class="end" x="40" y="40">SHORT</text>
        <text class="end" x={W - 40} y="40" text-anchor="end">LONG</text>
        <line class="mid" x1={MID} x2={MID} y1="56" y2="124" />
        <rect class="hemp" x="20" y="83" width={W - 40} height="14" rx="7" fill="url(#hemp)" />
        <g class="team copy" style={{ transform: `translate(${pos(m.copy.lean)}px, 90px)` }}>
          <circle r={R} />
          <text y={-R - 13} text-anchor="middle">copy picks</text>
          <text class="n" y={R > 20 ? 6 : 5} text-anchor="middle">{m.copy.n}</text>
        </g>
        {m.fade.n > 0 && (
          <g class="team fade" style={{ transform: `translate(${pos(m.fade.lean)}px, 90px)` }}>
            <circle r={R} />
            <text y={-R - 13} text-anchor="middle">fade picks</text>
            <text class="n" y={R > 20 ? 6 : 5} text-anchor="middle">{m.fade.n}</text>
          </g>
        )}
        <g class="knot-g" style={{ transform: `translate(${pos(m.gap)}px, 90px)` }}>
          <line class="knot-cord" x1="0" y1="7" x2="0" y2={R + 14} />
          <path class="knot-mark" d="M0,-12 L12,0 L0,12 L-12,0 Z" transform={`translate(0, ${R + 26})`} />
          <text class="knot-t" y={R + 60} text-anchor="middle">TUG</text>
        </g>
      </svg>
      <figcaption>
        <span class="c-copy">
          <i class="dot copy" /> Copy picks {leanWords(m.copy)}
        </span>
        <span class="c-fade">
          <i class="dot fade" /> Fade picks {leanWords(m.fade)}
        </span>
        <span class="c-knot">
          <i class="dot tugdot" /> TUG's side
        </span>
      </figcaption>
      {top.length > 1 && (
        <div class="hero-steps" role="tablist" aria-label="Strongest pulls right now">
          {top.map((t, k) => (
            <button key={t.symbol} type="button" role="tab" aria-selected={k === i % top.length} class={k === i % top.length ? "on" : ""} onClick={() => setI(k)}>
              {t.symbol.replace("-USD", "")}
            </button>
          ))}
        </div>
      )}
    </figure>
  );
}

/** Shown before the first snapshot loads: the rope at rest. */
function RopeArt({ W }: { W: number }) {
  const MID = W / 2;
  return (
    <figure class="hero-rope">
      <svg viewBox={`0 0 ${W} 170`} aria-hidden="true">
        <RopeDefs />
        <rect class="hemp" x="20" y="83" width={W - 40} height="14" rx="7" fill="url(#hemp)" />
        <g class="knot-g" style={{ transform: `translate(${MID}px, 90px)` }}>
          <path class="knot-mark" d="M0,-15 L15,0 L0,15 L-15,0 Z" />
        </g>
      </svg>
    </figure>
  );
}

/** Twisted hemp: two strand tones laid on a slant, the way a real rope reads from a distance. */
function RopeDefs() {
  return (
    <defs>
      <pattern id="hemp" width="12" height="14" patternUnits="userSpaceOnUse" patternTransform="skewX(-35)">
        <rect width="12" height="14" class="strand-a" />
        <rect width="5" height="14" class="strand-b" />
      </pattern>
    </defs>
  );
}
