import { ema, sma } from "../indicators/technical";
import type {
  Candle,
  GuideMovingAverageState,
  GuideRuleEvaluation,
  GuideRuleMode,
  GuideTrendState,
  StrategyDecision,
} from "../types/trading";

interface GuideRuleContext {
  candles: Candle[];
  candleIndex: number;
  decision: StrategyDecision;
  mode: GuideRuleMode;
}

interface DowTheoryEvaluation {
  state: GuideTrendState;
  higherHigh: boolean;
  higherLow: boolean;
  lowerHigh: boolean;
  lowerLow: boolean;
}

interface MovingAverageEvaluation {
  state: GuideMovingAverageState;
  shortAboveMedium: boolean;
  mediumAboveLong: boolean;
  mediumSlopeUp: boolean;
  longSlopeUp: boolean;
}

interface SupportResistanceEvaluation {
  nearSupport: boolean;
  nearResistance: boolean;
  resistanceBreakout: boolean;
  supportBreakdown: boolean;
}

interface CandleWarningEvaluation {
  bearishTopWarning: boolean;
  bullishReversalHint: boolean;
}

const MIN_LOOKBACK = 80;

export function evaluateGuideRules({
  candleIndex,
  candles,
  decision,
  mode,
}: GuideRuleContext): GuideRuleEvaluation {
  const trend = evaluateDowTheory(candles, candleIndex);
  const movingAverage = evaluateMovingAverages(candles, candleIndex);
  const supportResistance = evaluateSupportResistance(candles, candleIndex);
  const candleWarning = evaluateCandlestickWarnings(candles, candleIndex);

  if (mode === "ignored") {
    return {
      mode,
      passed: true,
      score: 1,
      reasons: ["guide-rules-ignored"],
      blockers: [],
      warnings: [],
      trend: trend.state,
      movingAverage: movingAverage.state,
    };
  }

  if (decision.action === "hold") {
    return {
      mode,
      passed: true,
      score: 0,
      reasons: ["no-action"],
      blockers: [],
      warnings: [],
      trend: trend.state,
      movingAverage: movingAverage.state,
    };
  }

  if (decision.action === "sell") {
    return {
      mode,
      passed: true,
      score: 1,
      reasons: ["sell-signal-allowed"],
      blockers: [],
      warnings: candleWarning.bearishTopWarning ? ["bearish-candle-warning"] : [],
      trend: trend.state,
      movingAverage: movingAverage.state,
    };
  }

  const confirmations = [
    trend.state === "uptrend" ? "dow-uptrend" : null,
    movingAverage.state === "bullish" ? "ma-bullish" : null,
    supportResistance.nearSupport ? "near-support" : null,
    supportResistance.resistanceBreakout ? "resistance-breakout" : null,
    candleWarning.bullishReversalHint ? "bullish-reversal-candle" : null,
  ].filter((value): value is string => value !== null);

  const blockers = [
    trend.state === "downtrend" && !supportResistance.resistanceBreakout ? "dow-downtrend" : null,
    movingAverage.state === "bearish" && !supportResistance.nearSupport ? "ma-bearish" : null,
    supportResistance.nearResistance && !supportResistance.resistanceBreakout ? "near-resistance" : null,
    supportResistance.supportBreakdown ? "support-breakdown" : null,
    candleWarning.bearishTopWarning ? "bearish-candle-warning" : null,
  ].filter((value): value is string => value !== null);

  const hasEnoughData = candleIndex >= MIN_LOOKBACK;
  const passed = hasEnoughData && confirmations.length >= 2 && blockers.length === 0;
  const score = clamp01(confirmations.length / 4 - blockers.length * 0.3);

  return {
    mode,
    passed,
    score,
    reasons: confirmations.length > 0 ? confirmations : ["no-guide-confirmation"],
    blockers: hasEnoughData ? blockers : ["insufficient-guide-history"],
    warnings: candleWarning.bearishTopWarning ? ["bearish-candle-warning"] : [],
    trend: trend.state,
    movingAverage: movingAverage.state,
  };
}

export function evaluateDowTheory(candles: Candle[], candleIndex: number): DowTheoryEvaluation {
  const window = getWindow(candles, candleIndex, 60);
  if (window.length < 20) {
    return {
      state: "unknown",
      higherHigh: false,
      higherLow: false,
      lowerHigh: false,
      lowerLow: false,
    };
  }

  const previous = window.slice(0, Math.floor(window.length / 2));
  const recent = window.slice(Math.floor(window.length / 2));
  const previousHigh = Math.max(...previous.map((candle) => candle.high));
  const previousLow = Math.min(...previous.map((candle) => candle.low));
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const recentLow = Math.min(...recent.map((candle) => candle.low));
  const higherHigh = recentHigh > previousHigh;
  const higherLow = recentLow > previousLow;
  const lowerHigh = recentHigh < previousHigh;
  const lowerLow = recentLow < previousLow;

  const state: GuideTrendState =
    higherHigh && higherLow ? "uptrend" : lowerHigh && lowerLow ? "downtrend" : "sideways";

  return {
    state,
    higherHigh,
    higherLow,
    lowerHigh,
    lowerLow,
  };
}

