import type { Candle } from "../types/trading";

export type ChartIntervalUnit = "minute" | "hour" | "day" | "month";

export interface ChartInterval {
  value: number;
  unit: ChartIntervalUnit;
}

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function normalizeChartInterval(interval: ChartInterval): ChartInterval {
  const safeValue = Number.isFinite(interval.value) ? Math.max(1, Math.floor(interval.value)) : 1;
  return {
    value: safeValue,
    unit: interval.unit,
  };
}

export function aggregateCandles(candles: Candle[], interval: ChartInterval): Candle[] {
  const normalized = normalizeChartInterval(interval);
  if (candles.length === 0) return [];

  const sorted = candles.slice().sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, Candle>();

  for (const candle of sorted) {
    const bucketTimestamp = getBucketTimestamp(candle.timestamp, normalized);
    const current = buckets.get(bucketTimestamp);

    if (!current) {
      buckets.set(bucketTimestamp, {
        ...candle,
        timestamp: bucketTimestamp,
      });
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
    current.quoteVolume += candle.quoteVolume;
  }

  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function getBucketTimestamp(timestamp: number, interval: ChartInterval) {
  if (interval.unit === "month") {
    return getMonthBucketTimestamp(timestamp, interval.value);
  }

  const duration =
    interval.unit === "minute"
      ? interval.value * MS_PER_MINUTE
      : interval.unit === "hour"
        ? interval.value * MS_PER_HOUR
        : interval.value * MS_PER_DAY;

  return Math.floor(timestamp / duration) * duration;
}

function getMonthBucketTimestamp(timestamp: number, monthStep: number) {
  const date = new Date(timestamp);
  const monthIndex = date.getFullYear() * 12 + date.getMonth();
  const bucketMonthIndex = Math.floor(monthIndex / monthStep) * monthStep;
  const year = Math.floor(bucketMonthIndex / 12);
  const month = bucketMonthIndex % 12;
  return new Date(year, month, 1).getTime();
}
