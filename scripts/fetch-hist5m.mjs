/**
 * fetch-hist5m.mjs
 *
 * Fetches 90-day 5m candle data from Upbit for all KRW top-30 markets.
 * Used for anomaly detection (10% price / 3x volume pattern scan).
 *
 * Output: data/market/upbit-krw-5m.json
 *
 * Usage:
 *   node scripts/fetch-hist5m.mjs
 *   UPBIT_LOOKBACK_DAYS=30 node scripts/fetch-hist5m.mjs   (shorter lookback)
 */

process.env.UPBIT_CANDLE_UNIT       = "5";
process.env.UPBIT_LOOKBACK_DAYS     = process.env.UPBIT_LOOKBACK_DAYS ?? "90";
process.env.UPBIT_MARKET_COUNT      = process.env.UPBIT_MARKET_COUNT  ?? "30";
process.env.UPBIT_REQUEST_DELAY_MS  = "200";
process.env.UPBIT_PRETTY_JSON       = "false";
process.env.UPBIT_WRITE_PUBLIC      = "false";
process.env.UPBIT_CACHE_LABEL       = "upbit-krw-5m";

console.log(`Fetching 5m candles — ${process.env.UPBIT_LOOKBACK_DAYS} day lookback, top-${process.env.UPBIT_MARKET_COUNT} KRW markets`);
console.log("This takes ~5 minutes due to Upbit rate limits.\n");

await import("./fetch-upbit-market-data.mjs");
