import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KEEPALIVE, parseUserFrame } from "../src/userFrames.js";

interface Row {
  t: string;
  socket: string;
  frame?: unknown;
  event?: string;
  data?: unknown;
}
const fixture = JSON.parse(readFileSync("packages/strike/test/fixtures/userstream-testnet-2026-10-22.json", "utf8")) as { frames: Row[] };
const frames = fixture.frames.filter((r) => r.frame !== undefined);
const parsed = frames.map((r) => ({ socket: r.socket, f: parseUserFrame(r.frame) }));

describe("Strike user stream (real testnet frames, 2026-10-22)", () => {
  it("every captured frame is recognised", () => {
    expect(parsed.filter((p) => p.f.kind === "unknown")).toEqual([]);
  });
  it("logon and both subscriptions are acknowledged on every socket, including after a reconnect", () => {
    for (const s of ["A", "B", "A2"]) {
      const acks = parsed.filter((p) => p.socket === s && p.f.kind === "ack").map((p) => (p.f as { id: number }).id);
      expect(acks).toEqual([1, 2, 3]);
    }
  });
  it("a vault deposit arrives as VAULT_DEPOSITED plus balance updates for the depositor and the vault", () => {
    const a = parsed.filter((p) => p.socket === "A").map((p) => p.f);
    const ev = a.find((f) => f.kind === "event");
    expect(ev).toMatchObject({ type: "VAULT_DEPOSITED", data: { usd_amount: expect.anything() } });
    const reasons = a.filter((f) => f.kind === "balance").map((f) => (f as { reason: string }).reason);
    expect(reasons).toEqual(["VAULT_DEPOSIT", "VAULT_DEPOSIT_RECEIVED"]);
  });
  it("an order and its cancel arrive on the new socket after a reconnect", () => {
    const states = parsed.filter((p) => p.socket === "A2" && p.f.kind === "order").map((p) => (p.f as { order: { X: string } }).order.X);
    expect(states).toEqual(["OPEN", "CANCELED"]);
  });
  it("keepalive: pings every 54 s; a socket that never answers is closed at about 60 s", () => {
    const pings = fixture.frames.filter((r) => r.socket === "A" && r.event === "ping frame").map((r) => Date.parse(r.t));
    expect(pings.length).toBe(3);
    for (let i = 1; i < pings.length; i++) expect(Math.round((pings[i]! - pings[i - 1]!) / 1000)).toBe(KEEPALIVE.serverPingEverySeconds);
    const closeB = fixture.frames.find((r) => r.socket === "B" && r.event === "close")!.data as { code: number; afterSeconds: number };
    expect(closeB.code).toBe(1006);
    expect(Math.round(closeB.afterSeconds)).toBe(KEEPALIVE.closeWithoutPongSeconds);
  });
});
