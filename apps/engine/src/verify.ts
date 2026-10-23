import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyEvidence, type Check } from "@tug/core";
import { listFiles } from "./evidence.js";

export type { Check };

/** `pnpm verify` on a bundle folder: every file read from disk, then the same checks the `/check` page runs. */
export function verifyBundle(dir: string, o: { rulesSha256: string; strikeFills?: Parameters<typeof verifyEvidence>[1]["strikeFills"] }): Promise<Check[]> {
  const files = new Map(listFiles(dir).map((p) => [p, new Uint8Array(readFileSync(join(dir, p)))]));
  return verifyEvidence(files, {
    rulesSha256: o.rulesSha256,
    sha256: async (b) => createHash("sha256").update(b).digest("hex"),
    gunzip: async (b) => new Uint8Array(gunzipSync(b)),
    strikeFills: o.strikeFills,
  });
}
