import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const UPBIT_BASE_URL = "https://api.upbit.com";
const ROOT = process.cwd();
const UNIT = Number(process.env.UPBIT_CANDLE_UNIT ?? 5);
const CANDLE_COUNT = Number(process.env.UPBIT_CANDLE_COUNT ?? 200);
const LOOKBACK_DAYS = Number(process.env.UPBIT_LOOKBACK_DAYS ?? 0);
const WINDOW_START_DAYS_AGO = Number(process.env.UPBIT_WINDOW_START_DAYS_AGO ?? 0);
const WINDOW_END_DAYS_AGO = Number(process.env.UPBIT_WINDOW_END_DAYS_AGO ?? 0);
const HAS_WINDOW = WINDOW_START_DAYS_AGO > WINDOW_END_DAYS_AGO;
const WINDOW_SPAN_DAYS = HAS_WINDOW ? WINDOW_START_DAYS_AGO - WINDOW_END_DAYS_AGO : 0;
const DERIVED_CANDLE_PAGES =
  HAS_WINDOW
    ? Math.ceil((WINDOW_SPAN_DAYS * 24 * 60) / UNIT / CANDLE_COUNT) + 2
    : LOOKBACK_DAYS > 0
      ? Math.ceil((LOOKBACK_DAYS * 24 * 60) / UNIT / CANDLE_COUNT) + 2
      : 6;
const CANDLE_PAGES = Number(process.env.UPBIT_CANDLE_PAGES ?? DERIVED_CANDLE_PAGES);
const MARKET_COUNT = Number(process.env.UPBIT_MARKET_COUNT ?? 30);
const REQUEST_DELAY_MS = Number(process.env.UPBIT_REQUEST_DELAY_MS ?? 180);
const MAX_RETRIES = Number(process.env.UPBIT_MAX_RETRIES ?? 4);
const WRITE_PUBLIC_CACHE = process.env.UPBIT_WRITE_PUBLIC !== "false";
const PRETTY_JSON = process.env.UPBIT_PRETTY_JSON !== "false";
const ANCHOR_TIMESTAMP = process.env.UPBIT_ANCHOR_ISO ? new Date(process.env.UPBIT_ANCHOR_ISO).getTime() : Date.now();
const WINDOW_SINCE_TIMESTAMP = HAS_WINDOW
  ? ANCHOR_TIMESTAMP - WINDOW_START_DAYS_AGO * 24 * 60 * 60 * 1000
  : 0;
const WINDOW_UNTIL_TIMESTAMP = HAS_WINDOW
  ? ANCHOR_TIMESTAMP - WINDOW_END_DAYS_AGO * 24 * 60 * 60 * 1000
  : Number.POSITIVE_INFINITY;
const SINCE_TIMESTAMP = HAS_WINDOW
  ? WINDOW_SINCE_TIMESTAMP
  : LOOKBACK_DAYS > 0
    ? ANCHOR_TIMESTAMP - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    : 0;
const CACHE_LABEL = process.env.UPBIT_CACHE_LABEL ?? `upbit-krw-${UNIT}m`;

const MARKET_CACHE_PATH = path.join(ROOT, "data", "market", `${CACHE_LABEL}.json`);
const PUBLIC_MARKET_CACHE_PATH = path.join(ROOT, "public", "market", `${CACHE_LABEL}.json`);

