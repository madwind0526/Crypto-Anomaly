import type { Candle } from "../types/trading";

export interface AnomalyCandidateOptions {
  candidateCount: number;
  spikeLookbackCandles: number;
  spikeReturnThreshold: number;
  fadeLookaheadCandles: number;
  fadeThreshold: number;
  minAverageQuoteVolume: number;
  maxAverageQuoteVolume: number;
}

export interface AnomalyCandidate {
  market: string;
  score: number;
  averageQuoteVolume: number;
  volatilityScore: number;
  liquidityScore: number;
  spikeFrequencyScore: number;
  fadeScore: number;
  spikeCount: number;
  reasons: string[];
}

const defaultOptions: AnomalyCandidateOptions = {
  candidateCount: 12,
  spikeLookbackCandles: 3,
  spikeReturnThreshold: 0.045,
  fadeLookaheadCandles: 12,
  fadeThreshold: 0.025,
  minAverageQuoteVolume: 20_000_000,
  maxAverageQuoteVolume: 5_000_000_000,
};

export function selectAnomalyCandidates(
  candlesByMarket: Record<string, Candle[]>,
  options: Partial<AnomalyCandidateOptions> = {},
): AnomalyCandidate[] {
  const resolved = { ...defaultOptions, ...options };

  return Object.entries(candlesByMarket)
    .map(([market, candles]) => scoreMarket(market, candles, resolved))
    .filter((candidate): candidate is AnomalyCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, resolved.candidateCount);
}

function scoreMarket(market: string, candles: Candle[], options: AnomalyCandidateOptions): AnomalyCandidate | null {
  const sorted = candles.slice().sort((a, b) => a.timestamp - b.timestamp);
  const minCandles = options.spikeLookbackCandles + options.fadeLookaheadCandles + 20;
  if (sorted.length < minCandles) return null;

  const averageQuoteVolume = average(sorted.map((candle) => candle.quoteVolume));
  const liquidityScore = scoreLiquidity(
    averageQuoteVolume,
    options.minAverageQuoteVolume,
    options.maxAverageQuoteVolume,
  );
  const returns = getCloseReturns(sorted);
  const volatilityScore = clamp01(stddev(returns) / 0.035);
  const spikeStats = getSpikeStats(sorted, options);
  const spikeFrequencyScore = clamp01(spikeStats.spikeCount / Math.max(4, sorted.length / 800));
  const fadeScore = spikeStats.spikeCount === 0 ? 0 : spikeStats.fadeCount / spikeStats.spikeCount;
  const score = weightedAverage([
    [liquidityScore, 0.28],
    [volatilityScore, 0.22],
    [spikeFrequencyScore, 0.3],
    [fadeScore, 0.2],
  ]);

  return {
    market,
    score,
    averageQuoteVolume,
    volatilityScore,
    liquidityScore,
    spikeFrequencyScore,
    fadeScore,
    spikeCount: spikeStats.spikeCount,
    reasons: buildReasons({ fadeScore, liquidityScore, spikeFrequencyScore, volatilityScore }),
  };
}

function getSpikeStats(candles: Candle[], options: AnomalyCandidateOptions) {
  let spikeCount = 0;
  let fadeCount = 0;

  for (let index = options.spikeLookbackCandles; index < candles.length - options.fadeLookaheadCandles; index += 1) {
    const previous = candles[index - options.spikeLookbackCandles];
    const current = candles[index];
    const move = (current.close - previous.close) / previous.close;
    if (move < options.spikeReturnThreshold) continue;

    spikeCount += 1;
    const futureWindow = candles.slice(index + 1, index + 1 + options.fadeLookaheadCandles);
    const futureLow = Math.min(...futureWindow.map((candle) => candle.low));
    const fade = (current.close - futureLow) / current.close;
    if (fade >= options.fadeThreshold) fadeCount += 1;
  }

  return { fadeCount, spikeCount };
}

function scoreLiquidity(value: number, min: number, max: number) {
  if (value <= 0) return 0;
  if (value < min) return clamp01(value / min);
  if (value <= max) return 1;
  return clamp01(max / value);
}

function getCloseReturns(candles: Candle[]) {
  const returns: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close;
    if (previous > 0) returns.push((candles[index].close - previous) / previous);
  }
  return returns;
}

function buildReasons(scores: {
  fadeScore: number;
  liquidityScore: number;
  spikeFrequencyScore: number;
  volatilityScore: number;
}) {
  const reasons: string[] = [];
  if (scores.spikeFrequencyScore >= 0.65) reasons.push("frequent-spike-history");
  if (scores.fadeScore >= 0.55) reasons.push("post-spike-fade");
  if (scores.liquidityScore >= 0.75) reasons.push("tradable-liquidity");
  if (scores.volatilityScore >= 0.5) reasons.push("active-volatility");
  return reasons.length > 0 ? reasons : ["weak-anomaly-profile"];
}

function weightedAverage(items: Array<[value: number, weight: number]>) {
  const totalWeight = items.reduce((sum, [, weight]) => sum + weight, 0);
  return items.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: number[]) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
