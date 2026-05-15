import { selectAnomalyCandidates, type AnomalyCandidate } from "../data/anomalyCandidateSelector";
import type { Candle } from "../types/trading";

export type AnomalySignalAction = "watch" | "buy" | "exit-watch";

export interface AnomalyMonitorOptions {
  monitoringMarketCount: number;
  candidatePoolCount: number;
  volumeLookbackCandles: number;
  minRelativeVolume: number;
  accelerationLookbackCandles: number;
  minAccelerationReturn: number;
  breakoutLookbackCandles: number;
  maxExtendedMove: number;
  extensionLookbackCandles: number;
  buyScoreThreshold: number;
  watchScoreThreshold: number;
}

export interface AnomalyMonitorSignal {
  market: string;
  timestamp: number;
  close: number;
  score: number;
  action: AnomalySignalAction;
  relativeVolume: number;
  accelerationReturn: number;
  extensionReturn: number;
  breakout: boolean;
  reasons: string[];
}

export interface DailyAnomalyMonitoringPlan {
  candidates: AnomalyCandidate[];
  monitoringMarkets: AnomalyCandidate[];
  latestSignals: AnomalyMonitorSignal[];
}

const defaultOptions: AnomalyMonitorOptions = {
  monitoringMarketCount: 12,
  candidatePoolCount: 30,
  volumeLookbackCandles: 24,
  minRelativeVolume: 2.2,
  accelerationLookbackCandles: 3,
  minAccelerationReturn: 0.018,
  breakoutLookbackCandles: 36,
  maxExtendedMove: 0.12,
  extensionLookbackCandles: 72,
  buyScoreThreshold: 0.72,
  watchScoreThreshold: 0.5,
};

export function buildDailyAnomalyMonitoringPlan(
  candlesByMarket: Record<string, Candle[]>,
  options: Partial<AnomalyMonitorOptions> = {},
): DailyAnomalyMonitoringPlan {
  const resolved = { ...defaultOptions, ...options };
  const candidates = selectAnomalyCandidates(candlesByMarket, {
    candidateCount: resolved.candidatePoolCount,
  });
  const monitoringMarkets = candidates.slice(0, resolved.monitoringMarketCount);
  const latestSignals = scanAnomalyMonitoringMarkets(
    candlesByMarket,
    monitoringMarkets.map((candidate) => candidate.market),
    resolved,
  );

  return {
    candidates,
    monitoringMarkets,
    latestSignals,
  };
}

export function scanAnomalyMonitoringMarkets(
  candlesByMarket: Record<string, Candle[]>,
  markets: string[],
  options: Partial<AnomalyMonitorOptions> = {},
): AnomalyMonitorSignal[] {
  const resolved = { ...defaultOptions, ...options };

  return markets
    .map((market) => {
      const candles = candlesByMarket[market] ?? [];
      return detectAnomalySignal(candles, candles.length - 1, resolved);
    })
    .filter((signal): signal is AnomalyMonitorSignal => signal !== null)
    .sort((a, b) => b.score - a.score);
}

export function detectAnomalySignal(
  candles: Candle[],
  candleIndex: number,
  options: Partial<AnomalyMonitorOptions> = {},
): AnomalyMonitorSignal | null {
  const resolved = { ...defaultOptions, ...options };
  const sorted = candles.slice().sort((a, b) => a.timestamp - b.timestamp);
  const index = Math.min(candleIndex, sorted.length - 1);
  const minIndex = Math.max(
    resolved.volumeLookbackCandles,
    resolved.accelerationLookbackCandles,
    resolved.breakoutLookbackCandles,
    resolved.extensionLookbackCandles,
  );
  if (index < minIndex || index < 0) return null;

  const current = sorted[index];
  const volumeWindow = sorted.slice(index - resolved.volumeLookbackCandles, index);
  const breakoutWindow = sorted.slice(index - resolved.breakoutLookbackCandles, index);
  if (volumeWindow.length < resolved.volumeLookbackCandles || breakoutWindow.length < resolved.breakoutLookbackCandles) {
    return null;
  }

  const relativeVolume = current.quoteVolume / Math.max(1, average(volumeWindow.map((candle) => candle.quoteVolume)));
  const accelerationBase = sorted[index - resolved.accelerationLookbackCandles];
  const accelerationReturn = accelerationBase.close > 0 ? (current.close - accelerationBase.close) / accelerationBase.close : 0;
  const previousHigh = Math.max(...breakoutWindow.map((candle) => candle.high));
  const breakout = current.close > previousHigh;
  const extensionBase = sorted[index - resolved.extensionLookbackCandles];
  const extensionReturn = extensionBase.close > 0 ? (current.close - extensionBase.close) / extensionBase.close : 0;

  const volumeScore = clamp01(relativeVolume / resolved.minRelativeVolume);
  const accelerationScore = clamp01(accelerationReturn / resolved.minAccelerationReturn);
  const breakoutScore = breakout ? 1 : 0;
  const extensionPenalty = extensionReturn > resolved.maxExtendedMove ? clamp01((extensionReturn - resolved.maxExtendedMove) / 0.12) : 0;
  const score = clamp01(volumeScore * 0.35 + accelerationScore * 0.35 + breakoutScore * 0.2 + (1 - extensionPenalty) * 0.1);
  const reasons = buildReasons({
    accelerationReturn,
    breakout,
    extensionPenalty,
    relativeVolume,
    resolved,
  });
  const action =
    extensionPenalty >= 0.75
      ? "exit-watch"
      : score >= resolved.buyScoreThreshold
        ? "buy"
        : score >= resolved.watchScoreThreshold
          ? "watch"
          : null;

  if (!action) return null;

  return {
    market: current.market,
    timestamp: current.timestamp,
    close: current.close,
    score,
    action,
    relativeVolume,
    accelerationReturn,
    extensionReturn,
    breakout,
    reasons,
  };
}

function buildReasons({
  accelerationReturn,
  breakout,
  extensionPenalty,
  relativeVolume,
  resolved,
}: {
  accelerationReturn: number;
  breakout: boolean;
  extensionPenalty: number;
  relativeVolume: number;
  resolved: AnomalyMonitorOptions;
}) {
  const reasons: string[] = [];
  if (relativeVolume >= resolved.minRelativeVolume) reasons.push("volume-surge");
  if (accelerationReturn >= resolved.minAccelerationReturn) reasons.push("price-acceleration");
  if (breakout) reasons.push("short-breakout");
  if (extensionPenalty >= 0.75) reasons.push("overextended-counter-action");
  if (reasons.length === 0) reasons.push("weak-anomaly-watch");
  return reasons;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
