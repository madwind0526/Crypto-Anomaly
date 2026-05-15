import { describe, expect, it } from "vitest";
import { selectAnomalyCandidates } from "../src/data/anomalyCandidateSelector";
import { compressAnomalyHistory, pruneCandles } from "../src/data/anomalyRetention";
import type { Candle } from "../src/types/trading";

describe("anomaly data pipeline", () => {
  it("selects likely anomaly candidates from historical candles", () => {
    const calm = createCandles("KRW-CALM", 120, 1_000, 1_000_000);
    const spiky = createCandles("KRW-SPIKE", 120, 1_000, 1_000_000, [30, 60, 90]);

    const candidates = selectAnomalyCandidates(
      {
        "KRW-CALM": calm,
        "KRW-SPIKE": spiky,
      },
      {
        candidateCount: 1,
        minAverageQuoteVolume: 100_000,
        maxAverageQuoteVolume: 10_000_000,
        spikeReturnThreshold: 0.035,
      },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].market).toBe("KRW-SPIKE");
    expect(candidates[0].spikeCount).toBeGreaterThan(0);
  });

  it("compresses 1-minute candles and prunes old history", () => {
    const now = Date.UTC(2026, 4, 12, 0, 9);
    const old = makeCandle("KRW-TEST", now - 91 * 24 * 60 * 60 * 1000, 100);
    const recent = createCandles("KRW-TEST", 10, 100, 1_000, [], now - 9 * 60 * 1000);

    const pruned = pruneCandles([old, ...recent], 90, now);
    const compressed = compressAnomalyHistory(
      {
        "KRW-TEST": [old, ...recent],
      },
      {
        interval: { value: 5, unit: "minute" },
        retentionDays: 90,
        now,
      },
    );

    expect(pruned).toHaveLength(10);
    expect(compressed["KRW-TEST"]).toHaveLength(2);
    expect(compressed["KRW-TEST"][0].timestamp).toBeGreaterThan(old.timestamp);
  });
});

function createCandles(
  market: string,
  count: number,
  startPrice: number,
  quoteVolume: number,
  spikeIndexes: number[] = [],
  startTimestamp = Date.UTC(2026, 4, 11),
): Candle[] {
  let price = startPrice;
  const candles: Candle[] = [];

  for (let index = 0; index < count; index += 1) {
    const isSpike = spikeIndexes.includes(index);
    const open = price;
    const close = isSpike ? price * 1.06 : price * 1.001;
    const fadedClose = spikeIndexes.includes(index - 1) ? price * 0.96 : close;
    const finalClose = isSpike ? close : fadedClose;
    candles.push({
      market,
      timestamp: startTimestamp + index * 60_000,
      open,
      high: Math.max(open, finalClose) * (isSpike ? 1.02 : 1.001),
      low: Math.min(open, finalClose) * 0.999,
      close: finalClose,
      volume: isSpike ? 3000 : 1000,
      quoteVolume: isSpike ? quoteVolume * 4 : quoteVolume,
    });
    price = finalClose;
  }

  return candles;
}

function makeCandle(market: string, timestamp: number, price: number): Candle {
  return {
    market,
    timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
    quoteVolume: price,
  };
}
