/**
 * Anomaly Variants Forward Simulation
 *
 * Strategies:
 *   Anomaly-A (→ "momentum" slot)    S3-CalmImpulse    15-bar quiet → first impulse
 *   Anomaly-B (→ "range-grid" slot)  S6-FirstExplosion  Enter ON explosion candle
 *   Anomaly-C (→ "arbitrage" slot)   S7-ConfirmedBurst  Enter on next bar after explosion
 *   Anomaly-D (→ "anomaly" slot)     SweepBest          Original anomaly, trailingStop=0.018
 *
 * Market selection (runs once at 00:00 KST, cached for 24h):
 *   1. Scan 1m backtracking data (7-day lookback) for anomaly events:
 *        10-min (max_high − min_low) / min_low > 10%
 *        AND 10-min volume > 3× previous 1-hour average
 *        WITH 2-hour cooldown between counted events
 *   2. Scan live 1m (last 24h) for new events not yet in backtracking
 *   3. Union of both → all markets that showed the pattern recently
 *   4. Remove markets with no event in the last REMOVAL_DAYS days (default: 7)
 *   5. All 4 variants monitor the SAME market list
 *
 * Parameter adaptation (at midnight):
 *   Compute median price-move from yesterday's live-1m anomaly events
 *   → adjust trailingStopPct and maxHoldCandles per variant
 *
 * Reads  : data/market/upbit-krw-1m-anomaly.json              (live-accumulating)
 *          data/market/upbit-krw-1m-anomaly-backtracking.json  (7-day 1m history)
 * Writes : public/market/paper-trading-1m-daily-results.json
 *          public/market/dashboard-results.json
 *          public/market/anomaly-selection.json   (daily cache)
 *
 * Usage:
 *   node scripts/anomaly-variants-sim.mjs              (one-shot)
 *   node scripts/anomaly-variants-sim.mjs --loop=60000 (continuous, 60s interval)
 */

import { exec } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runOptimization, type OptimizedParams } from "./optimize-params";

const execAsync = promisify(exec);
import path from "node:path";
import { runPaperTradingSimulation } from "../src/simulation/paperTrading";
import { runBacktest, defaultBacktestConfig } from "../src/simulation/backtest";
import { anomalyScenario, anomalyStrategy } from "../src/strategies/anomaly";
import { sma, rateOfChange } from "../src/indicators/technical";
import type {
  BacktestResult, Candle, GuideRuleMode, SafetyMode, Strategy, StrategyContext,
  StrategyDecision, StrategyScenario, TraderId,
} from "../src/types/trading";
import type { TraderOptimizationPlan, MarketScenarioOptimization } from "../src/simulation/traderOptimization";

// ─── paths ────────────────────────────────────────────────────────────────────
const root              = process.cwd();   // C:\Claude\Crypto-Anomaly
const anomaly1mPath     = path.join(root, "data", "market", "upbit-krw-1m-anomaly.json");
const backtracking1mPath = path.join(root, "data", "market", "upbit-krw-1m-anomaly-backtracking.json");
const outputDir         = path.join(root, "public", "market");
const paperPath         = path.join(outputDir, "paper-trading-1m-daily-results.json");
const dashPath          = path.join(outputDir, "dashboard-results.json");
const selectionPath     = path.join(outputDir, "anomaly-selection.json");
const daily1mPath       = path.join(outputDir, "upbit-krw-1m-daily.json");
const optimizedParamsPath = path.join(outputDir, "anomaly-optimized-params.json");
const docsDir           = path.join(root, "docs");
const simLogPath        = path.join(docsDir, "simulation-log.md");

// Per-coin optimized parameters loaded at 00:00. Keyed by market → slotId → params.
let perCoinParams: OptimizedParams = {};

// ─── constants ────────────────────────────────────────────────────────────────
const GUIDE_MODES        = ["ignored", "strict"] as GuideRuleMode[];
const SAFETY_MODES       = ["enabled", "disabled"] as SafetyMode[];
const MAX_BACKTRACKING_CANDLES = Number(process.env.MAX_BACKTRACKING_CANDLES ?? 10_080);
const LOOP_MS            = Number(process.env.LOOP_INTERVAL_MS ?? 0);
const LOOKBACK_DAYS      = Number(process.env.LOOKBACK_DAYS    ?? 7);
const REMOVAL_DAYS       = Number(process.env.REMOVAL_DAYS     ?? 7);   // detection window (backtracking scan)
const POOL_REMOVAL_DAYS  = Number(process.env.POOL_REMOVAL_DAYS ?? 45); // persistent pool: remove after 45d no event
const CANDIDATE_MARKET_COUNT = Number(process.env.ANOMALY_CANDIDATE_MARKET_COUNT ?? 30); // seed size (first run)
const MONITORING_MARKET_COUNT = Number(process.env.ANOMALY_MONITORING_MARKET_COUNT ?? 9);
const TRADE_VALUE_LOOKBACK_CANDLES = Number(process.env.ANOMALY_TRADE_VALUE_LOOKBACK_CANDLES ?? 1440);
const REFIT_PREVIOUS_WEIGHT = clamp(Number(process.env.ANOMALY_REFIT_PREVIOUS_WEIGHT ?? 0.7), 0, 1);
const REFIT_MIN_COMPLETENESS_RATIO = Number(process.env.ANOMALY_REFIT_MIN_COMPLETENESS_RATIO ?? 0.7);
const REFIT_EXPECTED_CANDLES = 1440;
const REFIT_MIN_CANDLES = Number(process.env.ANOMALY_REFIT_MIN_CANDLES ?? Math.floor(REFIT_EXPECTED_CANDLES * REFIT_MIN_COMPLETENESS_RATIO));
const KST_OFFSET_MS      = 9 * 3_600_000;
const MS_DAY             = 86_400_000;

// Anomaly detection thresholds
const ANOMALY_PRICE_THRESH = Number(process.env.ANOMALY_PRICE_THRESH ?? 0.10); // 10%
const ANOMALY_VOL_MULT     = Number(process.env.ANOMALY_VOL_MULT     ?? 3.0);  // 3× hourly avg

// ─── KST helpers ─────────────────────────────────────────────────────────────
function kstDateString(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}
function kstTodayStartMs(): number {
  const kstNow = Date.now() + KST_OFFSET_MS;
  return kstNow - (kstNow % MS_DAY) - KST_OFFSET_MS;
}
function todayCandles(candles: Candle[]): Candle[] {
  const start = kstTodayStartMs();
  return candles.filter(c => c.timestamp >= start);
}

// ─── anomaly event detection ─────────────────────────────────────────────────
interface AnomalyEvent {
  market:         string;
  timestamp:      number;
  priceMoveRatio: number; // e.g. 0.13 = 13%
  volRatio:       number;
}

/**
 * Detect anomaly events in a candle series.
 * @param windowCandles  candles in a 10-min window  (2 for 5m, 10 for 1m)
 * @param hourCandles    candles in 1 hour            (12 for 5m, 60 for 1m)
 * @param cooldownCandles candles to skip after event  (24 for 5m, 120 for 1m)
 */
