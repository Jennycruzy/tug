const BASE = typeof location === "undefined" ? "" : location.origin;

const ENDPOINTS: Array<[string, string]> = [
  ["/api/v1/tug", "Every Strike market: both crowds, the gap, TUG's position"],
  ["/api/v1/tug/ETH-USD", "One market with the largest members and 24 hours of lean history"],
  ["/api/v1/crowds", "The current crowd lists, from Strike's own scores and tags"],
  ["/api/v1/record", "Records; the paper record is labelled MODEL"],
  ["/api/v1/record/fills", "Fills with Strike order ids"],
  ["/api/v1/paper", "The paper record (MODEL) with the targets of the last rebalance"],
  ["/api/v1/scoreboard", "Copy picks and fade picks since the record started, per market"],
  ["/api/v1/proof", "Rules fingerprint, market mapping, snapshot counts, fees saved"],
  ["/api/v1/status", "Heartbeats, snapshots, orders and errors"],
];

export function ApiPage() {
  return (
    <section class="page">
      <h1>Public API</h1>
      <p class="lede">Free, no key, 60 requests per minute. Data refreshes every 5 minutes.</p>
      <p>
        <a href="/api/openapi.json">OpenAPI 3.1</a> · <a href="/llms.txt">llms.txt</a>
      </p>
      <table class="members">
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Returns</th>
          </tr>
        </thead>
        <tbody>
          {ENDPOINTS.map(([path, what]) => (
            <tr key={path}>
              <td>
                <a href={path}>
                  <code>{path}</code>
                </a>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>curl</h2>
      <pre class="card code">{`curl -s ${BASE}/api/v1/tug | jq '.markets[] | select(.tradable) | {symbol, gap}'`}</pre>
      <h2>JavaScript</h2>
      <pre class="card code">{`const r = await fetch("${BASE}/api/v1/tug");
const { markets } = await r.json();
for (const m of markets.filter((m) => m.tradable)) {
  console.log(m.symbol, m.gap, m.copy.lean, m.fade.lean);
}`}</pre>
    </section>
  );
}
