import type {
  BacktestConfig,
  BacktestResult,
  Candle,
  GuideRuleEvaluation,
  GuideRuleMode,
  Position,
  SignalAudit,
  Strategy,
  StrategyScenario,
  Trade,
} from "../types/trading";
import { evaluateGuideRules } from "../guideRules/evaluator";

export const defaultBacktestConfig: BacktestConfig = {
  initialCash: 1_000_000,
  feeRate: 0.0005,
  slippageRate: 0.0005,
};

export function runBacktest(
  strategy: Strategy,
  scenario: StrategyScenario,
  candles: Candle[],
  config: BacktestConfig = defaultBacktestConfig,
): BacktestResult {
  const guideRuleMode: GuideRuleMode = config.guideRuleMode ?? "ignored";
  let cash = config.initialCash;
  let position: Position | null = null;
  const trades: Trade[] = [];
  const signalAudit: SignalAudit[] = [];
  const equityCurve: Array<{ timestamp: number; value: number }> = [];
  let lastSellPrice: number | undefined;
  let peakValue = config.initialCash;
  let maxDrawdown = 0;
  const roundTripReturns: number[] = [];

  for (let candleIndex = 0; candleIndex < candles.length; candleIndex += 1) {
    const candle = candles[candleIndex];
    if (position) {
      position.holdCandles += 1;
      position.highestPrice = Math.max(position.highestPrice, candle.high);

      const stopPrice = position.averagePrice * (1 - (scenario.params.stopLossPct ?? 0));
      const trailingStop = position.highestPrice * (1 - (scenario.params.trailingStopPct ?? 0));
      const takeProfit = position.averagePrice * (1 + (scenario.params.takeProfitPct ?? Number.POSITIVE_INFINITY));

      const takeProfitHit = !!(scenario.params.takeProfitPct && candle.high >= takeProfit);
      const trailingStopHit = !!(scenario.params.trailingStopPct && candle.low <= trailingStop);
      const stopLossHit = !!(scenario.params.stopLossPct && candle.low <= stopPrice);
      if (takeProfitHit || trailingStopHit || stopLossHit) {
        let exitPrice: number;
        let exitReason: string;
        if (takeProfitHit) {
          exitPrice = takeProfit;
          exitReason = "take-profit";
        } else if (trailingStopHit && trailingStop >= stopPrice) {
          exitPrice = Math.min(candle.close, trailingStop);
          exitReason = "trailing-stop";
        } else {
          exitPrice = Math.min(candle.close, stopPrice);
          exitReason = "stop-loss";
        }
        const roundTripReturn = closePosition(exitPrice, ["risk-rule-exit", exitReason], candle.timestamp);
        roundTripReturns.push(roundTripReturn);
      }
    }

    const portfolioValue = cash + (position ? position.quantity * candle.close : 0);
    const decision = strategy.decide(
      {
        market: candle.market,
        candles,
        candleIndex,
        position,
        portfolioValue,
        lastSellPrice,
      },
      scenario,
    );
    const guideRuleEvaluation = evaluateGuideRules({
      candles,
      candleIndex,
      decision,
      mode: guideRuleMode,
    });
    const finalAction =
      decision.action === "buy" && guideRuleMode === "strict" && !guideRuleEvaluation.passed
        ? "hold"
        : decision.action;

    if (decision.action !== "hold" || !guideRuleEvaluation.passed) {
      signalAudit.push({
        market: candle.market,
        timestamp: candle.timestamp,
        rawAction: decision.action,
        finalAction,
        confidence: decision.confidence,
        guideRuleMode,
        guideRulePassed: guideRuleEvaluation.passed,
        guideRuleScore: guideRuleEvaluation.score,
        reasonCodes: decision.reasonCodes,
        guideRuleReasons: guideRuleEvaluation.reasons,
        guideRuleBlockers: guideRuleEvaluation.blockers,
        guideRuleWarnings: guideRuleEvaluation.warnings,
      });
    }

    if (finalAction === "buy" && !position && decision.targetWeight > 0) {
      const budget = cash * Math.min(decision.targetWeight, 1);
      const fillPrice = candle.close * (1 + config.slippageRate);
      const fee = budget * config.feeRate;
      const quantity = Math.max(0, (budget - fee) / fillPrice);

      if (quantity > 0) {
        cash -= budget;
        position = {
          market: candle.market,
          quantity,
          averagePrice: fillPrice,
          openedAt: candle.timestamp,
          highestPrice: fillPrice,
          holdCandles: 0,
        };
        trades.push({
          market: candle.market,
          side: "buy",
          timestamp: candle.timestamp,
          price: fillPrice,
          quantity,
          fee,
          reasonCodes: [...decision.reasonCodes, ...guideRuleEvaluation.reasons],
          guideRuleMode,
          guideRuleEvaluation,
        });
      }
    }

    if (finalAction === "sell" && position) {
      const roundTripReturn = closePosition(
        candle.close * (1 - config.slippageRate),
        [...decision.reasonCodes, ...guideRuleEvaluation.reasons],
        candle.timestamp,
        guideRuleEvaluation,
      );
      roundTripReturns.push(roundTripReturn);
    }

    const currentValue = cash + (position ? position.quantity * candle.close : 0);
    peakValue = Math.max(peakValue, currentValue);
    maxDrawdown = Math.max(maxDrawdown, peakValue === 0 ? 0 : (peakValue - currentValue) / peakValue);
    equityCurve.push({ timestamp: candle.timestamp, value: currentValue });
  }

  if (position) {
    const last = candles[candles.length - 1];
    const roundTripReturn = closePosition(last.close * (1 - config.slippageRate), ["final-close"], last.timestamp);
    roundTripReturns.push(roundTripReturn);
    equityCurve.push({ timestamp: last.timestamp, value: cash });
  }

  const finalValue = equityCurve[equityCurve.length - 1]?.value ?? cash;
  const wins = roundTripReturns.filter((value) => value > 0);
  const losses = roundTripReturns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));

  function closePosition(
    price: number,
    reasonCodes: string[],
    timestamp: number,
    guideRuleEvaluation?: GuideRuleEvaluation,
  ): number {
    if (!position) return 0;
    const proceeds = position.quantity * price;
    const fee = proceeds * config.feeRate;
    const entryCost = position.quantity * position.averagePrice;
    const realized = proceeds - fee - entryCost;

    trades.push({
      market: position.market,
      side: "sell",
      timestamp,
      price,
      quantity: position.quantity,
      fee,
      reasonCodes,
      guideRuleMode,
      guideRuleEvaluation,
    });
    cash += proceeds - fee;
    lastSellPrice = price;
    position = null;
    return entryCost === 0 ? 0 : realized / entryCost;
  }

  return {
    strategyId: strategy.id,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    market: candles[0]?.market ?? "UNKNOWN",
    finalValue,
    returnRate: (finalValue - config.initialCash) / config.initialCash,
    maxDrawdown,
    winRate: roundTripReturns.length === 0 ? 0 : wins.length / roundTripReturns.length,
    tradeCount: trades.length,
    profitFactor: grossLoss === 0 ? grossProfit : grossProfit / grossLoss,
    worstTradeReturn: roundTripReturns.length === 0 ? 0 : Math.min(...roundTripReturns),
    guideRuleMode,
    guideRejectedSignals: signalAudit.filter((signal) => signal.rawAction !== signal.finalAction).length,
    trades,
    signalAudit,
    equityCurve,
  };
}
