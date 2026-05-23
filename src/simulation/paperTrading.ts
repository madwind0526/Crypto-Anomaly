import { evaluateGuideRules } from "../guideRules/evaluator";
import type {
  BacktestConfig,
  BlockedSignal,
  Candle,
  GuideRuleMode,
  Position,
  SafetyMode,
  Strategy,
  StrategyScenario,
  Trade,
} from "../types/trading";
import { defaultBacktestConfig } from "./backtest";
import { decideDailyOperation, type DailyOperationDecision, type DailySignal } from "./dailyOperation";
import { evaluateSafetyBlock, getDailyReturnAtCandleIndex } from "./safety";
import type { TraderOptimizationPlan } from "./traderOptimization";

export interface PaperTradingOptions {
  autoBlockMode: SafetyMode;
  guideRuleMode: GuideRuleMode;
  maxCandles: number;
  startAt: number | null;
  config: BacktestConfig;
}

export interface PaperTradingDecisionLog {
  timestamp: number;
  action: DailyOperationDecision["action"];
  buyMarket?: string;
  sellMarket?: string;
  portfolioValue: number;
  cash: number;
  positionMarket?: string;
  reasonCodes: string[];
}

export interface PaperTradingResult {
  strategyId: Strategy["id"];
  strategyName: string;
  guideRuleMode: GuideRuleMode;
  startedAt: number;
  endedAt: number;
  initialCash: number;
  finalValue: number;
  returnRate: number;
  autoBlockMode: SafetyMode;
  safetyBlockedSignals: number;
  safetyBlockedByMarket: Record<string, number>;
  blockedSignals: BlockedSignal[];
  trades: Trade[];
  decisions: PaperTradingDecisionLog[];
  equityCurve: Array<{ timestamp: number; value: number }>;
}

const defaultOptions: PaperTradingOptions = {
  autoBlockMode: "disabled",
  guideRuleMode: "strict",
  maxCandles: 288,
  startAt: null,
  config: defaultBacktestConfig,
};

