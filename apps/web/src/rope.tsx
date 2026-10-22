import type { Market } from "./api.js";
import { usd } from "./api.js";

/** Position on the rope: −1 (all short) at the left end, +1 (all long) at the right end. */
const pct = (lean: number) => `${((Math.max(-1, Math.min(1, lean)) + 1) / 2) * 100}%`;

/** A crowd only counts when it has enough members holding the market; see the reason field. */
const counts = (m: Market, crowd: "copy" | "fade") =>
  m.reason === "two_crowds" || (crowd === "copy" ? m.reason === "copy_only" : m.reason === "fade_only");

export function Rope({ m }: { m: Market }) {
  const gapLeft = m.gap < 0;
  const gapWidth = `${(Math.min(1, Math.abs(m.gap)) / 2) * 100}%`;
  return (
    <div class="rope" role="img" aria-label={ropeLabel(m)}>
      <div class="rope-line" />
      <div class="rope-mid" />
      {m.gap !== 0 && <div class={`rope-pull ${gapLeft ? "left" : "right"}`} style={{ width: gapWidth }} />}
      {m.fade.n > 0 && <span class={`pin fade ${counts(m, "fade") ? "" : "dim"}`} style={{ left: pct(m.fade.lean) }} title="Fade picks' lean" />}
      {m.copy.n > 0 && <span class={`pin copy ${counts(m, "copy") ? "" : "dim"}`} style={{ left: pct(m.copy.lean) }} title="Copy picks' lean" />}
      {m.gap !== 0 && <span class="knot" style={{ left: pct(m.gap) }} title="The gap" />}
    </div>
  );
}

export function ropeLabel(m: Market): string {
  const side = (lean: number) => (lean > 0 ? `long ${Math.round(lean * 100)}%` : lean < 0 ? `short ${Math.round(-lean * 100)}%` : "even");
  return `${m.symbol}: copy picks ${side(m.copy.lean)} (${m.copy.n}), fade picks ${side(m.fade.lean)} (${m.fade.n}), gap ${m.gap.toFixed(2)}`;
}

export const net = (s: { long: number; short: number }) => s.long - s.short;

/** "Long $1.2M" / "Short $340k" / "Even" for a crowd's net size. */
export function netWords(s: { long: number; short: number; n: number }): string {
  if (s.n === 0) return "none holding";
  const v = net(s);
  return v > 0 ? `long ${usd(v)}` : v < 0 ? `short ${usd(-v)}` : "even";
}

/** Below a dollar the paper record's position is rounding dust, shown as flat. */
export function sideWords(p: { side: string; notional: number }): string {
  if (Math.abs(p.notional) < 1) return "Flat";
  return `${p.notional > 0 ? "Long" : "Short"} ${usd(Math.abs(p.notional))}`;
}
