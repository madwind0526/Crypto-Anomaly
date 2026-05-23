import { describe, expect, it } from "vitest";
import { runPaperTradingSimulation } from "../src/simulation/paperTrading";
import type { TraderOptimizationPlan } from "../src/simulation/traderOptimization";
import type { Candle, Strategy } from "../src/types/trading";

const strategy: Strategy = {
  id: "momentum",
  name: "Paper Test",
  description: "Synthetic paper strategy",
  defaultScenario: {
    id: "base",
    traderId: "momentum",
    name: "Base",
    description: "Synthetic",
    params: {},
  },
  decide(context) {
    if (!context.position && context.candleIndex === 5) {
      return {
        action: "buy",
        confidence: 0.9,
        reasonCodes: ["test-buy"],
        targetWeight: 1,
      };
    }
    if (context.position && context.candleIndex === 12) {
      return {
        action: "sell",
        confidence: 0.9,
        reasonCodes: ["test-sell"],
        targetWeight: 0,
      };
    }
    return {
      action: "hold",
      confidence: 0,
      reasonCodes: ["wait"],
      targetWeight: 0,
    };
  },
};

describe("paper trading simulation", () => {
  it("runs a one-position paper loop from a persisted optimization plan shape", () => {
    const candles = createCandles("KRW-TEST", 20);
    const result = runPaperTradingSimulation(strategy, createPlan(), { "KRW-TEST": candles }, { guideRuleMode: "ignored" });

    expect(result.trades.map((trade) => trade.side)).toEqual(["buy", "sell"]);
    expect(result.decisions.some((decision) => decision.action === "buy")).toBe(true);
    expect(result.finalValue).toBeGreaterThan(0);
  });

  it("produces a profit when buy price is lower than sell price", () => {
    const candles = createCandles("KRW-TEST", 20);
    const result = runPaperTradingSimulation(strategy, createPlan(), { "KRW-TEST": candles }, { guideRuleMode: "ignored" });
    // Candles rise monotonically so the sell should be at a higher price than the buy
    expect(result.finalValue).toBeGreaterThan(result.initialCash);
  });

  it("returns initial cash when no candles are provided", () => {
    const result = runPaperTradingSimulation(strategy, createPlan(), {}, { guideRuleMode: "ignored" });
    expect(result.trades).toHaveLength(0);
    expect(result.finalValue).toBe(result.initialCash);
  });

  it("equity curve has one entry per simulation timestamp", () => {
    const candles = createCandles("KRW-TEST", 20);
    const result = runPaperTradingSimulation(strategy, createPlan(), { "KRW-TEST": candles }, { guideRuleMode: "ignored" });
    // Each timestamp produces one equity curve entry; final close may add one more
    expect(result.equityCurve.length).toBeGreaterThanOrEqual(20);
  });

  it("strict guide-rule mode blocks buys when no confirmations exist (flat candles)", () => {
    // Flat candles produce no trend or MA signal — guide rules should block buys
    const candles = createFlatCandles("KRW-FLAT", 150);
    const result = runPaperTradingSimulation(strategy, createPlanForMarket("KRW-FLAT"), { "KRW-FLAT": candles }, { guideRuleMode: "strict" });
    // Buy at index 5 is blocked by guide rules; no trade should complete
    const buys = result.trades.filter((t) => t.side === "buy");
    expect(buys).toHaveLength(0);
    expect(result.blockedSignals.some((signal) => signal.reason === "guide-rule")).toBe(true);
  });

  it("records safety blocked buy signals when auto block is enabled", () => {
    const candles = createCandles("KRW-TEST", 260);
    const plan = createPlan();
    plan.selectedMarkets[0].bestResult.returnRate = -0.01;
    const result = runPaperTradingSimulation(strategy, plan, { "KRW-TEST": candles }, {
      autoBlockMode: "enabled",
      guideRuleMode: "ignored",
    });

    expect(result.trades.filter((trade) => trade.side === "buy")).toHaveLength(0);
    expect(result.safetyBlockedByMarket["KRW-TEST"]).toBeGreaterThan(0);
    expect(result.blockedSignals.some((signal) => signal.reason === "safety")).toBe(true);
  });
});

function createPlan(): TraderOptimizationPlan {
  return {
    strategyId: "momentum",
    strategyName: "Paper Test",
    guideRuleMode: "ignored",
    candidateMarketCount: 1,
    monitoringMarketCount: 1,
    candidateMarkets: [{ market: "KRW-TEST", tradeValue: 1_000_000, candleCount: 20 }],
    optimizedMarkets: [],
    selectedMarkets: [
      {
        market: "KRW-TEST",
        candidateRank: 1,
        tradeValue: 1_000_000,
        score: 1,
        bestResult: {
          strategyId: "momentum",
          scenarioId: "base",
          scenarioName: "Base",
          market: "KRW-TEST",
          finalValue: 1_050_000,
          returnRate: 0.05,
          maxDrawdown: 0.01,
          winRate: 1,
          tradeCount: 2,
          profitFactor: 1,
          worstTradeReturn: 0,
          guideRuleMode: "ignored",
          guideRejectedSignals: 0,
          trades: [],
          signalAudit: [],
          equityCurve: [],
        },
      },
    ],
  };
}

function createCandles(market: string, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    const close = open + 1;
    return {
      market,
      timestamp: Date.UTC(2026, 4, 12) + index * 60_000,
      open,
      high: close + 1,
      low: open - 1,
      close,
      volume: 1000,
      quoteVolume: 1000 * close,
    };
  });
}

function createFlatCandles(market: string, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    market,
    timestamp: Date.UTC(2026, 4, 12) + index * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    quoteVolume: 100_000,
  }));
}

function createPlanForMarket(market: string): TraderOptimizationPlan {
  return {
    ...createPlan(),
    selectedMarkets: [
      {
        market,
        candidateRank: 1,
        tradeValue: 1_000_000,
        score: 1,
        bestResult: {
          strategyId: "momentum",
          scenarioId: "base",
          scenarioName: "Base",
          market,
          finalValue: 1_000_000,
          returnRate: 0,
          maxDrawdown: 0,
          winRate: 0,
          tradeCount: 0,
          profitFactor: 1,
          worstTradeReturn: 0,
          guideRuleMode: "strict",
          guideRejectedSignals: 0,
          trades: [],
          signalAudit: [],
          equityCurve: [],
        },
      },
    ],
  };
}