export function runPaperTradingSimulation(
  strategy: Strategy,
  plan: TraderOptimizationPlan,
  candlesByMarket: Record<string, Candle[]>,
  options: Partial<PaperTradingOptions> = {},
): PaperTradingResult {
  const resolved = resolveOptions(options);
  const selectedMarkets = plan.selectedMarkets.filter((item) => (candlesByMarket[item.market] ?? []).length > 0);
  const scenarioById = getScenarioById(strategy);
  const marketPointers = new Map<string, number>();
  const timestamps = getSimulationTimestamps(selectedMarkets.map((item) => candlesByMarket[item.market] ?? []))
    .filter((timestamp) => resolved.startAt === null || timestamp >= resolved.startAt)
    .slice(-resolved.maxCandles);
  let cash = resolved.config.initialCash;
  let position: Position | null = null;
  let lastPositionCandleTimestamp: number | null = null;
  const trades: Trade[] = [];
  const decisions: PaperTradingDecisionLog[] = [];
  const equityCurve: Array<{ timestamp: number; value: number }> = [];
  const blockedSignals: BlockedSignal[] = [];
  const safetyBlockedByMarket: Record<string, number> = {};
  let safetyBlockedSignals = 0;

  for (const timestamp of timestamps) {
    const signals: DailySignal[] = [];
    const candlesAtTime = new Map<string, { candle: Candle; candleIndex: number }>();

    for (const selected of selectedMarkets) {
      const candles = candlesByMarket[selected.market] ?? [];
      const candleIndex = findCandleIndexAtOrBefore(candles, timestamp, marketPointers.get(selected.market) ?? 0);
      if (candleIndex < 0) continue;
      marketPointers.set(selected.market, candleIndex);
      candlesAtTime.set(selected.market, { candle: candles[candleIndex], candleIndex });
    }

    if (position) {
      const candle = candlesAtTime.get(position.market)?.candle;
      if (candle) {
        position.highestPrice = Math.max(position.highestPrice, candle.high);
        if (lastPositionCandleTimestamp !== candle.timestamp) {
          position.holdCandles += 1;
          lastPositionCandleTimestamp = candle.timestamp;
        }
      }
    }

    for (const selected of selectedMarkets) {
      const candleInfo = candlesAtTime.get(selected.market);
      if (!candleInfo) continue;
      const { candleIndex } = candleInfo;
      const candles = candlesByMarket[selected.market] ?? [];
      const scenario = scenarioById.get(selected.bestResult.scenarioId) ?? strategy.defaultScenario;
      const marketPosition = position?.market === selected.market ? position : null;
      const decision = strategy.decide(
        {
          market: selected.market,
          candles,
          candleIndex,
          position: marketPosition,
          portfolioValue: getPortfolioValue(cash, position, candlesAtTime),
        },
        scenario,
      );
      const guideRuleEvaluation = evaluateGuideRules({
        candles,
        candleIndex,
        decision,
        mode: resolved.guideRuleMode,
      });
      let finalAction = decision.action;
      const guideBlocked = decision.action === "buy" && resolved.guideRuleMode === "strict" && !guideRuleEvaluation.passed;
      if (guideBlocked) {
        finalAction = "hold";
        blockedSignals.push({
          market: selected.market,
          timestamp,
          reason: "guide-rule",
          reasonCodes: [...decision.reasonCodes, ...guideRuleEvaluation.reasons],
          guideRuleMode: resolved.guideRuleMode,
          safetyMode: resolved.autoBlockMode,
        });
      }
      if (decision.action === "buy" && !guideBlocked && resolved.autoBlockMode === "enabled") {
        const candlesUntilDecision = candles.slice(0, candleIndex + 1);
        const currentReturn = getDailyReturnAtCandleIndex(candles, candleIndex);
        const safetyEvaluation = evaluateSafetyBlock(selected.bestResult, candlesUntilDecision, currentReturn);
        if (safetyEvaluation.blocked) {
          finalAction = "hold";
          safetyBlockedSignals += 1;
          safetyBlockedByMarket[selected.market] = (safetyBlockedByMarket[selected.market] ?? 0) + 1;
          blockedSignals.push({
            market: selected.market,
            timestamp,
            reason: "safety",
            reasonCodes: [...decision.reasonCodes, ...guideRuleEvaluation.reasons, ...safetyEvaluation.reasons],
            guideRuleMode: resolved.guideRuleMode,
            safetyMode: resolved.autoBlockMode,
          });
        }
      }

      if (finalAction !== "hold") {
        signals.push({
          market: selected.market,
          action: finalAction,
          strength: decision.confidence,
          qualityScore: scoreSelectedMarket(selected.score, selected.bestResult.returnRate, selected.bestResult.maxDrawdown),
          timestamp,
          reasonCodes: [...decision.reasonCodes, ...guideRuleEvaluation.reasons],
        });
      }
    }

    const decision = decideDailyOperation({
      currentPosition: position
        ? {
            market: position.market,
            entryPrice: position.averagePrice,
            currentPrice: candlesAtTime.get(position.market)?.candle.close ?? position.averagePrice,
            quantity: position.quantity,
            openedAt: position.openedAt,
          }
        : null,
      now: timestamp,
      signals,
    });

    if ((decision.action === "sell" || decision.action === "rotate") && position) {
      const candle = candlesAtTime.get(position.market)?.candle;
      if (candle) {
        cash += closePosition(position, candle.close * (1 - resolved.config.slippageRate), timestamp, decision.reasonCodes);
        position = null;
        lastPositionCandleTimestamp = null;
      }
    }

    if ((decision.action === "buy" || decision.action === "rotate") && decision.buyMarket && !position) {
      const candle = candlesAtTime.get(decision.buyMarket)?.candle;
      if (candle && cash > 0) {
        const budget = cash;
        const fillPrice = candle.close * (1 + resolved.config.slippageRate);
        const fee = budget * resolved.config.feeRate;
        const quantity = Math.max(0, (budget - fee) / fillPrice);
        if (quantity > 0) {
          cash -= budget;
          position = {
            market: decision.buyMarket,
            quantity,
            averagePrice: fillPrice,
            openedAt: timestamp,
            highestPrice: fillPrice,
            holdCandles: 0,
          };
          lastPositionCandleTimestamp = candlesAtTime.get(decision.buyMarket)?.candle.timestamp ?? null;
          trades.push({
            market: decision.buyMarket,
            side: "buy",
            timestamp,
            price: fillPrice,
            quantity,
            fee,
            reasonCodes: decision.reasonCodes,
            guideRuleMode: resolved.guideRuleMode,
          });
        }
      }
    }

    const portfolioValue = getPortfolioValue(cash, position, candlesAtTime);
    decisions.push({
      timestamp,
      action: decision.action,
      buyMarket: decision.buyMarket,
      sellMarket: decision.sellMarket,
      portfolioValue,
      cash,
      positionMarket: position?.market,
      reasonCodes: decision.reasonCodes,
    });
    equityCurve.push({ timestamp, value: portfolioValue });
  }

  const lastTimestamp = timestamps[timestamps.length - 1] ?? 0;
  if (position) {
    const candles = candlesByMarket[position.market] ?? [];
    const last = candles[marketPointers.get(position.market) ?? candles.length - 1] ?? candles[candles.length - 1];
    if (last) {
      cash += closePosition(position, last.close * (1 - resolved.config.slippageRate), last.timestamp, ["paper-final-close"]);
      position = null;
      lastPositionCandleTimestamp = null;
      equityCurve.push({ timestamp: last.timestamp, value: cash });
    }
  }

  const finalValue = equityCurve[equityCurve.length - 1]?.value ?? cash;

  return {
    strategyId: strategy.id,
    strategyName: strategy.name,
    guideRuleMode: resolved.guideRuleMode,
    startedAt: timestamps[0] ?? 0,
    endedAt: lastTimestamp,
    initialCash: resolved.config.initialCash,
    finalValue,
    returnRate: (finalValue - resolved.config.initialCash) / resolved.config.initialCash,
    autoBlockMode: resolved.autoBlockMode,
    blockedSignals,
    safetyBlockedByMarket,
    safetyBlockedSignals,
    trades,
    decisions,
    equityCurve,
  };

  function closePosition(positionToClose: Position, price: number, timestamp: number, reasonCodes: string[]) {
    const proceeds = positionToClose.quantity * price;
    const fee = proceeds * resolved.config.feeRate;
    trades.push({
      market: positionToClose.market,
      side: "sell",
      timestamp,
      price,
      quantity: positionToClose.quantity,
      fee,
      reasonCodes,
      guideRuleMode: resolved.guideRuleMode,
    });
    return proceeds - fee;
  }
}

