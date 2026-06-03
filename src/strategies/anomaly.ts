import { rateOfChange, sma } from "../indicators/technical";
import type { Candle, Strategy, StrategyContext, StrategyDecision, StrategyScenario } from "../types/trading";

export const anomalyScenario: StrategyScenario = {
  id: "anomaly-signal-default",
  traderId: "anomaly",
  name: "Abnormal spike detector",
  description: "Detects public-market price/volume acceleration and exits quickly.",
  params: {
    volumeLookback: 48,
    relativeVolumeMin: 3.5,
    accelerationLookback: 3,
    accelerationMin: 0.045,
    maxExtendedMove: 0.18,
    stopLossPct: 0.028,
    trailingStopPct: 0.035,
    takeProfitPct: 0.09,
    maxHoldCandles: 18,
  },
};

const anomalyScenarios: StrategyScenario[] = [
  {
    ...anomalyScenario,
    id: "anomaly-balanced",
    name: "Balanced anomaly",
  },
  {
    ...anomalyScenario,
    id: "anomaly-sensitive",
    name: "Sensitive anomaly",
    params: {
      ...anomalyScenario.params,
      relativeVolumeMin: 2.3,
      accelerationMin: 0.025,
      maxExtendedMove: 0.14,
      stopLossPct: 0.022,
      trailingStopPct: 0.028,
      takeProfitPct: 0.06,
      maxHoldCandles: 12,
    },
  },
  {
    ...anomalyScenario,
    id: "anomaly-strict",
    name: "Strict anomaly",
    params: {
      ...anomalyScenario.params,
      relativeVolumeMin: 5,
      accelerationMin: 0.06,
      maxExtendedMove: 0.2,
      stopLossPct: 0.025,
      trailingStopPct: 0.04,
      takeProfitPct: 0.11,
      maxHoldCandles: 20,
    },
  },
];

export const anomalyStrategy: Strategy = {
  id: "anomaly",
  name: "Anomaly / Pump-Signal Detection",
  description: "공개 시세에서 비정상 급등 징후를 감지하되, 조작 참여가 아닌 엄격한 리스크 대응으로 제한합니다.",
  defaultScenario: anomalyScenario,
  scenarios: anomalyScenarios,
  decide(context: StrategyContext, scenario = anomalyScenario): StrategyDecision {
    const { candles, candleIndex, position } = context;
    const current = candles[candleIndex];
    const indicators = getAnomalyIndicators(candles, scenario);
    const averageVolume = indicators.averageVolume[candleIndex];
    const acceleration = indicators.acceleration[candleIndex];
    const extendedMove = indicators.extendedMove[candleIndex];

    if (averageVolume === null || acceleration === null || extendedMove === null) return hold("warming-up");

    if (position) {
      const volumeFade = current.volume < averageVolume * 1.2;
      const timeStop = position.holdCandles >= scenario.params.maxHoldCandles;
      if (volumeFade || timeStop) {
        return {
          action: "sell",
          confidence: 0.72,
          reasonCodes: [volumeFade ? "volume-fade" : "time-stop"],
          targetWeight: 0,
        };
      }
      return hold("anomaly-position-running");
    }

    const relativeVolume = current.volume / averageVolume;
    const isAccelerating = acceleration >= scenario.params.accelerationMin;
    const isTooExtended = extendedMove >= scenario.params.maxExtendedMove;
    const lookbackCloses = indicators.closes.slice(Math.max(0, candleIndex - 24), candleIndex);
    const breaksHigh = lookbackCloses.length === 0 || current.close >= lookbackCloses.reduce((a, b) => (b > a ? b : a), -Infinity);

    if (relativeVolume >= scenario.params.relativeVolumeMin && isAccelerating && breaksHigh && !isTooExtended && current.close > current.open) {
      return {
        action: "buy",
        confidence: 0.61,
        reasonCodes: ["relative-volume-spike", "price-acceleration", "range-breakout"],
        targetWeight: 0.25,
        stopLossPct: scenario.params.stopLossPct,
        trailingStopPct: scenario.params.trailingStopPct,
        takeProfitPct: scenario.params.takeProfitPct,
        maxHoldCandles: scenario.params.maxHoldCandles,
      };
    }

    return hold("no-anomaly-entry");
  },
};

function hold(reason: string): StrategyDecision {
  return { action: "hold", confidence: 0, reasonCodes: [reason], targetWeight: 0 };
}

type AnomalyIndicators = {
  closes: number[];
  averageVolume: Array<number | null>;
  acceleration: Array<number | null>;
  extendedMove: Array<number | null>;
};

const anomalyIndicatorCache = new WeakMap<Candle[], Map<string, AnomalyIndicators>>();

function getAnomalyIndicators(candles: Candle[], scenario: StrategyScenario): AnomalyIndicators {
  let scenarioCache = anomalyIndicatorCache.get(candles);
  if (!scenarioCache) {
    scenarioCache = new Map();
    anomalyIndicatorCache.set(candles, scenarioCache);
  }

  const key = JSON.stringify(scenario.params);
  const cached = scenarioCache.get(key);
  if (cached) return cached;

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const indicators = {
    closes,
    averageVolume: sma(volumes, scenario.params.volumeLookback),
    acceleration: rateOfChange(closes, scenario.params.accelerationLookback),
    extendedMove: rateOfChange(closes, scenario.params.volumeLookback),
  };
  scenarioCache.set(key, indicators);
  return indicators;
}
