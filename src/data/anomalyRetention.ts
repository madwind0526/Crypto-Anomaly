import { aggregateCandles, type ChartInterval } from "./candleAggregation";
import type { Candle } from "../types/trading";

export interface CompressAnomalyHistoryOptions {
  interval: ChartInterval;
  retentionDays: number;
  now?: number;
}

export function compressAnomalyHistory(
  candlesByMarket: Record<string, Candle[]>,
  options: CompressAnomalyHistoryOptions,
): Record<string, Candle[]> {
  const cutoff = (options.now ?? Date.now()) - options.retentionDays * 24 * 60 * 60 * 1000;
  const next: Record<string, Candle[]> = {};

  for (const [market, candles] of Object.entries(candlesByMarket)) {
    const retained = candles.filter((candle) => candle.timestamp >= cutoff);
    next[market] = aggregateCandles(retained, options.interval);
  }

  return next;
}

export function pruneCandles(candles: Candle[], retentionDays: number, now = Date.now()) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return candles.filter((candle) => candle.timestamp >= cutoff);
}
