/**
 * The fixed public sentence for every event code. Public pages and the public API show only these,
 * never an event's own message, so free text (a typed kill reason, a remote error body) never goes public.
 * The first block is the published error table; the rest are the engine's own codes.
 */
export const PUBLIC_SENTENCES: Record<string, string> = {
  "E-RULES": "The rules file is not one of the published versions.",
  "E-MAP": "A market's mapping failed its price check.",
  "E-PARTIAL": "This snapshot read fewer than 90% of a crowd.",
  "E-STALE": "Data is older than the limit.",
  "E-DROPPED": "Strike accepted an order but never placed it.",
  "E-REJECT": "Strike rejected the order.",
  "E-STOP": "Equity fell below the stop level.",
  "E-MARGIN": "Margin use is above the limit.",
  "E-RATE": "A data source asked us to slow down.",
  "E-CONN": "Your wallet connection could not be verified.",
  "E-BUDGET": "This order would exceed your budget cap.",
  "E-HALT": "Strike reports this account or market is halted.",

  "E-HTTP": "A data source did not answer as expected; the request was retried.",
  "E-UNMAPPED": "Strike lists a market that TUG does not read yet.",
  "E-READ": "One crowd member's positions could not be read this snapshot.",
  "E-BOOK": "Strike's best bid and ask could not be read; the paper record used the mark this snapshot.",
  "E-INTERRUPTED": "A restart interrupted a snapshot; it is marked and left out of the records.",
  "E-CYCLE": "A recording cycle failed; the next one starts on schedule.",
  "E-SKIPPED": "A recording cycle was skipped because the previous one was still running.",
  "E-STRIKE": "Strike returned an error to an order request.",
  "E-KILLED": "The kill switch was turned on: no new orders until it is cleared.",
  "E-KILL-LEFT": "The kill switch ran but orders were still open afterwards.",
  "E-TRADING-OFF": "Trading is off; no order was placed.",
  "E-KEY": "An account key is missing; nothing was signed.",
  "E-STOP-OPEN": "A position could not be confirmed closed after a stop; closing is retried and the owner is alerted.",
  "E-WS": "The account's live connection to Strike dropped; it reconnects and re-reads the account.",
};

export const UNKNOWN_EVENT_SENTENCE = "The engine logged a warning.";

export function publicSentence(code: string | null | undefined): string {
  return (code && PUBLIC_SENTENCES[code]) || UNKNOWN_EVENT_SENTENCE;
}
