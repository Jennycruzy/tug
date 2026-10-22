import { LocationProvider, Route, Router } from "preact-iso";
import { Home } from "./pages/home.js";
import { MarketPage } from "./pages/market.js";
import { NotFound } from "./pages/notfound.js";
import { Status } from "./pages/status.js";

export function App() {
  return (
    <LocationProvider>
      <header class="top">
        <a class="brand" href="/">
          TUG
        </a>
        <nav>
          <a href="/">Ropes</a>
          <a href="/status">Status</a>
        </nav>
      </header>
      <main>
        <Router>
          <Route path="/" component={Home} />
          <Route path="/m/:symbol" component={MarketPage} />
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
