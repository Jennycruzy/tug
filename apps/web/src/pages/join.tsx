import { useEffect, useState } from "preact/hooks";
import { ago, useApi, type RecordReply } from "../api.js";
import { walletsInBrowser, type WalletChoice } from "../wallet.js";

const STRIKE_PAGE = "https://app.strikefinance.org/public-portfolio/@tug-mainnet";
const STRIKE_TESTNET_PAGE = "https://testnet.strikefinance.org/public-portfolio/01a163bf-fb0a-77b0-86c0-03a62889ee01";
const SAVED = "tug-connection";

interface ConnectView {
  id: string;
  network: "testnet" | "mainnet";
  status: "signing" | "verified" | "active" | "stopping" | "ended" | "failed";
  account: string | null;
  budget_usd: number | null;
  fee_share_bps: number | null;
  key_held: boolean;
  equity: { at: number; equity: number; positions: Record<string, { size: string; entry: number; upnl: number }> } | null;
  fills: number;
  maker_fills: number;
  open_orders: number;
  stop_report: { cancelled?: string[]; closed?: string[]; open_orders_after?: number; tries?: number; key?: string; strike_key_note?: string; strike_api_keys_page?: string } | null;
  error: string | null;
}

/** Remembered in this browser only, so a reload can show the connection again (the key itself stays on the server). */
const load = (): { id: string; token: string } | null => {
  try {
    return JSON.parse(localStorage.getItem(SAVED) ?? "null") as { id: string; token: string } | null;
  } catch {
    return null;
  }
};
const save = (v: { id: string; token: string } | null) => {
  try {
    if (v) localStorage.setItem(SAVED, JSON.stringify(v));
    else localStorage.removeItem(SAVED);
  } catch {
    // Storage blocked: the page still works for this visit.
  }
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as T & { message?: string };
  if (!r.ok) throw new Error(j.message ?? `Request failed (${r.status}).`);
  return j;
}

type Net = "testnet" | "mainnet";

export function JoinPage() {
  // One choice for the whole page: copying TUG and TUG in your account both follow it.
  const [network, setNetwork] = useState<Net>("mainnet");
  return (
    <section class="page">
      <h1>Join</h1>
      <p class="lede">Three ways to use TUG on Strike. Choose real money or test money first.</p>
      <div class="cta" role="radiogroup" aria-label="Network">
        {(["mainnet", "testnet"] as const).map((n) => (
          <button key={n} type="button" class={`btn ${network === n ? "primary" : ""}`} aria-pressed={network === n} onClick={() => setNetwork(n)}>
            {n === "mainnet" ? "Mainnet (real money)" : "Testnet (test money)"}
          </button>
        ))}
      </div>
      <CopyOnStrike network={network} />
      <Vault />
      <InYourAccount network={network} />
    </section>
  );
}

