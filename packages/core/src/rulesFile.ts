import { readFileSync } from "node:fs";
import { RulesSchema, rulesFingerprint, type LoadedRules } from "./rules.js";

/** Reading the rules file from disk (Node only; the rest of the rules code also runs in the browser). */
export function loadRules(path: string): LoadedRules {
  const bytes = readFileSync(path);
  const rules = RulesSchema.parse(JSON.parse(bytes.toString("utf8")));
  return { rules, sha256: rulesFingerprint(bytes) };
}
