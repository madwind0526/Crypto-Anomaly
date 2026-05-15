import { describe, expect, it } from "vitest";
import { evaluateGuideRules } from "../src/guideRules/evaluator";
import { runBacktest } from "../src/simulation/backtest";
import type { Candle, Strategy, StrategyDecision } from "../src/types/trading";

const alwaysBuyDecision: StrategyDecision = {
  action: "buy",
  confidence: 0.8,
  reasonCodes: ["test-buy"],
  targetWeight: 1,
};

const alwaysBuyStrategy: Strategy = {
  id: "momentum",
  name: "Always Buy Test",
  description: "Test strategy",
  defaultScenario: {
    id: "always-buy",
    traderId: "momentum",
    name: "Always buy",
    description: "Always emits buy",
    params: {},
  },
  decide: () => alwaysBuyDecision,
};

describe("guide rules", () => {
  it("passes ignored mode regardless of trend", () => {
    const candles = createTrendCandles("KRW-DOWN", 140, 1000, -0.003);
    const evaluation = evaluateGuideRules({
      candles,
      candleIndex: candles.length - 1,
      decision: alwaysBuyDecision,
      mode: "ignored",
    });

    expect(evaluation.passed).toBe(true);
    expect(evaluation.reasons).toContain("guide-rules-ignored");
  });

  it("blocks buy signals in strict mode during bearish guide conditions", () => {
    const candles = createTrendCandles("KRW-DOWN", 140, 1000, -0.003);
    const result = runBacktest(alwaysBuyStrategy, alwaysBuyStrategy.defaultScenario, candles, {
      initialCash: 1_000_000,
      feeRate: 0.0005,
      slippageRate: 0.0005,
      guideRuleMode: "strict",
    });

    expect(result.guideRuleMode).toBe("strict");
    expect(result.trades).toHaveLength(0);
    expect(result.guideRejectedSignals).toBeGreaterThan(0);
    expect(result.signalAudit.some((signal) => signal.guideRuleBlockers.length > 0)).toBe(true);
  });

  it("allows the same raw signal in ignored mode", () => {
    const candles = createTrendCandles("KRW-DOWN", 140, 1000, -0.003);
    const result = runBacktest(alwaysBuyStrategy, alwaysBuyStrategy.defaultScenario, candles, {
      initialCash: 1_000_000,
      feeRate: 0.0005,
      slippageRate: 0.0005,
      guideRuleMode: "ignored",
    });

    expect(result.guideRuleMode).toBe("ignored");
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.guideRejectedSignals).toBe(0);
  });
});

function createTrendCandles(market: string, count: number, startPrice: number, drift: number): Candle[] {
  let price = startPrice;
  const candles: Candle[] = [];

  for (let index = 0; index < count; index += 1) {
    const open = price;
    const close = price * (1 + drift);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    candles.push({
      market,
      timestamp: Date.UTC(2026, 4, 1) + index * 5 * 60_000,
      open,
      high,
      low,
      close,
      volume: 1000 + index,
      quoteVolume: (1000 + index) * close,
    });
    price = close;
  }

  return candles;
}