function resolveOptions(options: Partial<PaperTradingOptions>) {
  return {
    ...defaultOptions,
    ...options,
    config: {
      ...defaultOptions.config,
      ...options.config,
      guideRuleMode: options.guideRuleMode ?? options.config?.guideRuleMode ?? defaultOptions.guideRuleMode,
      autoBlockMode: options.autoBlockMode ?? options.config?.autoBlockMode ?? defaultOptions.autoBlockMode,
    },
  };
}

function getScenarioById(strategy: Strategy) {
  const scenarios = strategy.scenarios?.length ? strategy.scenarios : [strategy.defaultScenario];
  return new Map<string, StrategyScenario>(scenarios.map((scenario) => [scenario.id, scenario]));
}

function getSimulationTimestamps(candleSets: Candle[][]) {
  const timestamps = new Set<number>();
  for (const candles of candleSets) {
    for (const candle of candles) timestamps.add(candle.timestamp);
  }
  return [...timestamps].sort((a, b) => a - b);
}

function findCandleIndexAtOrBefore(candles: Candle[], timestamp: number, startIndex: number) {
  if (candles.length === 0) return -1;
  const boundedStart = Math.min(Math.max(0, startIndex), candles.length - 1);
  if (candles[boundedStart].timestamp <= timestamp) {
    const nextIndex = boundedStart + 1;
    if (nextIndex >= candles.length || candles[nextIndex].timestamp > timestamp) return boundedStart;
    return findLastIndexAtOrBefore(candles, timestamp, nextIndex, candles.length - 1);
  }

  return findLastIndexAtOrBefore(candles, timestamp, 0, boundedStart);
}

function findLastIndexAtOrBefore(candles: Candle[], timestamp: number, low: number, high: number) {
  let left = low;
  let right = high;
  let result = -1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (candles[middle].timestamp <= timestamp) {
      result = middle;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  return result;
}

function getPortfolioValue(
  cash: number,
  position: Position | null,
  candlesAtTime: Map<string, { candle: Candle; candleIndex: number }>,
) {
  if (!position) return cash;
  const currentPrice = candlesAtTime.get(position.market)?.candle.close ?? position.averagePrice;
  return cash + position.quantity * currentPrice;
}

function scoreSelectedMarket(score: number, returnRate: number, maxDrawdown: number) {
  const normalizedScore = Number.isFinite(score) ? (Math.tanh(score) + 1) / 2 : 0.5;
  return clamp01(normalizedScore * 0.45 + clamp01(returnRate + 0.5) * 0.35 + (1 - clamp01(maxDrawdown)) * 0.2);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
