// The kill switch: `pnpm kill` blocks new orders and cancels every open order; `pnpm kill --clear` lifts the block.
import { NETWORK } from "../config.js";
import { callsSince, executorFromEnv, marketSymbols, saveRun } from "./shared.js";

const started = Date.now();
const { executor, db } = executorFromEnv();
if (process.argv.includes("--clear")) {
  executor.clearKill();
  console.log("kill switch cleared");
} else {
  const reason = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ") || "manual";
  const report = await executor.kill(reason, await marketSymbols());
  const file = saveRun("kill", { network: NETWORK, report, calls: callsSince(db, started) });
  console.log(JSON.stringify({ ...report, file }, null, 1));
  if (report.openAfter !== 0) process.exitCode = 1;
}
db.close();
