import type { BacktestConfig, BacktestResult, Candle, GuideRuleMode, Strategy } from "../types/trading";
import { defaultBacktestConfig, runBacktest } from "./backtest";
import { scoreBacktestResult } from "./optimizer";

export interface MarketTradeValueRank {
  market: string;
  tradeValue: number;
  candleCount: number;
}

export interface MarketScenarioOptimization {
  market: string;
  candidateRank: number;
  tradeValue: number;
  score: number;
  bestResult: BacktestResult;
}

export interface TraderOptimizationOptions {
  candidateMarketCount: number;
  monitoringMarketCount: number;
  tradeValueLookbackCandles: number;
  optimizationLookbackCandles: number;
  minCandles: number;
  guideRuleMode: GuideRuleMode;
  config?: BacktestConfig;
}

export interface TraderOptimizationPlan {
  strategyId: Strategy["id"];
  strategyName: string;
  guideRuleMode: GuideRuleMode;
  candidateMarketCount: number;
  monitoringMarketCount: number;
  candidateMarkets: MarketTradeValueRank[];
  optimizedMarkets: MarketScenarioOptimization[];
  selectedMarkets: MarketScenarioOptimization[];
}

const defaultOptions: TraderOptimizationOptions = {
  candidateMarketCount: 30,
  monitoringMarketCount: 12,
  tradeValueLookbackCandles: 288,
  optimizationLookbackCandles: Number.POSITIVE_INFINITY,
  minCandles: 120,
  guideRuleMode: "strict",
};

export function selectTopMarketsByTradeValue(
  candlesByMarket: Record<string, Candle[]>,
  count: number,
  lookbackCandles = defaultOptions.tradeValueLookbackCandles,
  minCandles = defaultOptions.minCandles,
): MarketTradeValueRank[] {
  return Object.entries(candlesByMarket)
    .map(([market, candles]) => ({
      market,
      tradeValue: sumRecentTradeValue(candles, lookbackCandles),
      candleCount: candles.length,
    }))
    .filter((rank) => rank.candleCount >= minCandles && rank.tradeValue > 0)
    .sort((a, b) => b.tradeValue - a.tradeValue)
    .slice(0, count);
}

export function buildTraderOptimizationPlan(
  strategy: Strategy,
  candlesByMarket: Record<string, Candle[]>,
  options: Partial<TraderOptimizationOptions> = {},
): TraderOptimizationPlan {
  const resolved = { ...defaultOptions, ...options };
  const config = {
    ...defaultBacktestConfig,
    ...resolved.config,
    guideRuleMode: resolved.guideRuleMode,
  };
  const candidateMarkets = selectTopMarketsByTradeValue(
    candlesByMarket,
    resolved.candidateMarketCount,
    resolved.tradeValueLookbackCandles,
    resolved.minCandles,
  );

  const optimizedMarkets = candidateMarkets
    .map((candidate, index) => {
      const candles = trimCandles(candlesByMarket[candidate.market] ?? [], resolved.optimizationLookbackCandles);
      const bestResult = optimizeStrategyForMarket(strategy, candles, config);
      if (!bestResult) return null;

      return {
        market: candidate.market,
        candidateRank: index + 1,
        tradeValue: candidate.tradeValue,
        score: scoreBacktestResult(bestResult),
        bestResult,
      };
    })
    .filter((result): result is MarketScenarioOptimization => result !== null)
    .sort((a, b) => b.score - a.score);

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    guideRuleMode: resolved.guideRuleMode,
    candidateMarketCount: resolved.candidateMarketCount,
    monitoringMarketCount: resolved.monitoringMarketCount,
    candidateMarkets,
    optimizedMarkets,
    selectedMarkets: optimizedMarkets.slice(0, resolved.monitoringMarketCount),
  };
}

export function buildTraderOptimizationPlans(
  strategies: Strategy[],
  candlesByMarket: Record<string, Candle[]>,
  options: Partial<TraderOptimizationOptions> = {},
): TraderOptimizationPlan[] {
  return strategies.map((strategy) => buildTraderOptimizationPlan(strategy, candlesByMarket, options));
}

function optimizeStrategyForMarket(
  strategy: Strategy,
  candles: Candle[],
  config: BacktestConfig,
): BacktestResult | null {
  if (candles.length === 0) return null;
  const scenarios = strategy.scenarios?.length ? strategy.scenarios : [strategy.defaultScenario];
  const results = scenarios.map((scenario) => runBacktest(strategy, scenario, candles, config));
  return results.reduce((best, current) =>
    scoreBacktestResult(current) > scoreBacktestResult(best) ? current : best,
  );
}

function sumRecentTradeValue(candles: Candle[], lookbackCandles: number) {
  return candles
    .slice(Math.max(0, candles.length - lookbackCandles))
    .reduce((sum, candle) => sum + candle.quoteVolume, 0);
}

function trimCandles(candles: Candle[], maxCandles: number) {
  if (!Number.isFinite(maxCandles) || maxCandles <= 0 || candles.length <= maxCandles) return candles;
  return candles.slice(candles.length - maxCandles);
}
