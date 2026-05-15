import type { DecisionAction } from "../types/trading";

export interface DailySignal {
  market: string;
  action: DecisionAction;
  strength: number;
  qualityScore: number;
  timestamp: number;
  reasonCodes: string[];
}

export interface DailyPosition {
  market: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  openedAt: number;
}

export type DailyOperationAction = "hold" | "buy" | "sell" | "rotate";

export interface DailyOperationOptions {
  minBuyScore: number;
  rotationAdvantage: number;
}

export interface DailyOperationDecision {
  action: DailyOperationAction;
  timestamp: number;
  buyMarket?: string;
  sellMarket?: string;
  selectedSignal?: DailySignal;
  currentPosition?: DailyPosition;
  rankedSignals: DailySignal[];
  reasonCodes: string[];
}

const defaultOptions: DailyOperationOptions = {
  minBuyScore: 0.55,
  rotationAdvantage: 0.12,
};

export function decideDailyOperation({
  currentPosition,
  now,
  options = {},
  signals,
}: {
  currentPosition: DailyPosition | null;
  now: number;
  options?: Partial<DailyOperationOptions>;
  signals: DailySignal[];
}): DailyOperationDecision {
  const resolved = { ...defaultOptions, ...options };
  const rankedSignals = signals.slice().sort((a, b) => scoreSignal(b) - scoreSignal(a));
  const sellSignal = currentPosition
    ? rankedSignals.find((signal) => signal.market === currentPosition.market && signal.action === "sell")
    : undefined;
  const bestBuySignal = rankedSignals.find(
    (signal) => signal.action === "buy" && scoreSignal(signal) >= resolved.minBuyScore,
  );

  if (currentPosition && sellSignal) {
    return {
      action: "sell",
      timestamp: now,
      sellMarket: currentPosition.market,
      selectedSignal: sellSignal,
      currentPosition,
      rankedSignals,
      reasonCodes: ["sell-signal-priority", ...sellSignal.reasonCodes],
    };
  }

  if (!currentPosition) {
    if (!bestBuySignal) {
      return {
        action: "hold",
        timestamp: now,
        rankedSignals,
        reasonCodes: ["no-qualified-buy-signal"],
      };
    }

    return {
      action: "buy",
      timestamp: now,
      buyMarket: bestBuySignal.market,
      selectedSignal: bestBuySignal,
      rankedSignals,
      reasonCodes: ["best-buy-signal", ...bestBuySignal.reasonCodes],
    };
  }

  if (bestBuySignal && bestBuySignal.market !== currentPosition.market) {
    const currentMarketBuy = rankedSignals.find(
      (signal) => signal.market === currentPosition.market && signal.action === "buy",
    );
    const currentScore = currentMarketBuy ? scoreSignal(currentMarketBuy) : resolved.minBuyScore;
    const challengerScore = scoreSignal(bestBuySignal);

    if (challengerScore >= currentScore + resolved.rotationAdvantage) {
      return {
        action: "rotate",
        timestamp: now,
        buyMarket: bestBuySignal.market,
        sellMarket: currentPosition.market,
        selectedSignal: bestBuySignal,
        currentPosition,
        rankedSignals,
        reasonCodes: ["stronger-buy-signal-rotation", ...bestBuySignal.reasonCodes],
      };
    }
  }

  return {
    action: "hold",
    timestamp: now,
    currentPosition,
    rankedSignals,
    reasonCodes: ["keep-current-position"],
  };
}

export function scoreSignal(signal: DailySignal) {
  return clamp01(signal.strength * 0.65 + signal.qualityScore * 0.35);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
