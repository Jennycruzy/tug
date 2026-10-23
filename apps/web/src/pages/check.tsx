import { useState } from "preact/hooks";
import { verifyEvidence, type Check } from "../../../../packages/core/src/verify.js";
import type { ProofReply } from "../api.js";

/** TUG's live Strike account (public: Strike's trader page @tug-mainnet). */
const LIVE_ACCOUNT = "01a16637-81cb-7682-b614-4728271550aa";
const STEPS = ["hashes", "rules", "paper record", "scoreboard", "fees saved", "fills", "depth added", "Strike re-read"];

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b.slice()]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/**
 * The browser check (§16.2): downloads the evidence bundle file by file, checks every SHA-256, recomputes the
 * records with the engine's own code and compares, then re-reads TUG's fills from Strike's public API. Nothing is
 * taken on trust from TUG's server except the bytes, and those are checked against the published manifest.
 */
export function CheckPage() {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [note, setNote] = useState("");
  const [checks, setChecks] = useState<Check[]>([]);

  async function run() {
    setState("running");
    setChecks([]);
    try {
      const proof = (await (await fetch("/api/v1/proof")).json()) as ProofReply;
      const manifest = await (await fetch("/api/v1/evidence/MANIFEST.sha256", { cache: "no-store" })).text();
      const paths = manifest.split("\n").filter(Boolean).map((l) => l.slice(66));
      const files = new Map<string, Uint8Array>([["MANIFEST.sha256", new TextEncoder().encode(manifest)]]);
      let bytes = 0;
      for (const [i, p] of paths.entries()) {
        setNote(`Downloading ${i + 1} of ${paths.length}: ${p}`);
        const b = new Uint8Array(await (await fetch(`/api/v1/evidence/${p}`, { cache: "no-store" })).arrayBuffer());
        bytes += b.length;
        files.set(p, b);
      }
      setNote(`Downloaded ${paths.length} files (${(bytes / 1e6).toFixed(1)} MB). Recomputing…`);
      const out = await verifyEvidence(files, {
        rulesSha256: proof.rules[0]?.sha256 ?? "",
        sha256: async (b) => hex(await crypto.subtle.digest("SHA-256", b.slice())),
        gunzip,
        strikeFills: async () => {
          const j = (await (await fetch(`https://api.strikefinance.org/v2/history/fill?account_id=${LIVE_ACCOUNT}&limit=1000`)).json()) as {
            fills?: Array<Record<string, string | number>> | null;
          };
          return (j.fills ?? []).map((f) => ({ id: Number(f.id), order_id: Number(f.order_id), price: Number(f.price), size: Number(f.size), fee: Number(f.fee), ts: Number(f.timestamp) }));
        },
        progress: (step) => setNote(`Checked: ${step}`),
      });
      setChecks(out);
      setNote(out.every((c) => c.ok) ? `Every check passed (${new Date().toISOString().slice(11, 19)} UTC).` : `${out.filter((c) => !c.ok).length} check(s) failed.`);
      setState("done");
    } catch (e) {
      setNote((e as Error).message);
      setState("error");
    }
  }

  return (
    <section class="page">
      <h1>Check it yourself</h1>
      <p class="lede">
        This page downloads TUG's evidence, checks each file against its published SHA-256, recomputes the paper record,
        the scoreboard, fees saved and depth added with the same code the engine runs, and compares every number. Then it
        reads TUG's fills straight from Strike's public API and matches each one. It all runs in this browser.
      </p>
      <p>
        <button class="btn primary" type="button" onClick={() => void run()} disabled={state === "running"}>
          {state === "running" ? "Checking…" : state === "idle" ? "Run the check" : "Run it again"}
        </button>
      </p>
      {note && <p class={`note${state === "error" ? " err" : ""}`}>{note}</p>}
      <ul class="checks">
        {(checks.length ? checks : STEPS.map((name) => ({ name, ok: false, detail: "" }))).map((c) => (
          <li key={c.name} class={!checks.length ? "wait" : c.ok ? "pass" : "fail"}>
            <b>{!checks.length ? "…" : c.ok ? "PASS" : "FAIL"}</b>
            <span>
              {c.name}
              {c.detail && <small>{c.detail}</small>}
            </span>
          </li>
        ))}
      </ul>
      <p class="fine">
        The same check on your machine: <code>pnpm verify</code> in a clone of the code repository (see <a href="/proof">Proof</a>).
      </p>
    </section>
  );
}