async function main() {
  console.log(
    `Fetching Upbit KRW markets: top ${MARKET_COUNT}, ${UNIT}m x ${CANDLE_COUNT} x ${CANDLE_PAGES} pages`,
  );
  if (LOOKBACK_DAYS > 0) {
    console.log(`Target lookback: ${LOOKBACK_DAYS} days from ${new Date(SINCE_TIMESTAMP).toISOString()}`);
  }
  if (HAS_WINDOW) {
    console.log(
      `Target window: ${WINDOW_START_DAYS_AGO}d ago -> ${WINDOW_END_DAYS_AGO}d ago (${new Date(
        WINDOW_SINCE_TIMESTAMP,
      ).toISOString()} -> ${new Date(WINDOW_UNTIL_TIMESTAMP).toISOString()})`,
    );
  }

  const markets = await fetchJson("/v1/market/all?isDetails=false");
  const krwMarkets = markets
    .filter((market) => market.market.startsWith("KRW-"))
    .map((market) => market.market);

  const explicitMarkets = (process.env.UPBIT_MARKETS ?? "")
    .split(",")
    .map((market) => market.trim())
    .filter(Boolean);
  const selectedMarkets =
    explicitMarkets.length > 0
      ? explicitMarkets.filter((market) => krwMarkets.includes(market)).slice(0, MARKET_COUNT)
      : (await fetchTickers(krwMarkets))
          .slice()
          .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
          .slice(0, MARKET_COUNT)
          .map((ticker) => ticker.market);

  if (explicitMarkets.length > 0) {
    console.log(`Using explicit market list: ${selectedMarkets.join(", ")}`);
  }

  const candlesByMarket = {};

  for (const market of selectedMarkets) {
    const candles = await fetchCandles(market);
    candlesByMarket[market] = candles
      .filter(
        (candle) =>
          (SINCE_TIMESTAMP === 0 || candle.timestamp >= SINCE_TIMESTAMP) &&
          (!HAS_WINDOW || candle.timestamp <= WINDOW_UNTIL_TIMESTAMP),
      )
      .map((candle) => ({
        market: candle.market,
        timestamp: candle.timestamp,
        open: candle.opening_price,
        high: candle.high_price,
        low: candle.low_price,
        close: candle.trade_price,
        volume: candle.candle_acc_trade_volume,
        quoteVolume: candle.candle_acc_trade_price,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
    console.log(`Cached ${market}: ${candlesByMarket[market].length} candles`);
  }

  const payload = {
    source: "upbit-public-api",
    generatedAt: new Date().toISOString(),
    marketCount: selectedMarkets.length,
    candleUnitMinutes: UNIT,
    lookbackDays: LOOKBACK_DAYS,
    windowStartDaysAgo: HAS_WINDOW ? WINDOW_START_DAYS_AGO : undefined,
    windowEndDaysAgo: HAS_WINDOW ? WINDOW_END_DAYS_AGO : undefined,
    anchorIso: new Date(ANCHOR_TIMESTAMP).toISOString(),
    candleCount: CANDLE_COUNT,
    candlePages: CANDLE_PAGES,
    candleCountPerMarket: Object.values(candlesByMarket)[0]?.length ?? 0,
    selectedMarkets,
    candlesByMarket,
  };

  await mkdir(path.dirname(MARKET_CACHE_PATH), { recursive: true });
  await writeFile(MARKET_CACHE_PATH, `${JSON.stringify(payload, null, PRETTY_JSON ? 2 : 0)}\n`, "utf8");

  console.log(`Wrote ${path.relative(ROOT, MARKET_CACHE_PATH)}`);
  if (WRITE_PUBLIC_CACHE) {
    await mkdir(path.dirname(PUBLIC_MARKET_CACHE_PATH), { recursive: true });
    await writeFile(PUBLIC_MARKET_CACHE_PATH, `${JSON.stringify(payload)}\n`, "utf8");
    console.log(`Wrote ${path.relative(ROOT, PUBLIC_MARKET_CACHE_PATH)}`);
  } else {
    console.log(`Skipped public cache for ${path.relative(ROOT, PUBLIC_MARKET_CACHE_PATH)}`);
  }
}

async function fetchCandles(market) {
  const all = [];
  let to = HAS_WINDOW ? new Date(WINDOW_UNTIL_TIMESTAMP).toISOString() : undefined;

  for (let page = 0; page < CANDLE_PAGES; page += 1) {
    await sleep(REQUEST_DELAY_MS);
    const params = new URLSearchParams({
      market,
      count: String(CANDLE_COUNT),
    });
    if (to) params.set("to", to);

    const pageCandles = await fetchJson(`/v1/candles/minutes/${UNIT}?${params.toString()}`);
    if (pageCandles.length === 0) break;

    all.push(...pageCandles);
    const oldestTimestamp = Math.min(...pageCandles.map((candle) => candle.timestamp));
    to = new Date(oldestTimestamp - 1).toISOString();
    if (SINCE_TIMESTAMP > 0 && oldestTimestamp <= SINCE_TIMESTAMP) break;
  }

  const uniqueByTimestamp = new Map();
  for (const candle of all) {
    uniqueByTimestamp.set(candle.timestamp, candle);
  }

  return [...uniqueByTimestamp.values()];
}

async function fetchTickers(markets) {
  const chunks = [];
  for (let index = 0; index < markets.length; index += 100) {
    chunks.push(markets.slice(index, index + 100));
  }

  const tickers = [];
  for (const chunk of chunks) {
    await sleep(REQUEST_DELAY_MS);
    const params = new URLSearchParams({ markets: chunk.join(",") });
    tickers.push(...(await fetchJson(`/v1/ticker?${params.toString()}`)));
  }
  return tickers;
}

async function fetchJson(pathname) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch(`${UPBIT_BASE_URL}${pathname}`, {
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      await sleep(getRetryDelayMs(null, attempt));
      continue;
    }

    if (response.ok) return response.json();

    const text = await response.text();
    lastError = new Error(`Upbit request failed ${response.status}: ${text}`);
    if (!shouldRetry(response.status) || attempt === MAX_RETRIES) break;

    await sleep(getRetryDelayMs(response, attempt));
  }

  throw lastError;
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryDelayMs(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
