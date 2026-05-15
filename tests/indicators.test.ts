import { describe, expect, it } from "vitest";
import { averageTrueRange, bollinger, ema, macd, rateOfChange, rsi, sma } from "../src/indicators/technical";
import type { Candle } from "../src/types/trading";

describe("sma", () => {
  it("returns null for values before period is reached", () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });

  it("returns null array for single-value input shorter than period", () => {
    expect(sma([5], 3)).toEqual([null]);
  });

  it("handles period === length correctly", () => {
    expect(sma([1, 2, 3], 3)).toEqual([null, null, 2]);
  });

  it("returns all values when period === 1", () => {
    expect(sma([4, 5, 6], 1)).toEqual([4, 5, 6]);
  });
});

describe("ema", () => {
  it("returns null for values before period is reached", () => {
    const values = ema([1, 2, 3, 4, 5], 3);
    expect(values[0]).toBeNull();
    expect(values[1]).toBeNull();
    expect(values[2]).toBe(2);
  });

  it("produces values greater than sma after a sustained rise", () => {
    const values = ema([1, 2, 3, 4, 5, 6, 7], 3);
    const last = values[values.length - 1] as number;
    expect(last).toBeGreaterThan(5);
  });

  it("handles empty array", () => {
    expect(ema([], 3)).toEqual([]);
  });
});

describe("rsi", () => {
  it("is bounded between 0 and 100", () => {
    const values = rsi([1, 2, 3, 2, 4, 5, 4, 6, 7, 8], 3);
    const latest = values[values.length - 1];
    expect(latest).not.toBeNull();
    expect(latest).toBeGreaterThanOrEqual(0);
    expect(latest).toBeLessThanOrEqual(100);
  });

  it("returns 100 when all moves are gains (no losses)", () => {
    const allGains = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const values = rsi(allGains, 3);
    const nonNull = values.filter((v) => v !== null) as number[];
    expect(nonNull.every((v) => v === 100)).toBe(true);
  });

  it("returns null for all values when length <= period", () => {
    const values = rsi([1, 2, 3], 14);
    expect(values.every((v) => v === null)).toBe(true);
  });

  it("returns approximately 50 for alternating up/down moves of equal size", () => {
    const zigzag = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
    const values = rsi(zigzag, 14);
    const last = values[values.length - 1] as number;
    expect(last).toBeGreaterThan(40);
    expect(last).toBeLessThan(60);
  });
});

describe("macd", () => {
  it("returns null for macdLine before slow EMA is ready", () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = macd(prices, 12, 26, 9);
    expect(result.macdLine[0]).toBeNull();
    expect(result.macdLine[24]).toBeNull();
    expect(result.macdLine[25]).not.toBeNull();
  });

  it("histogram is macdLine minus signalLine", () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
    const result = macd(prices, 12, 26, 9);
    const idx = prices.length - 1;
    if (result.macdLine[idx] !== null && result.signalLine[idx] !== null) {
      const expected = (result.macdLine[idx] as number) - (result.signalLine[idx] as number);
      expect(result.histogram[idx]).toBeCloseTo(expected, 8);
    }
  });

  it("handles empty array", () => {
    const result = macd([], 12, 26, 9);
    expect(result.macdLine).toEqual([]);
    expect(result.histogram).toEqual([]);
  });
});

describe("bollinger", () => {
  it("returns null before period is reached", () => {
    const prices = [1, 2, 3, 4, 5];
    const result = bollinger(prices, 3, 2);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();
  });

  it("upper band is above middle and lower band is below", () => {
    const prices = [10, 11, 12, 10, 9, 11, 13, 10, 12, 11];
    const result = bollinger(prices, 5, 2);
    const last = result[result.length - 1];
    expect(last).not.toBeNull();
    if (last) {
      expect(last.upper).toBeGreaterThan(last.middle);
      expect(last.lower).toBeLessThan(last.middle);
    }
  });

  it("bands collapse to middle when all prices are identical", () => {
    const prices = Array(10).fill(100) as number[];
    const result = bollinger(prices, 5, 2);
    const last = result[result.length - 1];
    expect(last).not.toBeNull();
    if (last) {
      expect(last.upper).toBeCloseTo(100, 8);
      expect(last.lower).toBeCloseTo(100, 8);
      expect(last.widthPct).toBeCloseTo(0, 8);
    }
  });
});

describe("averageTrueRange", () => {
  it("returns null before period is reached", () => {
    const candles = makeCandles([10, 11, 12, 10, 9], 3);
    const result = averageTrueRange(candles, 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();
  });

  it("is always non-negative", () => {
    const candles = makeCandles([100, 98, 102, 99, 105, 103, 107], 5);
    const result = averageTrueRange(candles, 5);
    result.filter((v) => v !== null).forEach((v) => expect(v).toBeGreaterThanOrEqual(0));
  });

  it("produces higher ATR for volatile candles", () => {
    const calm = makeCandles([100, 100.1, 100.2, 100.1, 100.2], 5);
    const volatile = makeCandles([100, 105, 95, 108, 92], 5);
    const atrCalm = averageTrueRange(calm, 3);
    const atrVolatile = averageTrueRange(volatile, 3);
    const lastCalm = atrCalm[atrCalm.length - 1] as number;
    const lastVolatile = atrVolatile[atrVolatile.length - 1] as number;
    expect(lastVolatile).toBeGreaterThan(lastCalm);
  });
});

describe("rateOfChange", () => {
  it("returns null for indexes before period", () => {
    const result = rateOfChange([1, 2, 3, 4], 2);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();
  });

  it("calculates correct percentage change", () => {
    const result = rateOfChange([100, 110], 1);
    expect(result[1]).toBeCloseTo(0.1, 8);
  });

  it("returns 0 when previous value is 0 (division guard)", () => {
    const result = rateOfChange([0, 5], 1);
    expect(result[1]).toBe(0);
  });

  it("handles single-value array", () => {
    expect(rateOfChange([42], 1)).toEqual([null]);
  });
});

function makeCandles(closes: number[], _period: number): Candle[] {
  return closes.map((close, index) => ({
    market: "KRW-TEST",
    timestamp: Date.UTC(2026, 4, 1) + index * 60_000,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1000,
    quoteVolume: close * 1000,
  }));
}
