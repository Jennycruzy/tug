import { TugError } from "./rules.js";
import type { WeightBucket } from "./bucket.js";

export const USER_AGENT = `tug/0.1 (+${process.env.TUG_SITE_URL ?? "https://github.com/Jennycruzy/tug"})`;

export interface FetchJsonOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  weight: number;
  bucket: WeightBucket;
  /** Attempts on 429/5xx/network errors before giving up. */
  attempts?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpEvent {
  code: "E-RATE";
  host: string;
  status: number | null;
  attempt: number;
  waitMs: number;
  message: string;
}

let sink: (e: HttpEvent) => void = () => {};
/** Every 429/5xx/network failure and the backoff that follows is reported here. */
export function setHttpEventSink(fn: (e: HttpEvent) => void): void {
  sink = fn;
}

/**
 * JSON over HTTP with pacing and exponential backoff. Returns the parsed body and the raw text
 * (the raw text is hashed into the evidence record).
 */
export async function fetchJson(url: string, o: FetchJsonOptions): Promise<{ json: unknown; raw: string }> {
  const attempts = o.attempts ?? 4;
  let delay = 1_000;
  let lastErr: unknown;
  const host = new URL(url).host;
  for (let i = 0; i < attempts; i++) {
    let status: number | null = null;
    await o.bucket.take(o.weight);
    try {
      const res = await fetch(url, {
        method: o.method ?? "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...o.headers,
        },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
      status = res.status;
      const raw = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new TugError("E-RATE", `${res.status} from ${new URL(url).host}`);
      } else if (!res.ok) {
        throw new TugError("E-HTTP", `${res.status} from ${url}: ${raw.slice(0, 200)}`);
      } else {
        return { json: JSON.parse(raw), raw };
      }
    } catch (e) {
      if (e instanceof TugError && e.code === "E-HTTP") throw e;
      lastErr = e;
    }
    const waitMs = delay + Math.floor(Math.random() * 250);
    sink({ code: "E-RATE", host, status, attempt: i + 1, waitMs, message: lastErr instanceof Error ? lastErr.message : String(lastErr) });
    await sleep(waitMs);
    delay = Math.min(delay * 2, 60_000);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