export function evaluateMovingAverages(candles: Candle[], candleIndex: number): MovingAverageEvaluation {
  const closes = candles.map((candle) => candle.close);
  const short = ema(closes, 10);
  const medium = ema(closes, 50);
  const long = ema(closes, 100);
  const shortValue = short[candleIndex];
  const mediumValue = medium[candleIndex];
  const longValue = long[candleIndex];
  const mediumPast = medium[Math.max(0, candleIndex - 10)];
  const longPast = long[Math.max(0, candleIndex - 10)];

  if (
    shortValue === null ||
    mediumValue === null ||
    longValue === null ||
    mediumPast === null ||
    longPast === null
  ) {
    return {
      state: "unknown",
      shortAboveMedium: false,
      mediumAboveLong: false,
      mediumSlopeUp: false,
      longSlopeUp: false,
    };
  }

  const shortAboveMedium = shortValue > mediumValue;
  const mediumAboveLong = mediumValue > longValue;
  const mediumSlopeUp = mediumValue > mediumPast;
  const longSlopeUp = longValue >= longPast;
  const state: GuideMovingAverageState =
    shortAboveMedium && mediumAboveLong && mediumSlopeUp
      ? "bullish"
      : !shortAboveMedium && !mediumAboveLong && !mediumSlopeUp
        ? "bearish"
        : "mixed";

  return {
    state,
    shortAboveMedium,
    mediumAboveLong,
    mediumSlopeUp,
    longSlopeUp,
  };
}

export function evaluateSupportResistance(candles: Candle[], candleIndex: number): SupportResistanceEvaluation {
  const current = candles[candleIndex];
  const previousWindow = getWindow(candles, candleIndex - 1, 48);
  if (!current || previousWindow.length < 12) {
    return {
      nearSupport: false,
      nearResistance: false,
      resistanceBreakout: false,
      supportBreakdown: false,
    };
  }

  const support = Math.min(...previousWindow.map((candle) => candle.low));
  const resistance = Math.max(...previousWindow.map((candle) => candle.high));
  const threshold = Math.max(0.006, averageTrueRangePct(previousWindow) * 0.8);
  const nearSupport = Math.abs(current.close - support) / current.close <= threshold;
  const nearResistance = Math.abs(resistance - current.close) / current.close <= threshold;
  const resistanceBreakout = current.close > resistance * 1.002;
  const supportBreakdown = current.close < support * 0.998;

  return {
    nearSupport,
    nearResistance,
    resistanceBreakout,
    supportBreakdown,
  };
}

export function evaluateCandlestickWarnings(candles: Candle[], candleIndex: number): CandleWarningEvaluation {
  const current = candles[candleIndex];
  const previous = candles[candleIndex - 1];
  const recent = getWindow(candles, candleIndex, 12);
  if (!current || !previous || recent.length < 4) {
    return {
      bearishTopWarning: false,
      bullishReversalHint: false,
    };
  }

  const range = Math.max(current.high - current.low, Number.EPSILON);
  const body = Math.abs(current.close - current.open);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const recentHigh = Math.max(...recent.map((candle) => candle.high));
  const nearRecentHigh = current.high >= recentHigh * 0.995;
  const bearishEngulfing =
    current.close < current.open &&
    previous.close > previous.open &&
    current.open >= previous.close &&
    current.close <= previous.open;
  const shootingStar = nearRecentHigh && upperWick / range >= 0.55 && body / range <= 0.35;
  const longLowerReversal = lowerWick / range >= 0.5 && current.close > current.open;

  return {
    bearishTopWarning: bearishEngulfing || shootingStar,
    bullishReversalHint: longLowerReversal,
  };
}

function getWindow(candles: Candle[], candleIndex: number, size: number) {
  if (candleIndex < 0) return [];
  return candles.slice(Math.max(0, candleIndex + 1 - size), candleIndex + 1);
}

function averageTrueRangePct(candles: Candle[]) {
  if (candles.length === 0) return 0;
  const ranges = candles.map((candle) => (candle.high - candle.low) / candle.close);
  const values = sma(ranges, Math.min(14, ranges.length)).filter((value): value is number => value !== null);
  if (values.length === 0) return 0;
  return values[values.length - 1];
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