function detectAnomalyEvents(
  market:          string,
  candles:         Candle[],
  windowCandles:   number,
  hourCandles:     number,
  cooldownCandles: number,
): AnomalyEvent[] {
  const warmup = hourCandles + windowCandles;
  const events: AnomalyEvent[] = [];

  for (let i = warmup; i < candles.length; i++) {
    const win = candles.slice(i - windowCandles + 1, i + 1);
    const hiHigh = Math.max(...win.map(c => c.high));
    const loLow  = Math.min(...win.map(c => c.low));
    if (loLow <= 0) continue;

    const priceMove = (hiHigh - loLow) / loLow;

    // Volume ratio: window total vs average per-candle volume over the previous hour.
    // volRatio ≥ 3 means the 10-min window has ≥ 1.5× the normal trading rate
    // (validated against hist5m analysis; consistent across 5m and 1m detectors).
    const prevHourCandles = candles.slice(i - hourCandles - windowCandles + 1, i - windowCandles + 1);
    const avgPerCandle    = prevHourCandles.reduce((s, c) => s + c.quoteVolume, 0) / hourCandles;
    const windowVol       = win.reduce((s, c) => s + c.quoteVolume, 0);
    const volRatio        = avgPerCandle > 0 ? windowVol / avgPerCandle : 0;

    if (priceMove >= ANOMALY_PRICE_THRESH && volRatio >= ANOMALY_VOL_MULT) {
      events.push({ market, timestamp: candles[i].timestamp, priceMoveRatio: priceMove, volRatio });
      i += cooldownCandles; // skip 2h to avoid counting same pump twice
    }
  }
  return events;
}

const detect1m  = (m: string, cs: Candle[]) => detectAnomalyEvents(m, cs, 10, 60, 120); // 1m

// ─── market selection ─────────────────────────────────────────────────────────
interface SelectedMarket {
  market:           string;
  lastEventTs:      number;
  histEventCount:   number; // events in 7-day 1m backtracking
  liveEventCount:   number; // events in last 24h live1m
}

/**
 * Select markets that have shown anomaly events.
 * Sources: backtracking1m (7-day 1m lookback) + live1m (last 24h).
 * Removes markets with no event in the last REMOVAL_DAYS days.
 */
function selectAnomalyMarkets(
  backtracking1m: Record<string, Candle[]>,
  live1m:         Record<string, Candle[]>,
  lookbackDays:   number,
  removalDays:    number,
): SelectedMarket[] {
  const now           = Date.now();
  const cutoff        = now - lookbackDays * MS_DAY;
  const removalCutoff = now - removalDays * MS_DAY;
  const oneDayAgo     = now - MS_DAY;

  const marketMap = new Map<string, SelectedMarket>();

  // Scan 1m backtracking data for anomaly events
  for (const [market, candles] of Object.entries(backtracking1m)) {
    const recent = candles.filter(c => c.timestamp >= cutoff);
    if (recent.length < 70) continue; // need warmup for 1m detector
    const events = detect1m(market, recent);
    if (events.length === 0) continue;
    const lastTs = events[events.length - 1].timestamp;
    marketMap.set(market, { market, lastEventTs: lastTs, histEventCount: events.length, liveEventCount: 0 });
  }

  // Scan live 1m (last 24h) — catches recent events not yet in backtracking
  // Require > warmup (70) candles so the detector loop runs at least once.
  for (const [market, candles] of Object.entries(live1m)) {
    const recent24h = candles.filter(c => c.timestamp >= oneDayAgo);
    if (recent24h.length < 100) continue;
    const events = detect1m(market, recent24h);
    if (events.length === 0) continue;
    const lastTs   = events[events.length - 1].timestamp;
    const existing = marketMap.get(market);
    marketMap.set(market, {
      market,
      lastEventTs:    Math.max(existing?.lastEventTs ?? 0, lastTs),
      histEventCount: existing?.histEventCount ?? 0,
      liveEventCount: events.length,
    });
  }

  // Remove markets with no event within removalDays
  return [...marketMap.values()]
    .filter(m => m.lastEventTs >= removalCutoff)
    .sort((a, b) => b.lastEventTs - a.lastEventTs);
}

// ─── parameter adaptation ─────────────────────────────────────────────────────
interface AdaptedParams { trailingStopPct: number; maxHoldCandles: number; }

const BASE_PARAMS: Record<TraderId, AdaptedParams> = {
  "momentum":   { trailingStopPct: 0.028, maxHoldCandles: 12 },
  "range-grid": { trailingStopPct: 0.018, maxHoldCandles: 6  },
  "arbitrage":  { trailingStopPct: 0.022, maxHoldCandles: 8  },
  "anomaly":    { trailingStopPct: 0.018, maxHoldCandles: 12 },
};

/**
 * Adapt exit parameters based on yesterday's anomaly events.
 * - trailingStopPct ≈ 40% of median price move (capture ~40% of a typical spike)
 * - maxHoldCandles  scales inversely with volatility (more volatile → exit faster)
 */
function adaptVariantParams(
  yesterdayEvents: AnomalyEvent[],
): Record<TraderId, AdaptedParams> {
  if (yesterdayEvents.length === 0) return { ...BASE_PARAMS };

  const moves = yesterdayEvents.map(e => e.priceMoveRatio).sort((a, b) => a - b);
  const medianMove = moves[Math.floor(moves.length / 2)];

  const trailFactors: Record<TraderId, number> = {
    "momentum":   0.45, // A: calm impulse — wider trail to ride the move
    "range-grid": 0.35, // B: explosion entry — tighter trail (already in at start)
    "arbitrage":  0.40, // C: confirmed burst — medium
    "anomaly":    0.38, // D: sweep best baseline
  };

  const result: Partial<Record<TraderId, AdaptedParams>> = {};
  for (const [slotId, base] of Object.entries(BASE_PARAMS) as [TraderId, AdaptedParams][]) {
    const trailingStopPct = clamp(medianMove * trailFactors[slotId], 0.010, 0.060);
    // Hold: baseline at 13% median move; scale inversely (more volatile → shorter hold)
    const volatilityScale = clamp(0.13 / medianMove, 0.5, 2.0);
    const maxHoldCandles  = Math.round(base.maxHoldCandles * volatilityScale);
    result[slotId] = { trailingStopPct, maxHoldCandles };
  }
  return result as Record<TraderId, AdaptedParams>;
}

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }

/** Detect anomaly events in yesterday's live 1m candles across all candidate markets. */
function detectYesterdayEvents(live1m: Record<string, Candle[]>, markets: string[]): AnomalyEvent[] {
  const yesterdayStart = kstTodayStartMs() - MS_DAY;
  const yesterdayEnd   = kstTodayStartMs();
  const events: AnomalyEvent[] = [];
  for (const market of markets) {
    const candles = (live1m[market] ?? []).filter(c => c.timestamp >= yesterdayStart && c.timestamp < yesterdayEnd);
    if (candles.length >= 70) events.push(...detect1m(market, candles));
  }
  return events;
}

