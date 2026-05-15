import type { Candle, MarketSnapshot } from "../types/trading";

const UPBIT_BASE_URL = "https://api.upbit.com";
const DEFAULT_REQUEST_DELAY_MS = 120;
const DEFAULT_MAX_RETRIES = 4;
let lastRequestAt = 0;

interface UpbitMarketResponse {
  market: string;
  korean_name: string;
  english_name: string;
}

interface UpbitCandleResponse {
  market: string;
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
}

interface UpbitTickerResponse {
  market: string;
  trade_price: number;
  acc_trade_price_24h: number;
  acc_trade_volume_24h: number;
  signed_change_rate: number;
}

export interface UpbitMarket {
  market: string;
  koreanName: string;
  englishName: string;
}

export async function fetchKrwMarkets(): Promise<UpbitMarket[]> {
  const markets = await fetchUpbitJson<UpbitMarketResponse[]>("/v1/market/all?isDetails=false");

  return markets
    .filter((market) => market.market.startsWith("KRW-"))
    .map((market) => ({
      market: market.market,
      koreanName: market.korean_name,
      englishName: market.english_name,
    }));
}

export async function fetchMinuteCandles(
  market: string,
  unit: 1 | 3 | 5 | 10 | 15 | 30 | 60 | 240,
  count = 200,
  to?: Date,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    market,
    count: String(count),
  });
  if (to) params.set("to", to.toISOString());

  const candles = await fetchUpbitJson<UpbitCandleResponse[]>(`/v1/candles/minutes/${unit}?${params.toString()}`);

  return candles
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
}

export async function fetchTickers(markets: string[]): Promise<MarketSnapshot[]> {
  if (markets.length === 0) return [];
  const params = new URLSearchParams({ markets: markets.join(",") });
  const tickers = await fetchUpbitJson<UpbitTickerResponse[]>(`/v1/ticker?${params.toString()}`);

  return tickers.map((ticker) => ({
    market: ticker.market,
    tradePrice: ticker.trade_price,
    accTradePrice24h: ticker.acc_trade_price_24h,
    accTradeVolume24h: ticker.acc_trade_volume_24h,
    signedChangeRate: ticker.signed_change_rate,
  }));
}

async function fetchUpbitJson<T>(pathname: string): Promise<T> {
  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= DEFAULT_MAX_RETRIES) {
    await waitForRateLimit();
    let response: Response;
    try {
      response = await fetch(`${UPBIT_BASE_URL}${pathname}`, {
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      lastError = error;
      if (attempt === DEFAULT_MAX_RETRIES) break;
      await sleep(getRetryDelayMs(null, attempt));
      attempt += 1;
      continue;
    }

    if (response.ok) return (await response.json()) as T;

    const text = await response.text();
    lastError = new Error(`Upbit request failed ${response.status}: ${text}`);
    if (!shouldRetry(response.status) || attempt === DEFAULT_MAX_RETRIES) break;

    await sleep(getRetryDelayMs(response, attempt));
    attempt += 1;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForRateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < DEFAULT_REQUEST_DELAY_MS) await sleep(DEFAULT_REQUEST_DELAY_MS - elapsed);
  lastRequestAt = Date.now();
}

function shouldRetry(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryDelayMs(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : 0;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
