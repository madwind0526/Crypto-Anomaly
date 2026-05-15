import { rateOfChange } from "../indicators/technical";
import type { Candle, Strategy, StrategyContext, StrategyDecision, StrategyScenario } from "../types/trading";

export const arbitrageScenario: StrategyScenario = {
  id: "relative-strength-arb-default",
  traderId: "arbitrage",
  name: "Relative-value proxy",
  description: "A spot-only proxy for future pair/funding arbitrage infrastructure.",
  params: {
    lookback: 48,
    zEntry: -1.6,
    zExit: -0.2,
    stopLossPct: 0.03,
    maxHoldCandles: 48,
  },
};

const arbitrageScenarios: StrategyScenario[] = [
  {
    ...arbitrageScenario,
    id: "relative-value-balanced",
    name: "Balanced relative value",
  },
  {
    ...arbitrageScenario,
    id: "relative-value-fast",
    name: "Fast relative value",
    params: {
      ...arbitrageScenario.params,
      lookback: 24,
      zEntry: -1.25,
      zExit: -0.05,
      stopLossPct: 0.025,
      maxHoldCandles: 24,
    },
  },
  {
    ...arbitrageScenario,
    id: "relative-value-deep",
    name: "Deep relative value",
    params: {
      ...arbitrageScenario.params,
      lookback: 72,
      zEntry: -2.1,
      zExit: -0.35,
      stopLossPct: 0.045,
      maxHoldCandles: 72,
    },
  },
];

export const arbitrageStrategy: Strategy = {
  id: "arbitrage",
  name: "Statistical / Funding Arbitrage",
  description: "초기 버전은 현물 데이터만 사용해 상대적으로 눌린 종목의 회귀 가능성을 테스트합니다.",
  defaultScenario: arbitrageScenario,
  scenarios: arbitrageScenarios,
  decide(context: StrategyContext, scenario = arbitrageScenario): StrategyDecision {
    const { candles, candleIndex, position } = context;
    const indicators = getArbitrageIndicators(candles, scenario);
    const window = indicators.returns.slice(Math.max(0, candleIndex - scenario.params.lookback), candleIndex);

    if (window.length < scenario.params.lookback) return hold("warming-up");

    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    const variance = window.reduce((sum, value) => sum + (value - average) ** 2, 0) / window.length;
    const sd = Math.sqrt(variance);
    if (sd === 0) return hold("flat-relative-window");

    const zScore = (indicators.returns[candleIndex] - average) / sd;

    if (position) {
      if (zScore >= scenario.params.zExit || position.holdCandles >= scenario.params.maxHoldCandles) {
        return { action: "sell", confidence: 0.58, reasonCodes: ["relative-value-normalized"], targetWeight: 0 };
      }
      return hold("relative-position-running");
    }

    if (zScore <= scenario.params.zEntry) {
      return {
        action: "buy",
        confidence: 0.54,
        reasonCodes: ["temporary-underperformance", "statistical-reversion-candidate"],
        targetWeight: 0.45,
        stopLossPct: scenario.params.stopLossPct,
        maxHoldCandles: scenario.params.maxHoldCandles,
      };
    }

    return hold("no-relative-value-entry");
  },
};

function hold(reason: string): StrategyDecision {
  return { action: "hold", confidence: 0, reasonCodes: [reason], targetWeight: 0 };
}

type ArbitrageIndicators = {
  returns: number[];
};

const arbitrageIndicatorCache = new WeakMap<Candle[], Map<string, ArbitrageIndicators>>();

function getArbitrageIndicators(candles: Candle[], scenario: StrategyScenario): ArbitrageIndicators {
  let scenarioCache = arbitrageIndicatorCache.get(candles);
  if (!scenarioCache) {
    scenarioCache = new Map();
    arbitrageIndicatorCache.set(candles, scenarioCache);
  }

  const key = JSON.stringify(scenario.params);
  const cached = scenarioCache.get(key);
  if (cached) return cached;

  const closes = candles.map((candle) => candle.close);
  const returns = rateOfChange(closes, 1).map((value) => value ?? 0);
  const indicators = {
    returns,
  };
  scenarioCache.set(key, indicators);
  return indicators;
}
