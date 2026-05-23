import { createSampleMarketSet } from "./sampleData";
import type { StrategyComparison, StrategyGuideModeComparison } from "../simulation/optimizer";
import type { TraderOptimizationPlan } from "../simulation/traderOptimization";
import type { BlockedSignal, Candle, GuideRuleMode, SafetyMode, Trade, TraderId } from "../types/trading";

export interface DashboardMarketData {
  source: string;
  generatedAt: string;
  markets: string[];
  candlesByMarket: Record<string, Candle[]>;
  isRealUpbitData: boolean;
}

export interface DashboardResults {
  generatedAt: string;
  comparisons: StrategyComparison[];
  comparisonsByGuideMode?: Record<"strict" | "ignored", StrategyComparison[]>;
  guideModeComparisons: StrategyGuideModeComparison[];
  optimizationPlans: TraderOptimizationPlan[];
  optimizationPlansByGuideMode?: Record<"strict" | "ignored", TraderOptimizationPlan[]>;
}

export interface DailyPaperResult {
  strategyId: TraderId;
  strategyName: string;
  guideRuleMode: GuideRuleMode;
  startedAt: number;
  endedAt: number;
  initialCash: number;
  finalValue: number;
  returnRate: number;
  autoBlockMode?: SafetyMode;
  blockedSignals?: BlockedSignal[];
  safetyBlockedByMarket?: Record<string, number>;
  safetyBlockedSignals?: number;
  trades: Trade[];
  decisions: Array<{
    timestamp: number;
    action: "hold" | "buy" | "sell" | "rotate";
    buyMarket?: string;
    sellMarket?: string;
    portfolioValue: number;
    cash: number;
    positionMarket?: string;
    reasonCodes: string[];
  }>;
  equityCurve: Array<{ timestamp: number; value: number }>;
}

export interface DailyPaperResultsPayload {
  generatedAt: string;
  marketCache: {
    path: string;
    generatedAt?: string;
    candleUnitMinutes?: number;
    selectedMarkets?: string[];
  };
  maxCandles: number;
  rows?: Array<Record<string, unknown>>;
  results: Record<GuideRuleMode, Partial<Record<TraderId, DailyPaperResult>>>;
  caseResults?: Record<GuideRuleMode, Record<SafetyMode, Partial<Record<TraderId, DailyPaperResult>>>>;
}

interface UpbitMarketCachePayload {
  source: string;
  generatedAt: string;
  candleUnitMinutes: number;
  dashboardWindowCandles?: number;
  selectedMarkets: string[];
  candlesByMarket: Record<string, Candle[]>;
}

export async function loadDashboardMarketData(): Promise<DashboardMarketData> {
  const cached = await loadUpbitPublicCache();
  if (cached) {
    return {
      source: `${cached.source}:${cached.candleUnitMinutes}m`,
      generatedAt: cached.generatedAt,
      markets: cached.selectedMarkets,
      candlesByMarket: cached.candlesByMarket,
      isRealUpbitData: true,
    };
  }

  console.warn("[marketData] No Upbit cache found — dashboard is running on sample data");
  return loadSampleMarketData();
}

export async function loadDailyOperationMarketData(): Promise<DashboardMarketData | null> {
  const cached = await fetchMarketCache("/market/upbit-krw-1m-daily.json");
  if (!cached) return null;

  return {
    source: `${cached.source}:${cached.candleUnitMinutes}m`,
    generatedAt: cached.generatedAt,
    markets: cached.selectedMarkets,
    candlesByMarket: cached.candlesByMarket,
    isRealUpbitData: true,
  };
}

export async function loadDailyPaperResults(): Promise<DailyPaperResultsPayload | null> {
  try {
    const response = await fetch("/market/paper-trading-1m-daily-results.json", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as DailyPaperResultsPayload;
  } catch {
    return null;
  }
}

export function loadSampleMarketData(): DashboardMarketData {
  const sample = createSampleMarketSet();
  return {
    source: "sample",
    generatedAt: "",
    markets: Object.keys(sample),
    candlesByMarket: sample,
    isRealUpbitData: false,
  };
}

export async function loadDashboardResults(): Promise<DashboardResults | null> {
  try {
    const response = await fetch("/market/dashboard-results.json", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as DashboardResults;
  } catch {
    return null;
  }
}

async function loadUpbitPublicCache(): Promise<UpbitMarketCachePayload | null> {
  const dashboardCache = await fetchMarketCache("/market/upbit-krw-5m-dashboard.json");
  if (dashboardCache) return dashboardCache;
  return fetchMarketCache("/market/upbit-krw-5m.json");
}

async function fetchMarketCache(url: string): Promise<UpbitMarketCachePayload | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as UpbitMarketCachePayload;
  } catch {
    return null;
  }
}
