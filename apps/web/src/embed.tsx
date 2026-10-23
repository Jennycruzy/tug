import { useApi, type Market, type TugReply } from "./api.js";
import { Rope } from "./rope.js";

const SITE = "https://tug.38-49-216-59.sslip.io";
const leanWords = (s: { lean: number; n: number }) => (s.n === 0 ? "none holding" : s.lean > 0 ? `${Math.round(s.lean * 100)}% long` : s.lean < 0 ? `${Math.round(-s.lean * 100)}% short` : "even");

/**
 * The widget (`/embed/<symbol>` or `/embed/all`, in an iframe on any site): the rope for one market, or the five
 * widest gaps, from TUG's own API on its own origin. No cookies, no third-party requests.
 */
export function Embed({ symbol }: { symbol: string }) {
  const load = useApi<TugReply>("/api/v1/tug", 300_000);
  if (load.state !== "ok") return <div class="embed">{load.state === "error" ? "TUG data is not available right now." : "Loading…"}</div>;
  const all = symbol.toLowerCase() === "all";
  const markets = all
    ? [...load.data.markets].filter((m) => m.tradable && m.gap !== 0).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 5)
    : load.data.markets.filter((m) => m.symbol === symbol.toUpperCase());
  return (
    <div class="embed">
      {markets.length === 0 && <p class="note">No market {symbol} on Strike.</p>}
      {markets.map((m: Market) => (
        <div class="embed-row" key={m.symbol}>
          <div class="embed-head">
            <b>{m.symbol.replace("-USD", "")}</b>
            <span>
              <i class="dot copy" /> copy picks {leanWords(m.copy)} · <i class="dot fade" /> fade picks {leanWords(m.fade)}
            </span>
          </div>
          <Rope m={m} />
        </div>
      ))}
      <a class="embed-foot" href={all ? SITE : `${SITE}/m/${markets[0]?.symbol ?? ""}`} target="_blank" rel="noopener">
        TUG · Strike's copy picks vs fade picks, every 5 minutes
      </a>
    </div>
  );
}
