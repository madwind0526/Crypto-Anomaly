import type { TraderId } from "../types/trading";

export interface WsStrategyResult {
  returnRate: number;
  trades:     number;
  cash:       number;
  position:   { market: string; entryPrice: number; holdBars: number } | null;
}

export interface WsLiveResults {
  connectedAt:     string;
  updatedAt:       string;
  status:          "connecting" | "connected" | "disconnected";
  tickCount:       number;
  selectedMarkets: string[];
  wsO:             Partial<Record<TraderId, WsStrategyResult>>;
  wsX:             Partial<Record<TraderId, WsStrategyResult>>;
  liveCandles:     Record<string, {
    open: number; high: number; low: number; close: number;
    volume: number; timestamp: number;
  }>;
}

export async function loadWsLiveResults(): Promise<WsLiveResults | null> {
  try {
    const res = await fetch("/market/ws-live-results.json", { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json() as WsLiveResults;
  } catch {
    return null;
  }
}
