import { time } from "./api.js";

/** One line over time from stored points; the y range fits the data with a little room. */
export function LineChart({ points, label, format }: { points: Array<{ at: number; v: number }>; label: string; format: (v: number) => string }) {
  if (points.length < 2) return <p class="note">The chart fills in as snapshots arrive (one every 5 minutes).</p>;
  const W = 600;
  const H = 160;
  const t0 = points[0]!.at;
  const t1 = points[points.length - 1]!.at;
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs);
  let hi = Math.max(...vs);
  if (hi === lo) [lo, hi] = [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => ((hi - v) / (hi - lo)) * H;
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  return (
    <figure class="chart card">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <path d={d} class="ln copy" />
      </svg>
      <figcaption>
        <span>
          {time(t0)} to {time(t1)}
        </span>
        <span>
          low {format(Math.min(...vs))} · high {format(Math.max(...vs))}
        </span>
      </figcaption>
    </figure>
  );
}
