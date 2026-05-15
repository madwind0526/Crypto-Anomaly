import type { BacktestConfig, BacktestResult, Candle, GuideRuleMode, Strategy } from "../types/trading";
import { defaultBacktestConfig, runBacktest } from "./backtest";

export interface StrategyComparison {
  strategyName: string;
  bestResult: BacktestResult;
  testedMarkets: number;
  testedScenarios: number;
}

export interface StrategyGuideModeComparison {
  strategyName: string;
  ignored: StrategyComparison;
  strict: StrategyComparison;
  bestMode: GuideRuleMode;
}

export function compareStrategies(
  strategies: Strategy[],
  marketCandles: Record<string, Candle[]>,
  config?: BacktestConfig,
): StrategyComparison[] {
  return strategies.map((strategy) => {
    const scenarios = strategy.scenarios?.length ? strategy.scenarios : [strategy.defaultScenario];
    const results = Object.values(marketCandles)
      .filter((candles) => candles.length > 60)
      .flatMap((candles) => scenarios.map((scenario) => runBacktest(strategy, scenario, candles, config)));

    const bestResult = results.reduce((best, current) => {
      const currentScore = scoreResult(current);
      const bestScore = scoreResult(best);
      return currentScore > bestScore ? current : best;
    });

    return {
      strategyName: strategy.name,
      bestResult,
      testedMarkets: Object.values(marketCandles).filter((candles) => candles.length > 60).length,
      testedScenarios: scenarios.length,
    };
  });
}

export function compareStrategiesByGuideMode(
  strategies: Strategy[],
  marketCandles: Record<string, Candle[]>,
  config?: BacktestConfig,
): StrategyGuideModeComparison[] {
  const baseConfig = config ?? defaultBacktestConfig;
  const ignored = compareStrategies(strategies, marketCandles, {
    ...baseConfig,
    guideRuleMode: "ignored",
  });
  const strict = compareStrategies(strategies, marketCandles, {
    ...baseConfig,
    guideRuleMode: "strict",
  });

  return strategies.map((strategy) => {
    const ignoredComparison = ignored.find((comparison) => comparison.bestResult.strategyId === strategy.id);
    const strictComparison = strict.find((comparison) => comparison.bestResult.strategyId === strategy.id);
    if (!ignoredComparison || !strictComparison) {
      throw new Error(`Missing guide-mode comparison for ${strategy.id}`);
    }

    return {
      strategyName: strategy.name,
      ignored: ignoredComparison,
      strict: strictComparison,
      bestMode:
        scoreBacktestResult(strictComparison.bestResult) >= scoreBacktestResult(ignoredComparison.bestResult)
          ? "strict"
          : "ignored",
    };
  });
}

export function scoreBacktestResult(result: BacktestResult): number {
  const drawdownPenalty = result.maxDrawdown * 1.5;
  const activityPenalty = result.tradeCount < 2 ? 0.08 : 0;
  return result.returnRate - drawdownPenalty + result.winRate * 0.05 - activityPenalty;
}

const scoreResult = scoreBacktestResult;
