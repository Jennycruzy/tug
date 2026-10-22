import { loadRules } from "../rules.js";

const file = process.argv[2] ?? "rules/tug-rules-v1.json";
const { rules, sha256 } = loadRules(file);
console.log(`${sha256}  ${file}  (version ${rules.version})`);