/**
 * Compute per-variant adapted params from the median of perCoinParams.
 * Used as fallback when no yesterday events are available for adaptVariantParams.
 */
function medianVariantParams(perCoinParams: OptimizedParams): Record<TraderId, AdaptedParams> {
  const result: Record<TraderId, AdaptedParams> = { ...BASE_PARAMS };
  for (const slotId of Object.keys(BASE_PARAMS) as TraderId[]) {
    const vals = Object.values(perCoinParams)
      .map(m => m?.[slotId])
      .filter((p): p is NonNullable<typeof p> => p != null && Number.isFinite(p?.trailingStopPct));
    if (vals.length === 0) continue;
    const trails = vals.map(p => p.trailingStopPct).sort((a, b) => a - b);
    const holds  = vals.map(p => p.maxHoldCandles).sort((a, b) => a - b);
    result[slotId] = {
      trailingStopPct: trails[Math.floor(trails.length / 2)],
      maxHoldCandles:  Math.round(holds[Math.floor(holds.length / 2)]),
    };
  }
  return result;
}

// ─── indicator cache ──────────────────────────────────────────────────────────
interface Ind {
  bodies:   number[];
  topRatio: number[];
  volumes:  number[];
  avgVol48: Array<number | null>;
  roc48:    Array<number | null>;
}
const indCache = new WeakMap<Candle[], Ind>();
function getInd(candles: Candle[]): Ind {
  const cached = indCache.get(candles);
  if (cached) return cached;
  const vols = candles.map(c => c.volume);
  const ind: Ind = {
    bodies:   candles.map(c => (c.close - c.open) / (c.open || 1)),
    topRatio: candles.map(c => {
      const r = c.high - c.low; return r < 1e-10 ? 0.5 : (c.close - c.low) / r;
    }),
    volumes:  vols,
    avgVol48: sma(vols, 48),
    roc48:    rateOfChange(candles.map(c => c.close), 48),
  };
  indCache.set(candles, ind);
  return ind;
}

function hold(r: string): StrategyDecision {
  return { action: "hold", confidence: 0, reasonCodes: [r], targetWeight: 0 };
}
function sell(r: string): StrategyDecision {
  return { action: "sell", confidence: 0.8, reasonCodes: [r], targetWeight: 0 };
}
function buyAt(reasons: string[], sl: number, tp: number, trail: number, maxH: number): StrategyDecision {
  return { action: "buy", confidence: 0.72, reasonCodes: reasons, targetWeight: 0.3,
    stopLossPct: sl, takeProfitPct: tp, trailingStopPct: trail, maxHoldCandles: maxH };
}

// ─── Anomaly-A: S3-CalmImpulse ───────────────────────────────────────────────
function decideA(ctx: StrategyContext, scenario: StrategyScenario): StrategyDecision {
  const { candles, candleIndex: i, position } = ctx;
  const ind      = getInd(candles);
  const coinP    = perCoinParams[ctx.market]?.["momentum"];
  const trail    = coinP?.trailingStopPct  ?? scenario.params.trailingStopPct ?? 0.028;
  const maxHold  = coinP?.maxHoldCandles   ?? scenario.params.maxHoldCandles  ?? 12;
  const curBodyMin = coinP?.curBodyMin ?? 0.015;
  if (i < 52) return hold("warming-up");
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
    if (fade || position.holdCandles >= maxHold) return sell(fade ? "volume-fade" : "time-stop");
    return hold("holding");
  }
  const avgVol = ind.avgVol48[i]; const roc48 = ind.roc48[i];
  if (avgVol === null || roc48 === null) return hold("no-data");
  const recentBodies = ind.bodies.slice(i - 15, i).map(Math.abs);
  const avgBody = recentBodies.reduce((s, v) => s + v, 0) / 15;
  const curBody = ind.bodies[i];
  if (avgBody < 0.005 && curBody >= curBodyMin && candles[i].close > candles[i].open
    && candles[i].volume / avgVol >= 1.5 && Math.abs(roc48) < 0.05)
    return buyAt(["calm-impulse", `body+${(curBody * 100).toFixed(1)}%`], 0.018, 0.06, trail, maxHold);
  return hold("no-signal");
}

// ─── Anomaly-B: S6-FirstExplosion ────────────────────────────────────────────
function decideB(ctx: StrategyContext, scenario: StrategyScenario): StrategyDecision {
  const { candles, candleIndex: i, position } = ctx;
  const ind      = getInd(candles);
  const coinP    = perCoinParams[ctx.market]?.["range-grid"];
  const trail    = coinP?.trailingStopPct ?? scenario.params.trailingStopPct ?? 0.018;
  const maxHold  = coinP?.maxHoldCandles  ?? scenario.params.maxHoldCandles  ?? 6;
  const bodyMin  = coinP?.bodyMin ?? 0.025;
  if (i < 52) return hold("warming-up");
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.3;
    const rev  = ind.bodies[i] < -0.008;
    if (fade || rev || position.holdCandles >= maxHold) return sell(fade ? "volume-fade" : rev ? "reversal" : "time-stop");
    return hold("holding");
  }
  const avgVol = ind.avgVol48[i];
  if (avgVol === null) return hold("no-data");
  let calm = true;
  for (let k = 1; k <= 3; k++) {
    if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
  }
  // 5분 전 대비 현재 직전까지의 상승폭 (폭발 캔들 자체 제외).
  // 추격 매수 방지: 이미 5분간 5% 이상 올랐으면 진입 안 함.
  const pre5Close = candles[Math.max(0, i - 6)].close;
  const pre1Close = candles[i - 1].close;
  const preRoc5   = pre5Close > 0 ? Math.abs((pre1Close - pre5Close) / pre5Close) : 0;
  const body = ind.bodies[i]; const volR = candles[i].volume / avgVol; const topR = ind.topRatio[i];
  if (calm && body >= bodyMin && volR >= 3.5 && topR >= 0.60 && preRoc5 < 0.05)
    return buyAt(["explosion-candle", `vol×${volR.toFixed(1)}`, `body+${(body * 100).toFixed(1)}%`, `pre5+${(preRoc5 * 100).toFixed(1)}%`], 0.015, 0.045, trail, maxHold);
  return hold("no-signal");
}

