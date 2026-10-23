import { LocationProvider, Route, Router } from "preact-iso";
import { ApiPage } from "./pages/apidocs.js";
import { Home } from "./pages/home.js";
import { MarketPage } from "./pages/market.js";
import { NotFound } from "./pages/notfound.js";
import { CheckPage } from "./pages/check.js";
import { JoinPage } from "./pages/join.js";
import { ProofPage } from "./pages/proof.js";
import { RecordPage } from "./pages/record.js";
import { ScoreboardPage } from "./pages/scoreboard.js";
import { Status } from "./pages/status.js";

export function App() {
  return (
    <LocationProvider>
      <header class="top">
        <div class="top-wrap">
          <a class="brand" href="/" aria-label="TUG home">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="var(--ink)" />
              <path d="M4 16h24" stroke="var(--hemp-a)" stroke-width="4" stroke-linecap="round" />
              <circle cx="7" cy="16" r="3.5" fill="var(--fade)" />
              <circle cx="25" cy="16" r="3.5" fill="var(--copy)" />
              <path d="M19 11l5 5-5 5-5-5z" fill="var(--knot)" />
            </svg>
            <span>TUG</span>
          </a>
          <nav aria-label="Pages">
            <a href="/#markets">Markets</a>
            <a href="/record">Record</a>
            <a href="/scoreboard">Scoreboard</a>
            <a href="/proof">Proof</a>
            <a href="/join">Join</a>
            <a href="/api">API</a>
            <a href="/status">Status</a>
          </nav>
        </div>
      </header>
      <main>
        <Router>
          <Route path="/" component={Home} />
          <Route path="/m/:symbol" component={MarketPage} />
          <Route path="/record" component={RecordPage} />
          <Route path="/scoreboard" component={ScoreboardPage} />
          <Route path="/proof" component={ProofPage} />
          <Route path="/check" component={CheckPage} />
          <Route path="/join" component={JoinPage} />
          <Route path="/api" component={ApiPage} />
          <Route path="/status" component={Status} />
          <Route default component={NotFound} />
        </Router>
      </main>
      <footer class="foot">
        Built on Strike's public API. Not investment advice. Perpetuals can lose all deposited funds.
      </footer>
    </LocationProvider>
  );
}
