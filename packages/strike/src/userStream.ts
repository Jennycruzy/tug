import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { keyFromHex, wsLogonMessage } from "./signed.js";
import { parseUserFrame, type UserFrame } from "./userFrames.js";

export const STRIKE_WS_USER = process.env.STRIKE_WS_USER ?? (process.env.STRIKE_API_URL ?? "https://api.strikefinance.org").replace(/^http/, "ws") + "/ws/user-api";

export interface UserStreamEvents {
  /** Every text line Strike sent, unparsed, with its receive time. */
  raw: (line: string, at: number) => void;
  frame: (f: UserFrame, at: number) => void;
  /** Logged on and subscribed again after a (re)connect: state must be re-read over REST, nothing is replayed. */
  resync: (accountId: string) => void;
  status: (s: { state: "connecting" | "open" | "closed"; code?: number; reason?: string }) => void;
}

/**
 * One account's user stream (one socket per account so every update is attributable). Node's WebSocket
 * answers Strike's pings itself; Strike closes a socket about 6 s after a ping goes unanswered. On any close
 * it reconnects with backoff (1 s doubling to 60 s), logs on, subscribes, then asks for a REST resync. A socket
 * that has not logged on within 15 s is closed and retried the same way.
 */
export class UserStream {
  private ws: WebSocket | undefined;
  private stopped = false;
  private backoff = 1_000;
  private readonly publicKeyHex: string;
  private readonly key: ReturnType<typeof createPrivateKey>;

  constructor(
    keyFile: string,
    private readonly on: Partial<UserStreamEvents>,
    private readonly opts: { vaultId?: string; url?: string; logonTimeoutMs?: number } = {},
  ) {
    const k = keyFromHex(readFileSync(keyFile, "utf8"));
    this.publicKeyHex = k.publicKeyHex;
    this.key = k.key;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close(1000, "stop");
  }

  /** Reconnects after the backoff (1 s doubling to 60 s), unless stopped. */
  private retry(): void {
    if (this.stopped) return;
    const wait = this.backoff + Math.floor(Math.random() * 250);
    this.backoff = Math.min(60_000, this.backoff * 2);
    setTimeout(() => this.connect(), wait);
  }

  private connect(): void {
    if (this.stopped) return;
    this.on.status?.({ state: "connecting" });
    const ws = new WebSocket(this.opts.url ?? STRIKE_WS_USER);
    this.ws = ws;
    // A socket that never completes the logon is closed and retried: during a Strike outage (OBSERVED 23 Oct
    // 05:39) the connection was accepted but neither the logon reply nor a close ever came.
    // Closing a socket still in its handshake does not reliably fire "close", so the timeout abandons it and
    // schedules the reconnect itself; the abandoned socket's later events are ignored.
    let loggedOn = false;
    let abandoned = false;
    const logonTimer = setTimeout(() => {
      if (loggedOn) return;
      abandoned = true;
      this.on.status?.({ state: "closed", reason: "logon timeout" });
      try {
        ws.close();
      } catch {
        // Already closing.
      }
      this.retry();
    }, this.opts.logonTimeoutMs ?? 15_000);
    ws.addEventListener("open", () => {
      const ts = Date.now();
      const signature = sign(null, Buffer.from(wsLogonMessage(ts, this.publicKeyHex)), this.key).toString("hex");
      ws.send(JSON.stringify({ id: 1, method: "session.logon", params: { apiKey: this.publicKeyHex, signature, timestamp: ts } }));
    });
    ws.addEventListener("message", (ev) => {
      if (abandoned) return;
      const at = Date.now();
      for (const line of String(ev.data).split("\n")) {
        if (!line.trim()) continue;
        this.on.raw?.(line, at);
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        // The logon reply: subscribe to the account (and the vault on testnet), then resync from REST.
        if (json.id === 1 && json.status === 200) {
          loggedOn = true;
          clearTimeout(logonTimer);
          const accountId = String((json.result as { account_id?: string } | undefined)?.account_id ?? "");
          ws.send(JSON.stringify({ method: "subscribe", channel: "userstream", id: 2 }));
          if (this.opts.vaultId) ws.send(JSON.stringify({ method: "subscribe", channel: "userstream", vault_id: this.opts.vaultId, id: 3 }));
          this.backoff = 1_000;
          this.on.status?.({ state: "open" });
          this.on.resync?.(accountId);
          continue;
        }
        this.on.frame?.(parseUserFrame(json), at);
      }
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(logonTimer);
      if (abandoned) return;
      this.on.status?.({ state: "closed", code: ev.code, reason: ev.reason });
      this.retry();
    });
    ws.addEventListener("error", () => {
      // A close event always follows; reconnecting happens there.
    });
  }
}