// ─── Anomaly-C: S7-ConfirmedBurst ────────────────────────────────────────────
function decideC(ctx: StrategyContext, scenario: StrategyScenario): StrategyDecision {
  const { candles, candleIndex: i, position } = ctx;
  const ind           = getInd(candles);
  const coinP         = perCoinParams[ctx.market]?.["arbitrage"];
  const trail         = coinP?.trailingStopPct  ?? scenario.params.trailingStopPct ?? 0.022;
  const maxHold       = coinP?.maxHoldCandles   ?? scenario.params.maxHoldCandles  ?? 8;
  const confirmVolMin = coinP?.confirmVolMin ?? 1.8;
  if (i < 53) return hold("warming-up");
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
    const rev  = ind.bodies[i] < -0.01;
    if (fade || rev || position.holdCandles >= maxHold) return sell(fade ? "volume-fade" : rev ? "reversal" : "time-stop");
    return hold("holding");
  }
  const avgVol = ind.avgVol48[i];
  if (avgVol === null) return hold("no-data");
  const prevBody = ind.bodies[i - 1]; const prevTop = ind.topRatio[i - 1];
  const prevVol  = candles[i - 1].volume / avgVol;
  let calm = true;
  for (let k = 2; k <= 4; k++) {
    if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
  }
  // 폭발 봉(i-1) 이전 5분간 상승폭 확인 — 이미 5% 이상 올랐으면 B 조건 자체가 성립 안 된 것
  const prev5Close = candles[Math.max(0, i - 7)].close;
  const prev2Close = candles[i - 2].close;
  const prevPreRoc5 = prev5Close > 0 ? Math.abs((prev2Close - prev5Close) / prev5Close) : 0;
  const prevExploded = calm && prevBody >= 0.025 && prevTop >= 0.60 && prevVol >= 3.5 && prevPreRoc5 < 0.05;
  if (!prevExploded) return hold("no-prev-explosion");
  const curVol = candles[i].volume / avgVol;
  if (curVol >= confirmVolMin && ind.bodies[i] >= 0 && candles[i].close >= candles[i - 1].close)
    return buyAt(["confirmed-burst", `prev×${prevVol.toFixed(1)}`, `cur×${curVol.toFixed(1)}`], 0.018, 0.055, trail, maxHold);
  return hold("no-confirm");
}

// ─── Anomaly-D: Sweep-best wrapper — injects per-coin params into scenario ────
function decideD(ctx: StrategyContext, sc: StrategyScenario): StrategyDecision {
  const coinP = perCoinParams[ctx.market]?.["anomaly"];
  if (!coinP) return anomalyStrategy.decide(ctx, sc);
  return anomalyStrategy.decide(ctx, {
    ...sc,
    params: {
      ...sc.params,
      trailingStopPct:  coinP.trailingStopPct,
      maxHoldCandles:   coinP.maxHoldCandles,
      accelerationMin:  coinP.accelerationMin ?? sc.params.accelerationMin,
    },
  });
}

function makeSweepBestScenario(adapted: AdaptedParams): StrategyScenario {
  return {
    ...anomalyScenario,
    id: "anomaly-sweep-best",
    name: "Sweep-best",
    params: {
      ...anomalyScenario.params,
      trailingStopPct:   adapted.trailingStopPct,
      // 1m 캔들 기준 재조정: 3분 ROC 2% (원래 4.5%는 5m 기준)
      accelerationMin:   0.020,
      // 48분 과열 기준도 완화 (1m에서 pump 자체가 18% 내에 들어올 수 있음)
      maxExtendedMove:   0.25,
    },
  };
}

// ─── variant definitions ──────────────────────────────────────────────────────
interface Variant {
  slotId:        TraderId;
  slotName:      string;
  scenarioId:    string;
  scenarioLabel: string;
  strategy:      Strategy;
  scenario:      StrategyScenario;
}

function makeVariant(
  slotId: TraderId, slotName: string,
  scenarioId: string, scenarioLabel: string,
  decide: (ctx: StrategyContext, s: StrategyScenario) => StrategyDecision,
  adapted: AdaptedParams,
): Variant {
  const params: Record<string, number> = {
    trailingStopPct: adapted.trailingStopPct,
    maxHoldCandles:  adapted.maxHoldCandles,
  };
  const sc: StrategyScenario = { id: scenarioId, traderId: slotId, name: scenarioLabel, description: "", params };
  const strategy: Strategy   = { id: slotId, name: slotName, description: "", defaultScenario: sc, scenarios: [sc], decide };
  return { slotId, slotName, scenarioId, scenarioLabel, strategy, scenario: sc };
}

function buildVariants(adaptedParams: Record<TraderId, AdaptedParams>): Variant[] {
  const sweepBestSc = makeSweepBestScenario(adaptedParams["anomaly"]);
  return [
    makeVariant("momentum",   "Anomaly-A / Calm Impulse",    "anomaly-a", "Calm Impulse",    decideA, adaptedParams["momentum"]),
    makeVariant("range-grid", "Anomaly-B / First Explosion", "anomaly-b", "First Explosion", decideB, adaptedParams["range-grid"]),
    makeVariant("arbitrage",  "Anomaly-C / Confirmed Burst", "anomaly-c", "Confirmed Burst", decideC, adaptedParams["arbitrage"]),
    {
      slotId: "anomaly", slotName: "Anomaly-D / Sweep Best",
      scenarioId: "anomaly-sweep-best", scenarioLabel: "Sweep Best",
      strategy: {
        ...anomalyStrategy,
        id: "anomaly", name: "Anomaly-D / Sweep Best",
        scenarios: [sweepBestSc], defaultScenario: sweepBestSc,
        decide: decideD,
      },
      scenario: sweepBestSc,
    },
  ];
}

// ─── optimization plan builder ────────────────────────────────────────────────
function buildOptimizationPlan(
  v:                  Variant,
  guideRuleMode:      GuideRuleMode,
  slicedBacktracking: Record<string, Candle[]>,
  backtracking1m:     Record<string, Candle[]>,
  live1m:             Record<string, Candle[]>,
  markets:            string[],
): TraderOptimizationPlan {
  const config = { ...defaultBacktestConfig, guideRuleMode };

  const optimizedMarkets: MarketScenarioOptimization[] = markets.map((market, idx) => {
    // Use pre-sliced candles so the same Candle[] reference is shared across all
    // guideRuleMode × variant combinations, enabling WeakMap indicator cache hits.
    const candles = slicedBacktracking[market] ?? [];
    const optimized = perCoinParams[market]?.[v.slotId];

    // Always try to run a real backtest to get accurate trades/equityCurve/profitFactor.
    let btResult: BacktestResult | null = null;
    if (candles.length >= 60) {
      try {
        btResult = runBacktest(v.strategy, v.scenario, candles, config);
      } catch (e) {
        console.warn(`[backtest] ${market} ${v.slotId} ${guideRuleMode}: ${String((e as any)?.message ?? e).slice(0, 120)}`);
      }
    }
    // Fallback: use cached optimized stats when backtest is not possible
    if (!btResult && optimized) {
      btResult = {
        strategyId: v.slotId,
        scenarioId: v.scenarioId,
        scenarioName: v.scenarioLabel,
        market,
        finalValue: 1_000_000 * (1 + (optimized.returnRate ?? 0)),
        returnRate: optimized.returnRate ?? 0,
        maxDrawdown: optimized.maxDrawdown ?? 0,
        winRate: optimized.winRate ?? 0,
        tradeCount: optimized.trades ?? 0,
        profitFactor: 1,
        worstTradeReturn: 0,
        guideRuleMode,
        guideRejectedSignals: 0,
        trades: [],
        signalAudit: [],
        equityCurve: [],
      };
    }
    const liveCandles = live1m[market] ?? [];
    const quoteVol = liveCandles.length > 0
      ? sumRecentQuoteValue(liveCandles, TRADE_VALUE_LOOKBACK_CANDLES)
      : sumRecentQuoteValue(candles, TRADE_VALUE_LOOKBACK_CANDLES);

    return {
      market,
      candidateRank: idx + 1,
      tradeValue: quoteVol,
      score: (btResult?.returnRate ?? -1) + Math.min((btResult?.tradeCount ?? 0) / 1000, 0.02),
      bestResult: btResult ?? {
        strategyId: v.slotId, scenarioId: v.scenarioId, scenarioName: v.scenarioLabel,
        market, finalValue: 1_000_000, returnRate: 0, maxDrawdown: 0, winRate: 0,
        tradeCount: 0, profitFactor: 1, worstTradeReturn: 0,
        guideRuleMode, guideRejectedSignals: 0, trades: [], signalAudit: [], equityCurve: [],
      },
    };
  });

  optimizedMarkets.sort((a, b) =>
    b.bestResult.returnRate - a.bestResult.returnRate ||
    b.score - a.score ||
    b.tradeValue - a.tradeValue,
  );

  return {
    strategyId: v.slotId,
    strategyName: v.slotName,
    guideRuleMode,
    candidateMarketCount: markets.length,
    monitoringMarketCount: MONITORING_MARKET_COUNT,
    candidateMarkets: markets.map(market => ({
      market,
      tradeValue: sumRecentQuoteValue(live1m[market] ?? slicedBacktracking[market] ?? [], TRADE_VALUE_LOOKBACK_CANDLES),
      candleCount: (slicedBacktracking[market] ?? []).length,
    })),
    optimizedMarkets,
    selectedMarkets: optimizedMarkets.slice(0, MONITORING_MARKET_COUNT),
  };
}