function CopyOnStrike({ network }: { network: Net }) {
  const page = network === "mainnet" ? STRIKE_PAGE : STRIKE_TESTNET_PAGE;
  return (
    <>
      <h2>
        1. Copy TUG on Strike {network === "testnet" && <span class="tag">TESTNET</span>}
      </h2>
      <p>
        {network === "mainnet"
          ? "TUG's live account is a Strike trader anyone can copy, with Strike's own copy trading."
          : "TUG's testnet account runs the same rules with test money; copy it on Strike testnet to try copying for free."}
      </p>
      <ol>
        <li>
          Open <a href={page}>TUG's page on Strike{network === "testnet" ? " testnet" : ""}</a> and connect your wallet there.
        </li>
        <li>Press Copy and choose Fixed Ratio.</li>
        <li>Enter an amount ($20 or more, Strike's minimum) and confirm. Strike copies each new TUG trade into your account.</li>
      </ol>
      <p>
        <a class="btn primary" href={page}>
          {network === "mainnet" ? "Copy TUG on Strike" : "Copy TUG on Strike testnet"}
        </a>
      </p>
    </>
  );
}

function Vault() {
  const rec = useApi<RecordReply>("/api/v1/record?network=testnet", 300_000);
  const v = rec.state === "ok" ? rec.data.vault : null;
  return (
    <>
      <h2>
        2. TUG's vault <span class="tag">TESTNET</span>
      </h2>
      <p>
        TUG also runs a Strike vault on testnet: the same rules, trading pooled test money.
        {v ? ` Share price ${v.share_price.toFixed(4)}, ${v.total_shares.toLocaleString("en-US", { maximumFractionDigits: 0 })} shares, updated ${ago(v.at)}.` : ""}
      </p>
      <ol>
        <li>Get test money: on Strike testnet, deposit tADA from the Cardano Preprod faucet.</li>
        <li>Open the vault on Strike testnet and press Deposit ($10 or more).</li>
        <li>Withdrawals are paid one day after you ask, at the share price then.</li>
      </ol>
      {v && (
        <p>
          <a class="btn" href={v.links.strike_vault_page}>
            Open the vault on Strike testnet
          </a>{" "}
          <a href="/record#vault">Its record</a>
        </p>
      )}
    </>
  );
}

function InYourAccount({ network }: { network: Net }) {
  const nets = useApi<{ testnet: boolean; mainnet: boolean }>("/api/v1/connect/networks", 300_000);
  const mainnetOpen = nets.state === "ok" && nets.data.mainnet;
  const [saved, setSaved] = useState(load());
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  const [view, setView] = useState<ConnectView | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [budget, setBudget] = useState("50");
  const [accept, setAccept] = useState(false);
  const [close, setClose] = useState(false);

  // Wallet extensions add themselves a moment after the page loads.
  useEffect(() => {
    const t = setTimeout(() => setWallets(walletsInBrowser()), 600);
    return () => clearTimeout(t);
  }, []);

  const refresh = async (s = saved) => {
    if (!s) return;
    const r = await fetch(`/api/v1/connect/${s.id}`, { headers: { "x-tug-token": s.token } });
    if (r.ok) setView((await r.json()) as ConnectView);
    else {
      save(null);
      setSaved(null);
      setView(null);
    }
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [saved?.id]);

  const step = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const connectWith = (w: WalletChoice) =>
    step(`Connecting ${w.label}…`, async () => {
      const wallet = await w.connect(network);
      const s = await post<{ id: string; token: string; message_to_sign: string }>("/api/v1/connect/start", { network, chain: w.chain, address: wallet.address });
      save({ id: s.id, token: s.token });
      setSaved({ id: s.id, token: s.token });
      setBusy("Sign the message in your wallet…");
      const signature = await wallet.sign(s.message_to_sign);
      await post("/api/v1/connect/verify", { id: s.id, token: s.token, wallet_signature: signature });
      await refresh({ id: s.id, token: s.token });
    });

  const start = () =>
    step("Starting…", async () => {
      await post("/api/v1/connect/activate", { id: saved!.id, token: saved!.token, budget_usd: Number(budget), accept_risk: accept });
      await refresh();
    });

  const stop = () =>
    step("Stopping…", async () => {
      await post("/api/v1/connect/stop", { id: saved!.id, token: saved!.token, close_positions: close });
      await refresh();
    });

  // An existing connection keeps its own network; the choice applies to a new one.
  const net = view && view.status !== "ended" && view.status !== "failed" ? view.network : network;
  const keysPage = net === "mainnet" ? "https://app.strikefinance.org/api-keys" : "https://testnet.strikefinance.org/api-keys";
  const forget = () => {
    save(null);
    setSaved(null);
    setView(null);
  };

  return (
    <>
      <h2>
        3. TUG in your account {network === "testnet" && <span class="tag">TESTNET</span>}
      </h2>
      <p>
        Connect your own wallet and TUG trades your own Strike account by the same rules, within a budget you set. Your
        wallet signs one message from Strike that gives TUG a key for your account. TUG uses it only to place and cancel
        orders, never to move your money. TUG keeps the key encrypted and deletes its copy when you press Stop; the key
        stays listed on your Strike account until you remove it on <a href={keysPage}>Strike's API keys page</a>. TUG's
        builder fee is 0.01% of each trade.
      </p>
      {network === "mainnet" && !mainnetOpen && <p class="note">On mainnet this opens soon; choose Testnet above to try it now.</p>}
      {err && <p class="note err">{err}</p>}
      {busy && <p class="note">{busy}</p>}

      {(!view || view.status === "ended" || view.status === "failed") && (
        <>
          {view?.status === "ended" && (
            <p class="note">
              Stopped. TUG cancelled {view.stop_report?.cancelled?.length ?? 0} order(s){view.stop_report?.closed?.length ? ` and closed ${view.stop_report.closed.join(", ")}` : ""}, and deleted its copy of the key. To remove the key from your Strike account too, open{" "}
              <a href={view.stop_report?.strike_api_keys_page ?? keysPage}>Strike's API keys page</a>.{" "}
              <button class="linkish" type="button" onClick={forget}>
                Start again
              </button>
            </p>
          )}
          {view?.status === "failed" && <p class="note err">The wallet signature was not accepted ({view.error}). Try again.</p>}
          {wallets.length === 0 ? (
            <p class="note">
              No wallet found in this browser. Install Eternl or Lace (Cardano{network === "testnet" ? ", Preprod" : ""}), MetaMask (Ethereum) or Phantom (Solana), then reload.
            </p>
          ) : (
            <div class="cta">
              {wallets.map((w) => (
                <button key={w.id} class="btn" type="button" disabled={!!busy} onClick={() => void connectWith(w)}>
                  Connect {w.label}
                </button>
              ))}
            </div>
          )}
          <p class="fine">
            {network === "mainnet"
              ? "You need money on Strike: deposit on app.strikefinance.org first. TUG trades it within your budget, at most $1,000."
              : "You need a Strike testnet account with test money: deposit tADA from the Cardano Preprod faucet at testnet.strikefinance.org."}
          </p>
        </>
      )}

      {view?.status === "signing" && (
        <p class="note">
          Waiting for your wallet's signature.{" "}
          <button class="linkish" type="button" onClick={forget}>
            Cancel
          </button>
        </p>
      )}

      {view?.status === "verified" && (
        <div class="card">
          <p>
            Connected: Strike account <code>{view.account}</code>. Set a budget and start.
          </p>
          <label class="field">
            Budget (USD{net === "mainnet" ? ", real money, at most $1,000" : ", test money"})
            <input type="number" min={10} max={net === "mainnet" ? 1000 : 10000} step={1} value={budget} onInput={(e) => setBudget((e.target as HTMLInputElement).value)} />
          </label>
          <label class="check">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept((e.target as HTMLInputElement).checked)} />
            I understand TUG will place orders in my Strike {net === "mainnet" ? "account with real money" : "testnet account"}, sized on this budget and never past it times two, and that perpetuals can lose all deposited funds.
          </label>
          <p>
            <button class="btn primary" type="button" disabled={!accept || !!busy || !(Number(budget) >= 10)} onClick={() => void start()}>
              Start TUG in my account
            </button>
          </p>
        </div>
      )}

      {(view?.status === "active" || view?.status === "stopping") && (
        <div class="card kv">
          <span>Status</span>
          <b>
            {view.status === "active"
              ? "TUG is trading your account"
              : `Stopping: cancelling TUG's orders${view.stop_report?.tries ? ` (try ${view.stop_report.tries}; ${view.stop_report.open_orders_after ?? 0} still open)` : ""}…`}
          </b>
          <span>Strike account</span>
          <b>
            <code>{view.account}</code>
          </b>
          <span>Budget</span>
          <b>${view.budget_usd}</b>
          <span>Equity</span>
          <b>{view.equity ? `$${view.equity.equity.toFixed(2)} (${ago(view.equity.at)})` : "reading…"}</b>
          <span>Positions</span>
          <b>
            {view.equity && Object.keys(view.equity.positions).length
              ? Object.entries(view.equity.positions)
                  .map(([s, p]) => `${s} ${Number(p.size) > 0 ? "long" : "short"} ${Math.abs(Number(p.size))}`)
                  .join(", ")
              : "none"}
          </b>
          <span>Orders waiting</span>
          <b>{view.open_orders}</b>
          <span>Fills</span>
          <b>
            {view.fills} ({view.maker_fills} as maker)
          </b>
        </div>
      )}
      {view?.status === "active" && (
        <p>
          <label class="check">
            <input type="checkbox" checked={close} onChange={(e) => setClose((e.target as HTMLInputElement).checked)} />
            Also close TUG's positions
          </label>
          <button class="btn" type="button" disabled={!!busy} onClick={() => void stop()}>
            Stop
          </button>
        </p>
      )}
    </>
  );
}
