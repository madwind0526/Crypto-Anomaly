import type { BacktestResult, Candle } from "../types/trading";

export interface SafetyEvaluation {
  blocked: boolean;
  reasons: string[];
}

export function evaluateSafetyBlock(result: BacktestResult, candles: Candle[], currentReturn: number): SafetyEvaluation {
  const reasons: string[] = [];

  if (candles.length < 240) reasons.push("insufficient-1m-data");
  if (currentReturn <= -0.03) reasons.push("rapid-intraday-drop");
  if (currentReturn >= 0.12) reasons.push("overextended-chase-risk");
  if (result.maxDrawdown >= 0.15) reasons.push("high-max-drawdown");
  if (result.returnRate <= 0) reasons.push("non-positive-backtest");
  if (result.guideRejectedSignals >= 300) reasons.push("many-rejected-signals");

  return {
    blocked: reasons.length > 0,
    reasons,
  };
}

export function getDailyReturnAtCandleIndex(candles: Candle[], candleIndex: number) {
  const candle = candles[candleIndex];
  if (!candle) return 0;
  const dayStart = getKstDayStart(candle.timestamp);
  // Binary search for the first candle at or after dayStart within [0, candleIndex].
  let lo = 0;
  let hi = candleIndex;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].timestamp < dayStart) lo = mid + 1;
    else hi = mid;
  }
  const first = lo <= candleIndex && candles[lo].timestamp >= dayStart ? candles[lo] : null;
  if (!first || first.close === 0) return 0;
  return (candle.close - first.close) / first.close;
}

function getKstDayStart(timestamp: number) {
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((timestamp + kstOffsetMs) / dayMs) * dayMs - kstOffsetMs;
}