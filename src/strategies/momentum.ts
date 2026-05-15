import { averageTrueRange, ema, macd, rsi } from "../indicators/technical";
import type { Candle, Strategy, StrategyContext, StrategyDecision, StrategyScenario } from "../types/trading";

export const momentumScenario: StrategyScenario = {
  id: "momentum-default",
  traderId: "momentum",
  name: "Regime-filtered momentum",
  description: "EMA trend, RSI, MACD, volume confirmation, and trailing-stop exit.",
  params: {
    fastEma: 12,
    slowEma: 48,
    rsiPeriod: 14,
    rsiMin: 54,
    volumeLookback: 24,
    volumeMultiplier: 1.15,
    atrPeriod: 14,
    maxAtrPct: 0.08,
    stopLossPct: 0.035,
    trailingStopPct: 0.045,
  },
};

const momentumScenarios: StrategyScenario[] = [
  {
    ...momentumScenario,
    id: "momentum-balanced",
    name: "Balanced momentum",
  },
  {
    ...momentumScenario,
    id: "momentum-fast",
    name: "Fast momentum",
    params: {
      ...momentumScenario.params,
      fastEma: 8,
      slowEma: 34,
      rsiMin: 52,
      volumeMultiplier: 1.05,
      stopLossPct: 0.03,
      trailingStopPct: 0.035,
    },
  },
  {
    ...momentumScenario,
    id: "momentum-strict",
    name: "Strict momentum",
    params: {
      ...momentumScenario.params,
      fastEma: 20,
      slowEma: 60,
      rsiMin: 58,
      volumeMultiplier: 1.35,
      stopLossPct: 0.025,
      trailingStopPct: 0.04,
    },
  },
  {
    ...momentumScenario,
    id: "momentum-wide-trail",
    name: "Wide-trail momentum",
    params: {
      ...momentumScenario.params,
      rsiMin: 55,
      volumeMultiplier: 1.1,
      stopLossPct: 0.045,
      trailingStopPct: 0.07,
    },
  },
];

export const momentumStrategy: Strategy = {
  id: "momentum",
  name: "Momentum / Trend Following",
  description: "상승 추세가 확인된 KRW 마켓만 진입하고 추세 약화 시 빠르게 이탈합니다.",
  defaultScenario: momentumScenario,
  scenarios: momentumScenarios,
  decide(context: StrategyContext, scenario = momentumScenario): StrategyDecision {
    const { candles, candleIndex, position } = context;
    const current = candles[candleIndex];
    const indicators = getMomentumIndicators(candles, scenario);
    const fast = indicators.fast[candleIndex];
    const slow = indicators.slow[candleIndex];
    const currentRsi = indicators.rsiValues[candleIndex];
    const currentMacd = indicators.macdHistogram[candleIndex];
    const currentAtr = indicators.atr[candleIndex];
    const volumeWindow = indicators.volumes.slice(
      Math.max(0, candleIndex - scenario.params.volumeLookback),
      candleIndex,
    );
    const averageVolume =
      volumeWindow.length === 0 ? current.volume : volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length;

    if (fast === null || slow === null || currentRsi === null || currentMacd === null || currentAtr === null) {
      return hold("warming-up");
    }

    const trendUp = fast > slow && current.close > fast;
    const momentumUp = currentRsi >= scenario.params.rsiMin && currentMacd > 0;
    const volumeConfirmed = current.volume >= averageVolume * scenario.params.volumeMultiplier;
    const atrPct = currentAtr / current.close;

    if (position) {
      const trendFailed = fast < slow || current.close < slow;
      const momentumFailed = currentRsi < 48 || currentMacd < 0;
      if (trendFailed || momentumFailed) {
        return sell(["momentum-exit", trendFailed ? "trend-failed" : "momentum-failed"]);
      }
      return hold("position-running");
    }

    if (trendUp && momentumUp && volumeConfirmed && atrPct < scenario.params.maxAtrPct) {
      return {
        action: "buy",
        confidence: 0.78,
        reasonCodes: ["trend-up", "rsi-confirmed", "macd-positive", "volume-confirmed"],
        targetWeight: 0.95,
        stopLossPct: scenario.params.stopLossPct,
        trailingStopPct: scenario.params.trailingStopPct,
      };
    }

    return hold("no-trend-entry");
  },
};

function hold(reason: string): StrategyDecision {
  return { action: "hold", confidence: 0, reasonCodes: [reason], targetWeight: 0 };
}

function sell(reasonCodes: string[]): StrategyDecision {
  return { action: "sell", confidence: 0.7, reasonCodes, targetWeight: 0 };
}

type MomentumIndicators = {
  volumes: number[];
  fast: Array<number | null>;
  slow: Array<number | null>;
  rsiValues: Array<number | null>;
  macdHistogram: Array<number | null>;
  atr: Array<number | null>;
};

const momentumIndicatorCache = new WeakMap<Candle[], Map<string, MomentumIndicators>>();

function getMomentumIndicators(candles: Candle[], scenario: StrategyScenario): MomentumIndicators {
  let scenarioCache = momentumIndicatorCache.get(candles);
  if (!scenarioCache) {
    scenarioCache = new Map();
    momentumIndicatorCache.set(candles, scenarioCache);
  }

  const key = JSON.stringify(scenario.params);
  const cached = scenarioCache.get(key);
  if (cached) return cached;

  const closes = candles.map((candle) => candle.close);
  const indicators = {
    volumes: candles.map((candle) => candle.volume),
    fast: ema(closes, scenario.params.fastEma),
    slow: ema(closes, scenario.params.slowEma),
    rsiValues: rsi(closes, scenario.params.rsiPeriod),
    macdHistogram: macd(closes).histogram,
    atr: averageTrueRange(candles, scenario.params.atrPeriod),
  };
  scenarioCache.set(key, indicators);
  return indicators;
}
