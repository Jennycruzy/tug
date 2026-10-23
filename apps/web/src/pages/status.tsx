import { ago, time, useApi, type StatusReply } from "../api.js";
import { useNow } from "../now.js";

const STALE_MS = 11 * 60_000;

export function Status() {
  const load = useApi<StatusReply>("/api/v1/status", 30_000);
  const now = useNow(5_000);
  return (
    <section class="page">
      <h1>Status</h1>
      {load.state === "loading" && <p class="note">Loading…</p>}
      {load.state === "error" && <p class="note err">{load.message}</p>}
      {load.state === "ok" && <Body s={load.data} now={now} />}
    </section>
  );
}

function Body({ s, now }: { s: StatusReply; now: number }) {
  const lastError = s.errors_24h.last_error_at;
  const last = s.recorder.last_complete;
  const fresh = last !== null && now - last.at < STALE_MS;
  return (
    <>
      <div class="card kv">
        <span>Recorder</span>
        <b class={fresh ? "ok" : "bad"}>{last ? (fresh ? "Running" : "Late") : "No snapshot yet"}</b>
        <span>Last snapshot</span>
        <b>{last ? `#${last.id}, ${ago(last.at, now)} (${time(last.at)})` : "—"}</b>
        <span>Share of crowds read</span>
        <b>{last ? `copy ${pctOf(last.read_copy)}, fade ${pctOf(last.read_fade)}` : "—"}</b>
        <span>Crowd list</span>
        <b>{s.crowds ? `${s.crowds.copy_count} copy picks, ${s.crowds.fade_count} fade picks, pulled ${ago(s.crowds.pulled_at, now)}` : "—"}</b>
        <span>Engine up since</span>
        <b>
          {time(s.engine.started_at)} ({ago(s.engine.started_at, now)}) · build <code>{s.engine.revision}</code>
        </b>
        <span>Mainnet trading</span>
        <b>{s.trading.mainnet === "on" ? "On" : "Off"}</b>
        <span>Kill switch</span>
        <b>
          mainnet {s.trading.kill_switch.mainnet}, testnet {s.trading.kill_switch.testnet}
        </b>
        <span>Errors, last 24 h</span>
        <b class={lastError && now - lastError < 3600_000 ? "bad" : "ok"}>
          {s.errors_24h.error === 0 ? "None" : `${s.errors_24h.error} (the last one ${ago(lastError!, now)}; each is listed below)`}
          {s.errors_24h.warn ? ` · ${s.errors_24h.warn} warnings` : ""}
        </b>
        <span>Kill switch, vault</span>
        <b>{s.trading.kill_switch.vault}</b>
      </div>

      <h2>Recent snapshots</h2>
      <table class="members">
        <thead>
          <tr>
            <th>#</th>
            <th>Started</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {s.recorder.recent.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{time(r.at)}</td>
              <td class={r.status === "COMPLETE" ? "ok" : r.status === "RUNNING" ? "" : "bad"}>
                {r.status === "COMPLETE" ? "Complete" : r.status === "RUNNING" ? "In progress" : r.status.toLowerCase()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Orders</h2>
      {s.orders.recent.length === 0 ? (
        <p class="note">No orders yet.</p>
      ) : (
        <table class="members">
          <thead>
            <tr>
              <th>Placed</th>
              <th>Order</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {s.orders.recent.map((o) => (
              <tr key={o.client_order_id}>
                <td>{time(o.placed_at)}</td>
                <td>
                  {o.network === "testnet" && <span class="tag">TESTNET</span>} {o.side} {o.size} {o.symbol} at {o.price}
                  {o.order_id !== null && (
                    <>
                      {" "}
                      · Strike id <code>{o.order_id}</code>
                    </>
                  )}
                </td>
                <td>{o.status.toLowerCase()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Warnings and errors, last 24 h</h2>
      {s.errors_24h.recent.length === 0 ? (
        <p class="note">None.</p>
      ) : (
        <ul class="events">
          {s.errors_24h.recent.map((e, i) => (
            <li key={i}>
              <span class={e.level === "error" ? "bad" : "warn"}>{e.level}</span> {time(e.ts)} · {e.component}
              {e.code ? ` · ${e.code}` : ""}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const pctOf = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