function sumRecentQuoteValue(candles: Candle[], count: number): number {
  const recent = Number.isFinite(count) ? candles.slice(-count) : candles;
  return recent.reduce((sum, candle) => sum + candle.quoteVolume, 0);
}

function selectCandidateMarkets(backtracking1m: Record<string, Candle[]>): string[] {
  return Object.entries(backtracking1m)
    .map(([market, candles]) => ({
      market,
      tradeValue: sumRecentQuoteValue(candles, TRADE_VALUE_LOOKBACK_CANDLES),
      candleCount: candles.length,
    }))
    .filter(item => item.candleCount >= 60 && item.tradeValue > 0)
    .sort((a, b) => b.tradeValue - a.tradeValue)
    .slice(0, CANDIDATE_MARKET_COUNT)
    .map(item => item.market);
}

function unionPlanMarkets(plansByMode: Record<GuideRuleMode, TraderOptimizationPlan[]>): string[] {
  const set = new Set<string>();
  for (const mode of GUIDE_MODES) {
    for (const plan of plansByMode[mode]) {
      for (const item of plan.selectedMarkets) set.add(item.market);
    }
  }
  return [...set];
}

function selectedMarketSummaries(
  markets: string[],
  backtracking1m: Record<string, Candle[]>,
  anomalyMap: Map<string, SelectedMarket>,
): SelectedMarket[] {
  return markets.map(market => {
    const known = anomalyMap.get(market);
    if (known) return known;
    // Market was selected by trade-value fallback — run detection to get real event data
    const candles = backtracking1m[market] ?? [];
    const events  = candles.length >= 70 ? detect1m(market, candles) : [];
    return {
      market,
      lastEventTs:    events.length > 0 ? events[events.length - 1].timestamp : (candles.at(-1)?.timestamp ?? Date.now()),
      histEventCount: events.length,
      liveEventCount: 0,
    };
  });
}

function getMarketTimeRange(candlesByMarket: Record<string, Candle[]>, markets: string[]) {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const market of markets) {
    for (const candle of candlesByMarket[market] ?? []) {
      if (candle.timestamp < start) start = candle.timestamp;
      if (candle.timestamp > end) end = candle.timestamp;
    }
  }
  return {
    start: Number.isFinite(start) ? start : 0,
    end: end > 0 ? end + 60_000 : 0,
  };
}
async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as T; }
  catch { return null; }
}

// ─── daily log ────────────────────────────────────────────────────────────────
const STRATEGY_META: Array<{ id: TraderId; label: string }> = [
  { id: "momentum",   label: "Anomaly-A (Calm Impulse)"    },
  { id: "range-grid", label: "Anomaly-B (First Explosion)"  },
  { id: "arbitrage",  label: "Anomaly-C (Confirmed Burst)"  },
  { id: "anomaly",    label: "Anomaly-D (Sweep Best)"       },
];

function fmtPct(r: number) {
  const sign = r > 0 ? "+" : "";
  return `${sign}${(r * 100).toFixed(2)}%`;
}

