import { z } from "zod";

/**
 * Strike user-stream frames, as observed on testnet on 2026-10-22 (fixtures in test/fixtures).
 * Keepalive: the server sends a WebSocket ping every 54 s and closes a socket about 6 s after a ping
 * goes unanswered (code 1006; about 60 s after open for the first ping). Answer pings at once (the ws
 * library's default auto-pong); never delay or batch pongs. After a drop, log on and subscribe again;
 * nothing is replayed, so state is re-read over REST.
 */
export const KEEPALIVE = { serverPingEverySeconds: 54, closeWithoutPongSeconds: 60, closeAfterUnansweredPingSeconds: 6 } as const;

const num = z.union([z.string(), z.number()]).transform((v) => Number(v));

const AckSchema = z.object({ id: z.number(), result: z.unknown(), status: z.number().optional() });

const OrderUpdateSchema = z.object({
  e: z.literal("ORDER_TRADE_UPDATE"),
  E: z.number(),
  data: z
    .object({
      s: z.string(),
      c: z.string(),
      S: z.enum(["BUY", "SELL"]),
      o: z.string(),
      q: num,
      p: num,
      x: z.string(),
      X: z.string(),
      i: z.number(),
      z: num,
      m: z.boolean(),
    })
    .passthrough(),
});

const BalanceUpdateSchema = z.object({
  e: z.literal("ACCOUNT_UPDATE"),
  E: z.number(),
  data: z
    .object({
      e: z.literal("ACCOUNT_UPDATE"),
      B: z.array(z.object({ a: z.string(), wb: num, cw: num }).passthrough()),
      P: z.array(z.unknown()),
      r: z.string(),
    })
    .passthrough(),
});

const AccountEventSchema = z.object({
  e: z.literal("ACCOUNT_UPDATE"),
  E: z.number(),
  data: z.object({ event_type: z.string(), event_data: z.record(z.unknown()) }),
});

export type UserFrame =
  | { kind: "ack"; id: number; result: unknown }
  | { kind: "order"; at: number; order: z.infer<typeof OrderUpdateSchema>["data"] }
  | { kind: "balance"; at: number; reason: string; balances: Array<{ asset: string; wallet: number }>; positions: unknown[] }
  | { kind: "event"; at: number; type: string; data: Record<string, unknown> }
  | { kind: "unknown"; raw: unknown };

/** Classifies one user-stream frame; anything unrecognised is returned as `unknown`, never thrown. */
export function parseUserFrame(frame: unknown): UserFrame {
  const ack = AckSchema.safeParse(frame);
  if (ack.success) return { kind: "ack", id: ack.data.id, result: ack.data.result };
  const order = OrderUpdateSchema.safeParse(frame);
  if (order.success) return { kind: "order", at: order.data.E, order: order.data.data };
  const bal = BalanceUpdateSchema.safeParse(frame);
  if (bal.success) {
    return {
      kind: "balance",
      at: bal.data.E,
      reason: bal.data.data.r,
      balances: bal.data.data.B.map((b) => ({ asset: b.a, wallet: b.wb })),
      positions: bal.data.data.P,
    };
  }
  const ev = AccountEventSchema.safeParse(frame);
  if (ev.success) return { kind: "event", at: ev.data.E, type: ev.data.data.event_type, data: ev.data.data.event_data };
  return { kind: "unknown", raw: frame };
}
