import type { Candle } from "../types/trading";

const markets = ["KRW-BTC", "KRW-ETH", "KRW-XRP", "KRW-SOL", "KRW-DOGE", "KRW-ADA"];

export function createSampleCandles(market: string, length = 240): Candle[] {
  const marketIndex = Math.max(markets.indexOf(market), 0);
  const seedPrice = 10000 * (marketIndex + 2);
  const baseTime = Date.UTC(2026, 4, 1);
  let price = seedPrice;

  return Array.from({ length }, (_, index) => {
    const trend = Math.sin(index / (18 + marketIndex)) * 0.008;
    const drift = marketIndex % 2 === 0 ? 0.0018 : -0.0004;
    const anomaly = market === "KRW-XRP" && index > 145 && index < 160 ? 0.022 : 0;
    const range = market === "KRW-DOGE" ? Math.sin(index / 5) * 0.012 : 0;
    const change = trend + drift + anomaly + range;
    const open = price;
    price = Math.max(10, price * (1 + change));
    const close = price;
    const high = Math.max(open, close) * (1 + 0.004 + Math.abs(change) * 0.25);
    const low = Math.min(open, close) * (1 - 0.004 - Math.abs(change) * 0.2);
    const volumeBoost = anomaly > 0 ? 8 : 1 + Math.abs(change) * 80;
    const volume = (100 + index * 0.6 + marketIndex * 25) * volumeBoost;

    return {
      market,
      timestamp: baseTime + index * 5 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
      quoteVolume: volume * close,
    };
  });
}

export function createSampleMarketSet(): Record<string, Candle[]> {
  return Object.fromEntries(markets.map((market) => [market, createSampleCandles(market)]));
}

