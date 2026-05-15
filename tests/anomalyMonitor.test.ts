import { describe, expect, it } from "vitest";
import { buildDailyAnomalyMonitoringPlan, detectAnomalySignal } from "../src/simulation/anomalyMonitor";
import type { Candle } from "../src/types/trading";

describe("anomaly monitor", () => {
  it("detects a buy signal when volume, acceleration, and breakout align", () => {
    const candles = createCandles("KRW-SPIKE", 90, { finalSpike: true });
    const signal = detectAnomalySignal(candles, candles.length - 1, {
      minRelativeVolume: 2,
      minAccelerationReturn: 0.015,
    });

    expect(signal?.action).toBe("buy");
    expect(signal?.reasons).toContain("volume-surge");
    expect(signal?.reasons).toContain("price-acceleration");
    expect(signal?.reasons).toContain("short-breakout");
  });

  it("builds a daily monitoring plan from anomaly candidates", () => {
    const plan = buildDailyAnomalyMonitoringPlan(
      {
        "KRW-CALM": createCandles("KRW-CALM", 120),
        "KRW-SPIKE": createCandles("KRW-SPIKE", 120, { historicalSpikes: [35, 70], finalSpike: true }),
      },
      {
        candidatePoolCount: 2,
        monitoringMarketCount: 1,
        minRelativeVolume: 2,
        minAccelerationReturn: 0.015,
      },
    );

    expect(plan.monitoringMarkets).toHaveLength(1);
    expect(plan.monitoringMarkets[0].market).toBe("KRW-SPIKE");
    expect(plan.latestSignals[0].market).toBe("KRW-SPIKE");
  });

  it("does not score partial lookback windows", () => {
    const signal = detectAnomalySignal(createCandles("KRW-SHORT", 12, { finalSpike: true }), 11, {
      breakoutLookbackCandles: 36,
      extensionLookbackCandles: 72,
      volumeLookbackCandles: 24,
    });

    expect(signal).toBeNull();
  });
});

function createCandles(
  market: string,
  count: number,
  options: { historicalSpikes?: number[]; finalSpike?: boolean } = {},
): Candle[] {
  let price = 1000;
  const candles: Candle[] = [];
  const spikeIndexes = new Set(options.historicalSpikes ?? []);

  for (let index = 0; index < count; index += 1) {
    const finalSpike = options.finalSpike && index === count - 1;
    const historicalSpike = spikeIndexes.has(index);
    const open = price;
    const close = finalSpike || historicalSpike ? open * 1.045 : open * 1.0005;
    const quoteVolume = finalSpike || historicalSpike ? 4_000_000 : 1_000_000;

    candles.push({
      market,
      timestamp: Date.UTC(2026, 4, 1) + index * 60_000,
      open,
      high: Math.max(open, close) * 1.003,
      low: Math.min(open, close) * 0.997,
      close,
      volume: finalSpike || historicalSpike ? 4000 : 1000,
      quoteVolume,
    });

    price = historicalSpike ? close * 0.96 : close;
  }

  return candles;
}
