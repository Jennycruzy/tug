// Opens every page of the live site in Chromium at 360 px (and 1366 px) and fails if any page scrolls
// sideways or shows a full Strike account id. `pnpm site:check [base url] [ids file]`; prints one line per page.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "https://tug.38-49-216-59.sslip.io";
const ids: string[] = process.argv[3] ? (JSON.parse(readFileSync(process.argv[3], "utf8")) as string[]) : [];
const PAGES = ["/", "/m/ETH-USD", "/m/LIT-USD", "/m/NIGHT-USD", "/m/CXMT-USD", "/record", "/scoreboard", "/proof", "/check", "/join", "/api", "/status", "/no-such-page"];

const browser = await chromium.launch();
let failed = 0;
for (const width of [360, 1366]) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const path of PAGES) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const de = document.documentElement;
      let widest = "";
      let right = 0;
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const b = el.getBoundingClientRect();
        if (b.right > right) {
          right = b.right;
          widest = `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`;
        }
      }
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, widest, right: Math.round(right), text: document.body.innerText };
    });
    const leaks = ids.filter((id) => r.text.includes(id));
    const ok = r.scrollWidth <= r.clientWidth && leaks.length === 0 && errors.length === 0;
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${width}px ${path} scrollWidth ${r.scrollWidth} / ${r.clientWidth}` +
        (r.scrollWidth > r.clientWidth ? ` (widest ${r.widest} to x=${r.right})` : "") +
        (leaks.length ? ` full Strike ids shown: ${leaks.length}` : "") +
        (errors.length ? ` page errors: ${errors.join("; ")}` : ""),
    );
    errors.length = 0;
  }
  await page.close();
}
await browser.close();
console.log(failed ? `${failed} page checks failed` : "every page fits and shows no full Strike id");
process.exitCode = failed ? 1 : 0;
