/**
 * fetch-anomaly-1m.mjs
 *
 * Fetches 1m candle data from Upbit for anomaly-selected markets.
 * Market list is read from public/market/anomaly-selection.json
 * (created by anomaly-variants-sim.mjs at daily midnight KST).
 *
 * Output: data/market/upbit-krw-1m-anomaly.json
 *   (separate from Codex's upbit-krw-1m-daily.json which only covers
 *    the General-A/B/C/Anomaly selected markets)
 *
 * Usage:
 *   node scripts/fetch-anomaly-1m.mjs
 *   UPBIT_LOOKBACK_DAYS=2 node scripts/fetch-anomaly-1m.mjs
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const selectionPath = path.join(root, "public", "market", "anomaly-selection.json");

// ── Read anomaly-selected market list ────────────────────────────────────────
let markets = [];
try {
  const saved = JSON.parse(await readFile(selectionPath, "utf8"));
  markets = (saved.markets ?? []).map(m => m.market).filter(Boolean);
  console.log(`Selection date: KST ${saved.date}  (${markets.length} markets)`);
} catch (err) {
  if (err.code === "ENOENT") {
    console.error([
      "anomaly-selection.json not found.",
      "Run 'npm run sim:anomaly' first to generate the market selection,",
      "then run this script to fetch 1m data for those markets.",
    ].join("\n"));
  } else {
    console.error("Failed to read anomaly-selection.json:", err.message);
  }
  process.exit(1);
}

if (markets.length === 0) {
  console.error("anomaly-selection.json has no markets. Re-run sim:anomaly.");
  process.exit(1);
}

console.log(`Markets: ${markets.join(", ")}`);
console.log();

// ── Configure fetch-upbit-market-data.mjs ────────────────────────────────────
process.env.UPBIT_MARKETS           = markets.join(",");
process.env.UPBIT_MARKET_COUNT      = String(markets.length);
process.env.UPBIT_CANDLE_UNIT       = "1";
process.env.UPBIT_LOOKBACK_DAYS     = process.env.UPBIT_LOOKBACK_DAYS ?? "1"; // 24h default
process.env.UPBIT_REQUEST_DELAY_MS  = process.env.UPBIT_REQUEST_DELAY_MS ?? "120";
process.env.UPBIT_PRETTY_JSON       = "false";
process.env.UPBIT_WRITE_PUBLIC      = "false"; // write to data/ only, not public/
process.env.UPBIT_CACHE_LABEL       = "upbit-krw-1m-anomaly";

await import("./fetch-upbit-market-data.mjs");
