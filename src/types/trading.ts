export type TraderId = "momentum" | "range-grid" | "arbitrage" | "anomaly";

export type DecisionAction = "hold" | "buy" | "sell";

export type GuideRuleMode = "strict" | "ignored";

export type SafetyMode = "enabled" | "disabled";

export type GuideTrendState = "uptrend" | "downtrend" | "sideways" | "unknown";

export type GuideMovingAverageState = "bullish" | "bearish" | "mixed" | "unknown";

export interface Candle {
  market: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

export interface MarketSnapshot {
  market: string;
  tradePrice: number;
  accTradePrice24h: number;
  accTradeVolume24h: number;
  signedChangeRate: number;
}

export interface StrategyDecision {
  action: DecisionAction;
  confidence: number;
  reasonCodes: string[];
  targetWeight: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  trailingStopPct?: number;
  maxHoldCandles?: number;
}

export interface GuideRuleEvaluation {
  mode: GuideRuleMode;
  passed: boolean;
  score: number;
  reasons: string[];
  blockers: string[];
  warnings: string[];
  trend: GuideTrendState;
  movingAverage: GuideMovingAverageState;
}

export interface StrategyContext {
  market: string;
  candles: Candle[];
  candleIndex: number;
  position: Position | null;
  portfolioValue: number;
  lastSellPrice?: number;
}

export interface StrategyScenario {
  id: string;
  traderId: TraderId;
  name: string;
  description: string;
  params: Record<string, number>;
}

export interface Strategy {
  id: TraderId;
  name: string;
  description: string;
  defaultScenario: StrategyScenario;
  scenarios?: StrategyScenario[];
  decide(context: StrategyContext, scenario: StrategyScenario): StrategyDecision;
}

export interface Trade {
  market: string;
  side: "buy" | "sell";
  timestamp: number;
  price: number;
  quantity: number;
  fee: number;
  reasonCodes: string[];
  guideRuleMode?: GuideRuleMode;
  guideRuleEvaluation?: GuideRuleEvaluation;
}

export type BlockedSignalReason = "guide-rule" | "safety";

export interface BlockedSignal {
  market: string;
  timestamp: number;
  reason: BlockedSignalReason;
  reasonCodes: string[];
  guideRuleMode?: GuideRuleMode;
  safetyMode?: SafetyMode;
}

export interface Position {
  market: string;
  quantity: number;
  averagePrice: number;
  openedAt: number;
  highestPrice: number;
  holdCandles: number;
}

export interface BacktestConfig {
  initialCash: number;
  feeRate: number;
  slippageRate: number;
  guideRuleMode?: GuideRuleMode;
  autoBlockMode?: SafetyMode;
}

export interface SignalAudit {
  market: string;
  timestamp: number;
  rawAction: DecisionAction;
  finalAction: DecisionAction;
  confidence: number;
  guideRuleMode: GuideRuleMode;
  guideRulePassed: boolean;
  guideRuleScore: number;
  reasonCodes: string[];
  guideRuleReasons: string[];
  guideRuleBlockers: string[];
  guideRuleWarnings: string[];
}

export interface BacktestResult {
  strategyId: TraderId;
  scenarioId: string;
  scenarioName?: string;
  market: string;
  finalValue: number;
  returnRate: number;
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
  profitFactor: number;
  worstTradeReturn: number;
  guideRuleMode: GuideRuleMode;
  guideRejectedSignals: number;
  trades: Trade[];
  signalAudit: SignalAudit[];
  equityCurve: Array<{ timestamp: number; value: number }>;
}