async function appendDailyLog(date: string): Promise<void> {
  const paper = await readJsonOrNull<any>(paperPath);
  if (!paper?.caseResults) {
    console.warn("[daily-log] paper results not found — skipping log");
    return;
  }

  const cases = paper.caseResults as Record<string, Record<string, Record<string, any>>>;

  const rows = STRATEGY_META.map(({ id, label }) => {
    function cell(guide: string, safety: string) {
      const r = cases[guide]?.[safety]?.[id];
      if (!r) return "- (0t)";
      return `${fmtPct(r.returnRate)} (${r.trades?.length ?? 0}t)`;
    }
    return `| ${label} | ${cell("strict","enabled")} | ${cell("strict","disabled")} | ${cell("ignored","enabled")} | ${cell("ignored","disabled")} |`;
  });

  const block = [
    `## ${date}`,
    ``,
    `| 전략 | Guide O / Safe O | Guide O / Safe X | Guide X / Safe O | Guide X / Safe X |`,
    `|------|:----------------:|:----------------:|:----------------:|:----------------:|`,
    ...rows,
    ``,
    `> 기록 시각: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  await mkdir(docsDir, { recursive: true });

  // Create file with header if it doesn't exist yet
  let exists = false;
  try { await readFile(simLogPath, "utf8"); exists = true; } catch { /* new file */ }
  if (!exists) {
    await writeFile(simLogPath, "# Anomaly Simulation Daily Log\n\n", "utf8");
  }

  await appendFile(simLogPath, block, "utf8");
  console.log(`  ✓ daily log appended → ${path.relative(root, simLogPath)}`);
}

function countMarketsWithWindowData(candlesByMarket: Record<string, Candle[]>, start: number, end: number, markets: string[]): number {
  return markets.filter(market => (candlesByMarket[market] ?? []).filter(c => c.timestamp >= start && c.timestamp < end).length >= REFIT_MIN_CANDLES).length;
}

function blendOptimizedParams(previous: OptimizedParams, next: OptimizedParams, previousWeight: number): OptimizedParams {
  const nextWeight = 1 - previousWeight;
  const blended: OptimizedParams = {};
  const markets = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]);
  for (const market of markets) {
    blended[market] = {};
    const slots = new Set([...Object.keys(previous?.[market] ?? {}), ...Object.keys(next?.[market] ?? {})]);
    for (const slot of slots) {
      const prev = previous?.[market]?.[slot];
      const nxt = next?.[market]?.[slot];
      blended[market]![slot] = blendCoinParams(prev, nxt, previousWeight, nextWeight) as any;
    }
  }
  return blended;
}

function blendCoinParams(previous: any, next: any, previousWeight: number, nextWeight: number) {
  if (!previous) return next;
  if (!next) return previous;
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    const prev = previous[key];
    const nxt = next[key];
    if (Number.isFinite(prev) && Number.isFinite(nxt)) {
      const value = prev * previousWeight + nxt * nextWeight;
      out[key] = Number.isInteger(prev) && Number.isInteger(nxt) ? Math.round(value) : value;
    } else if (Number.isFinite(nxt)) out[key] = nxt;
    else if (Number.isFinite(prev)) out[key] = prev;
  }
  return out;
}
// main cycle ───────────────────────────────────────────────────────────────
async function runCycle() {
  // Auto-fetch fresh 1m candle data before each simulation cycle.
  // Errors are non-fatal — simulation continues with cached data.
  try {
    await execAsync("node scripts/fetch-anomaly-1m.mjs", { cwd: root, timeout: Number(process.env.ANOMALY_FETCH_TIMEOUT_MS ?? 240_000) });
  } catch (e: any) {
    console.error(`[fetch] 1m data fetch failed (using cached): ${String(e?.message ?? e).slice(0, 120)}`);
  }

  // Load live 1m data: prefer anomaly-specific file (fetch:anomaly:1m),
  // fall back to Codex's shared file (fewer markets, but always available).
  let rawLive: any;
  let live1mSource: string;
  try {
    rawLive = JSON.parse(await readFile(anomaly1mPath, "utf8"));
    live1mSource = path.relative(root, anomaly1mPath);
  } catch {
    // First run: 1m data not fetched yet — select markets from hist5m only, then exit with instructions
    rawLive = { candlesByMarket: {}, generatedAt: new Date().toISOString() };
    live1mSource = "(not fetched yet — run 'npm run fetch:anomaly:1m' after selection)";
  }

  let rawBacktracking: any;
  try {
    rawBacktracking = JSON.parse(await readFile(backtracking1mPath, "utf8"));
  } catch {
    throw new Error(
      `Backtracking data not found at ${backtracking1mPath}. ` +
      "Run 'npm run fetch:anomaly:1m:backtracking' first.",
    );
  }

  const live1m: Record<string, Candle[]> = rawLive.candlesByMarket ?? {};
  const backtracking1m: Record<string, Candle[]> = rawBacktracking.candlesByMarket ?? {};

  const today = kstDateString();
  // Reset on every cycle so a new day always triggers fresh optimization.
  // Without this, the global stays populated from the previous day and the
  // `Object.keys(perCoinParams).length === 0` guard below never fires.
  perCoinParams = {};
  const optimizedCache = await readJsonOrNull<any>(optimizedParamsPath);
  if (optimizedCache?.date === today && typeof optimizedCache.source === "string" && optimizedCache.source.startsWith("1m-7d-backtracking") && optimizedCache.params) {
    perCoinParams = optimizedCache.params ?? {};
    const n = Object.keys(perCoinParams).length;
    if (n > 0) console.log(`  Loaded per-coin optimized params: ${n} markets`);
  }

  const sampleMarket  = Object.keys(live1m)[0] ?? Object.keys(backtracking1m)[0] ?? "";
  const sampleCandles = live1m[sampleMarket] ?? backtracking1m[sampleMarket] ?? [];
  const firstTs = sampleCandles[0]?.timestamp ?? 0;
  const lastTs  = sampleCandles.at(-1)?.timestamp ?? 0;

  console.log(`\n[${new Date().toISOString()}] Anomaly Variants Forward Simulation`);
  console.log(`  Live 1m : ${live1mSource}`);
  console.log(`            ${Object.keys(live1m).length} markets  ${new Date(firstTs).toISOString().slice(0,16)} ~ ${new Date(lastTs).toISOString().slice(0,16)} UTC`);
  console.log(`  Backtracking 1m : ${Object.keys(backtracking1m).length} markets  last=${new Date(rawBacktracking.generatedAt ?? 0).toISOString().slice(0,16)}`);

  const cachedSelection = await readJsonOrNull<any>(selectionPath);

  // Detect anomaly events from 1m backtracking — the core differentiating logic
  const detectedAnomalyMarkets = selectAnomalyMarkets(backtracking1m, live1m, LOOKBACK_DAYS, REMOVAL_DAYS);
  const anomalyMap = new Map<string, SelectedMarket>(detectedAnomalyMarkets.map(m => [m.market, m]));
  console.log(`  Anomaly detection: ${detectedAnomalyMarkets.length} markets with events in last ${REMOVAL_DAYS} days`);

  let candidateMarketNames: string[];
  let candidateMarketLastEvents: Record<string, number>;

  if (cachedSelection?.date === today && Array.isArray(cachedSelection.candidateMarkets)) {
    // ── Same-day cache hit: reuse today's pool as-is ──────────────────────────
    candidateMarketNames = cachedSelection.candidateMarkets.filter(
      (market: unknown): market is string => typeof market === "string",
    );
    candidateMarketLastEvents = cachedSelection.candidateMarketLastEvents ?? {};
  } else {
    // ── Date changed (or first run): accumulate pool ──────────────────────────
    // Design:
    //   1. Load previous pool from cache (persist across days)
    //   2. Union with newly detected anomaly markets (adds new coins)
    //   3. Remove markets with no event in last POOL_REMOVAL_DAYS (45 days)
    //   4. If pool is empty (first run), seed with top-N by trade volume
    const previousPool: string[] = Array.isArray(cachedSelection?.candidateMarkets)
      ? cachedSelection.candidateMarkets.filter((m: unknown): m is string => typeof m === "string")
      : [];
    const previousLastEvents: Record<string, number> = cachedSelection?.candidateMarketLastEvents ?? {};

    // Merge lastEventTs: keep the most recent value for each market
    const mergedLastEvents: Record<string, number> = { ...previousLastEvents };
    for (const info of detectedAnomalyMarkets) {
      const prev = mergedLastEvents[info.market] ?? 0;
      if (info.lastEventTs > prev) mergedLastEvents[info.market] = info.lastEventTs;
    }

    // Union: previous pool ∪ newly detected (no duplicates)
    const poolSet = new Set<string>([...previousPool, ...detectedAnomalyMarkets.map(m => m.market)]);

    // Remove markets with no event recorded in last POOL_REMOVAL_DAYS days
    const poolRemovalCutoff = Date.now() - POOL_REMOVAL_DAYS * MS_DAY;
    const retained = [...poolSet].filter(market => {
      const lastTs = mergedLastEvents[market];
      if (lastTs === undefined) return true; // no record yet → keep (newly seeded)
      return lastTs >= poolRemovalCutoff;
    });

    if (retained.length === 0) {
      // First run or all stale → seed with top-N by trade volume
      console.log(`  Pool empty — seeding from trade-value top-${CANDIDATE_MARKET_COUNT} ranking`);
      candidateMarketNames = selectCandidateMarkets(backtracking1m);
      candidateMarketLastEvents = {};
    } else {
      candidateMarketNames = retained;
      candidateMarketLastEvents = mergedLastEvents;
      const newlyAdded = detectedAnomalyMarkets.filter(m => !previousPool.includes(m.market));
      const removedCount = previousPool.filter(m => !retained.includes(m)).length;
      console.log(
        `  Pool update: ${previousPool.length} prev + ${newlyAdded.length} new` +
        ` - ${removedCount} stale (>${POOL_REMOVAL_DAYS}d) = ${candidateMarketNames.length} total`,
      );
      if (newlyAdded.length > 0) {
        console.log(`  Newly added: ${newlyAdded.map(m => m.market.replace("KRW-", "")).join(", ")}`);
      }
    }
  }
  const isNewSelection = cachedSelection?.date !== today || !Array.isArray(cachedSelection?.markets) || cachedSelection?.source !== "1m-7d-backtracking" || cachedSelection?.monitoringMarketCount !== MONITORING_MARKET_COUNT;

  if (candidateMarketNames.length === 0) {
    throw new Error("No anomaly candidate markets. Run npm run fetch:anomaly:1m:backtracking first.");
  }

  if (Object.keys(perCoinParams).length === 0) {
    const backtrackingRange = getMarketTimeRange(backtracking1m, candidateMarketNames);
    const backtrackingStart = backtrackingRange.start;
    const backtrackingEnd = backtrackingRange.end;
    console.log(`\n  Optimizing base params from 1m/7d backtracking for ${candidateMarketNames.length} candidates...`);
    const baseOpt = await runOptimization(backtracking1m, backtrackingStart, backtrackingEnd, candidateMarketNames, today);
    perCoinParams = baseOpt.params;

    const previousDayStart = kstTodayStartMs() - MS_DAY;
    const previousDayEnd = kstTodayStartMs();
    const eligibleMarkets = countMarketsWithWindowData(live1m, previousDayStart, previousDayEnd, candidateMarketNames);
    if (eligibleMarkets >= MONITORING_MARKET_COUNT) {
      console.log(`  Refit with previous 24h data: ${eligibleMarkets} eligible markets, weight previous=${REFIT_PREVIOUS_WEIGHT.toFixed(2)}`);
      const refitOpt = await runOptimization(live1m, previousDayStart, previousDayEnd, candidateMarketNames, today);
      const previousParams = optimizedCache?.params ?? baseOpt.params;
      perCoinParams = blendOptimizedParams(previousParams, refitOpt.params, REFIT_PREVIOUS_WEIGHT);
      await writeFile(optimizedParamsPath, JSON.stringify({
        ...refitOpt,
        date: today,
        source: "1m-7d-backtracking+24h-refit",
        previousWeight: REFIT_PREVIOUS_WEIGHT,
        refitWindowStart: new Date(previousDayStart).toISOString(),
        refitWindowEnd: new Date(previousDayEnd).toISOString(),
        eligibleMarkets,
        params: perCoinParams,
      }) + "\n", "utf8");
    } else {
      console.log(`  Refit skipped: ${eligibleMarkets}/${MONITORING_MARKET_COUNT} markets have enough previous-24h data. Using 1m/7d params.`);
      await writeFile(optimizedParamsPath, JSON.stringify({
        ...baseOpt,
        date: today,
        source: "1m-7d-backtracking",
        refitSkipped: true,
        refitSkipReason: `Only ${eligibleMarkets} markets had enough previous-24h candles`,
        params: perCoinParams,
      }) + "\n", "utf8");
    }
    console.log(`  wrote ${path.relative(root, optimizedParamsPath)}`);
  } else {
    // Cache hit — optimize any new markets that were not in the original cache
    const missingMarkets = candidateMarketNames.filter(m => !perCoinParams[m]);
    if (missingMarkets.length > 0) {
      console.log(`  Optimizing ${missingMarkets.length} new markets not in today's cache: ${missingMarkets.map(m => m.replace("KRW-","")).join(", ")}`);
      const backtrackingRange = getMarketTimeRange(backtracking1m, missingMarkets);
      const addOpt = await runOptimization(backtracking1m, backtrackingRange.start, backtrackingRange.end, missingMarkets, today);
      perCoinParams = { ...perCoinParams, ...addOpt.params };
      // Update cache file with new markets
      await writeFile(optimizedParamsPath, JSON.stringify({
        ...(optimizedCache ?? {}),
        params: perCoinParams,
      }) + "\n", "utf8");
      console.log(`  Updated cache with ${missingMarkets.length} new markets`);
    }
  }

  // Detect yesterday's anomaly events to adapt per-variant exit parameters
  const yesterdayEvents = detectYesterdayEvents(live1m, candidateMarketNames);
  const adaptedParams: Record<TraderId, AdaptedParams> = yesterdayEvents.length > 0
    ? adaptVariantParams(yesterdayEvents)
    : medianVariantParams(perCoinParams);
  if (yesterdayEvents.length > 0) {
    const moves = yesterdayEvents.map(e => e.priceMoveRatio).sort((a, b) => a - b);
    const median = moves[Math.floor(moves.length / 2)];
    console.log(`  Parameter adaptation: ${yesterdayEvents.length} yesterday events, medianMove=${(median * 100).toFixed(1)}%`);
  } else {
    console.log(`  Parameter adaptation: no yesterday events — using median of perCoinParams`);
  }

  const variants = buildVariants(adaptedParams);

  // Pre-slice candles per market so the same Candle[] reference is shared across
  // all guideRuleMode × variant combos, enabling WeakMap indicator cache hits.
  const slicedBacktracking: Record<string, Candle[]> = {};
  for (const market of candidateMarketNames) {
    const all = backtracking1m[market] ?? [];
    slicedBacktracking[market] = all.length > MAX_BACKTRACKING_CANDLES ? all.slice(-MAX_BACKTRACKING_CANDLES) : all;
  }

  const plansByMode: Record<GuideRuleMode, TraderOptimizationPlan[]> = { ignored: [], strict: [] };
  for (const guideRuleMode of GUIDE_MODES) {
    for (const v of variants) {
      plansByMode[guideRuleMode].push(buildOptimizationPlan(v, guideRuleMode, slicedBacktracking, backtracking1m, live1m, candidateMarketNames));
    }
  }

  const marketNames = unionPlanMarkets(plansByMode);
  const selectedMarkets = selectedMarketSummaries(marketNames, backtracking1m, anomalyMap);
  console.log(`\n  Candidate markets (${candidateMarketNames.length}) -> display markets (${marketNames.length}) — KST ${today}${isNewSelection ? " [NEW]" : " [cached]"}`);
  for (const mode of GUIDE_MODES) {
    for (const plan of plansByMode[mode]) {
      console.log(`  ${plan.strategyName.padEnd(32)} [${mode.padEnd(7)}] selected ${plan.selectedMarkets.length}/${plan.candidateMarkets.length}`);
    }
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(selectionPath, JSON.stringify({
    date: today,
    selectedAt: new Date().toISOString(),
    source: "1m-7d-backtracking",
    candidateMarkets: candidateMarketNames,
    candidateMarketLastEvents,   // lastEventTs per market — drives 45-day pool removal
    monitoringMarketCount: MONITORING_MARKET_COUNT,
    markets: selectedMarkets,
  }) + "\n", "utf8");

  // Candles for chart: today (00:00 KST) + 3h of yesterday for continuity
  const rollingStartMs = kstTodayStartMs() - 3 * 3_600_000;
  const allTodayMap: Record<string, Candle[]> = {};
  for (const m of marketNames) allTodayMap[m] = (live1m[m] ?? []).filter(c => c.timestamp >= rollingStartMs);
  const todayCandleCount = allTodayMap[marketNames[0]]?.length ?? 0;
  const allTodayTimestamps = new Set<number>();
  for (const m of marketNames) for (const c of allTodayMap[m] ?? []) allTodayTimestamps.add(c.timestamp);
  const totalTimestamps = allTodayTimestamps.size;
  console.log(`\n  Today's 1m candles since 00:00 KST: ~${todayCandleCount} per market (${totalTimestamps} unique timestamps across display markets)`);
  console.log(`  Paper sim universe: ${marketNames.length} markets (variant plans select ${MONITORING_MARKET_COUNT} each)\n`);

  const paperResults: Record<GuideRuleMode, Record<string, any>> = { ignored: {}, strict: {} };
  const caseResults: Record<GuideRuleMode, Record<SafetyMode, Record<string, any>>> = {
    ignored: { enabled: {}, disabled: {} },
    strict:  { enabled: {}, disabled: {} },
  };
  const paperRows: any[] = [];

  for (const guideRuleMode of GUIDE_MODES) {
    for (const v of variants) {
      const plan = plansByMode[guideRuleMode].find(p => p.strategyId === v.slotId)!;

      for (const autoBlockMode of SAFETY_MODES) {
        const result = runPaperTradingSimulation(v.strategy, plan, allTodayMap, {
          guideRuleMode,
          autoBlockMode,
          maxCandles: totalTimestamps + 1,
        });

        caseResults[guideRuleMode][autoBlockMode][v.slotId] = result;
        if (autoBlockMode === "disabled") paperResults[guideRuleMode][v.slotId] = result;

        const retPct = (result.returnRate * 100).toFixed(2);
        const arrow  = result.returnRate > 0.001 ? "+" : result.returnRate < -0.001 ? "-" : "=";
        console.log(
          `  ${v.slotName.padEnd(32)} [${guideRuleMode.padEnd(7)} / safety:${autoBlockMode.padEnd(8)}] ` +
          `${arrow} ${retPct.padStart(7)}%  trades:${result.trades.length}  blocked:${result.blockedSignals.length}  decisions:${result.decisions.length}`
        );

        paperRows.push({
          strategyId:   v.slotId,
          strategyName: v.slotName,
          guideRuleMode,
          autoBlockMode,
          finalValue:   result.finalValue,
          returnRate:   result.returnRate,
          trades:       result.trades.length,
          blocked:      result.blockedSignals.length,
          decisions:    result.decisions.length,
          startedAt:    result.startedAt,
          endedAt:      result.endedAt,
        });
      }
    }
  }

  await mkdir(outputDir, { recursive: true });

  // ① paper-trading-1m-daily-results.json
  const paperOutput = {
    generatedAt: new Date().toISOString(),
    marketCache: {
      path:              live1mSource,
      generatedAt:       rawLive.generatedAt ?? new Date().toISOString(),
      candleUnitMinutes: rawLive.candleUnitMinutes ?? 1,
      selectedMarkets:   marketNames,
    },
    maxCandles: todayCandleCount,
    rows:       paperRows,
    results:    paperResults,
    caseResults,
  };
  await writeFile(paperPath, `${JSON.stringify(paperOutput)}\n`, "utf8");

  // ② dashboard-results.json
  function buildComparisons(mode: GuideRuleMode) {
    return variants.flatMap(v => {
      const plan = plansByMode[mode].find(p => p.strategyId === v.slotId)!;
      if (!plan || plan.optimizedMarkets.length === 0) return [];
      const best = plan.optimizedMarkets.reduce(
        (top, m) => (m.bestResult.returnRate > top.bestResult.returnRate ? m : top),
      );
      return [{
        strategyName:    v.slotName,
        bestResult:      best.bestResult,
        testedMarkets:   plan.optimizedMarkets.length,
        testedScenarios: 1,
      }];
    });
  }

  const comparisonsByGuideMode = {
    ignored: buildComparisons("ignored"),
    strict:  buildComparisons("strict"),
  };
  const guideModeComparisons = variants.map(v => {
    const ig = comparisonsByGuideMode.ignored.find(c => c.strategyName === v.slotName)!;
    const st = comparisonsByGuideMode.strict.find(c => c.strategyName === v.slotName)!;
    const bestMode = ig.bestResult.returnRate >= st.bestResult.returnRate ? "ignored" : "strict";
    return { strategyName: v.slotName, ignored: ig, strict: st, bestMode };
  });

  const dashOutput = {
    generatedAt:                  new Date().toISOString(),
    guideRuleMode:                "ignored",
    comparisons:                  comparisonsByGuideMode.ignored,
    comparisonsByGuideMode,
    guideModeComparisons,
    optimizationPlansByGuideMode: plansByMode,
    optimizationPlans:            plansByMode["ignored"],
  };
  await writeFile(dashPath, `${JSON.stringify(dashOutput)}\n`, "utf8");

  // ③ upbit-krw-1m-daily.json — today's 1m candles for Daily 운영 UI
  const daily1mOutput = {
    source:             "upbit-public-api",
    generatedAt:        new Date().toISOString(),
    candleUnitMinutes:  1,
    selectedMarkets:    marketNames,
    candlesByMarket:    allTodayMap,
  };
  await writeFile(daily1mPath, `${JSON.stringify(daily1mOutput)}\n`, "utf8");

  console.log(`\n  ✓ ${path.relative(root, paperPath)}`);
  console.log(`  ✓ ${path.relative(root, dashPath)}`);
  console.log(`  ✓ ${path.relative(root, daily1mPath)}`);
  if (isNewSelection) console.log(`  ✓ ${path.relative(root, selectionPath)}`);
}

// ─── entry ────────────────────────────────────────────────────────────────────
await runCycle();

if (LOOP_MS > 0) {
  console.log(`\nLoop mode active - re-running every ${LOOP_MS / 1000}s\n`);
  let running = false;
  let lastDate = kstDateString();

  setInterval(async () => {
    if (running) {
      console.warn("[loop] previous cycle is still running; skipping this tick");
      return;
    }
    running = true;
    try {
      const today = kstDateString();
      if (today !== lastDate) {
        // 날짜가 바뀌었다 = 전날 시뮬레이션이 막 끝남 → 결과를 로그에 기록
        console.log(`\n[daily-log] Date changed ${lastDate} → ${today}. Saving previous day's results...`);
        await appendDailyLog(lastDate);
        lastDate = today;
      }
      await runCycle();
    }
    catch (e) { console.error("[loop] error:", e); }
    finally { running = false; }
  }, LOOP_MS);
}
