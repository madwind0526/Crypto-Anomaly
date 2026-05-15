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
 *   1. Scan hist5m (90-day) for anomaly events:
 *        10-min (max_high − min_low) / min_low > 10%
 *        AND 10-min volume > 3× previous 1-hour average
 *        WITH 2-hour cooldown between counted events
 *   2. Scan live 1m (last 24h) for new events not yet in hist5m
 *   3. Union of both → all markets that ever showed the pattern
 *   4. Remove markets with no event in the last 45 days
 *   5. All 4 variants monitor the SAME market list
 *
 * Parameter adaptation (at midnight):
 *   Compute median price-move from yesterday's live-1m anomaly events
 *   → adjust trailingStopPct and maxHoldCandles per variant
 *
 * Reads  : data/market/upbit-krw-1m-daily.json  (live-accumulating)
 *          data/market/upbit-krw-5m.json          (90-day history)
 * Writes : public/market/paper-trading-1m-daily-results.json
 *          public/market/dashboard-results.json
 *          public/market/anomaly-selection.json   (daily cache)
 *
 * Usage:
 *   node scripts/anomaly-variants-sim.mjs              (one-shot)
 *   node scripts/anomaly-variants-sim.mjs --loop=60000 (continuous, 60s interval)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runPaperTradingSimulation } from "../src/simulation/paperTrading";
import { runBacktest, defaultBacktestConfig } from "../src/simulation/backtest";
import { anomalyScenario, anomalyStrategy } from "../src/strategies/anomaly";
import { sma, rateOfChange } from "../src/indicators/technical";
import type {
  Candle, GuideRuleMode, Strategy, StrategyContext,
  StrategyDecision, StrategyScenario, TraderId,
} from "../src/types/trading";
import type { TraderOptimizationPlan, MarketScenarioOptimization } from "../src/simulation/traderOptimization";

// ─── paths ────────────────────────────────────────────────────────────────────
const root          = process.cwd();   // C:\Claude\Crypto-Anomaly
const anomaly1mPath = path.join(root, "data", "market", "upbit-krw-1m-anomaly.json");
const histPath      = path.join(root, "data", "market", "upbit-krw-5m.json");
const outputDir     = path.join(root, "public", "market");
const paperPath     = path.join(outputDir, "paper-trading-1m-daily-results.json");
const dashPath      = path.join(outputDir, "dashboard-results.json");
const selectionPath = path.join(outputDir, "anomaly-selection.json");

// ─── constants ────────────────────────────────────────────────────────────────
const GUIDE_MODES        = ["ignored", "strict"] as GuideRuleMode[];
const MAX_HIST_CANDLES   = Number(process.env.MAX_HIST_CANDLES ?? 4320);
const LOOP_MS            = Number(process.env.LOOP_INTERVAL_MS ?? 0);
const LOOKBACK_DAYS      = Number(process.env.LOOKBACK_DAYS    ?? 90);
const REMOVAL_DAYS       = Number(process.env.REMOVAL_DAYS     ?? 45);
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

const detect5m  = (m: string, cs: Candle[]) => detectAnomalyEvents(m, cs,  2, 12,  24); // 5m
const detect1m  = (m: string, cs: Candle[]) => detectAnomalyEvents(m, cs, 10, 60, 120); // 1m

// ─── market selection ─────────────────────────────────────────────────────────
interface SelectedMarket {
  market:           string;
  lastEventTs:      number;
  histEventCount:   number; // events in 90-day hist5m
  liveEventCount:   number; // events in last 24h live1m
}

/**
 * Select markets that have shown anomaly events.
 * Sources: hist5m (90-day lookback) + live1m (last 24h).
 * Removes markets with no event in the last REMOVAL_DAYS days.
 */
function selectAnomalyMarkets(
  hist5m:      Record<string, Candle[]>,
  live1m:      Record<string, Candle[]>,
  lookbackDays: number,
  removalDays:  number,
): SelectedMarket[] {
  const now          = Date.now();
  const cutoff       = now - lookbackDays * MS_DAY;
  const removalCutoff = now - removalDays * MS_DAY;
  const oneDayAgo    = now - MS_DAY;

  const marketMap = new Map<string, SelectedMarket>();

  // Scan hist5m (90-day history)
  for (const [market, candles] of Object.entries(hist5m)) {
    const recent = candles.filter(c => c.timestamp >= cutoff);
    if (recent.length < 14) continue;
    const events = detect5m(market, recent);
    if (events.length === 0) continue;
    const lastTs = events[events.length - 1].timestamp;
    marketMap.set(market, { market, lastEventTs: lastTs, histEventCount: events.length, liveEventCount: 0 });
  }

  // Scan live 1m (last 24h) — catches recent events not yet in hist5m
  for (const [market, candles] of Object.entries(live1m)) {
    const recent24h = candles.filter(c => c.timestamp >= oneDayAgo);
    if (recent24h.length < 70) continue; // need enough warmup
    const events = detect1m(market, recent24h);
    if (events.length === 0) continue;
    const lastTs    = events[events.length - 1].timestamp;
    const existing  = marketMap.get(market);
    marketMap.set(market, {
      market,
      lastEventTs:    Math.max(existing?.lastEventTs ?? 0, lastTs),
      histEventCount: existing?.histEventCount ?? 0,
      liveEventCount: events.length,
    });
  }

  // Remove markets with no event in removalDays
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
  const ind     = getInd(candles);
  const trail   = scenario.params.trailingStopPct ?? 0.028;
  const maxHold = scenario.params.maxHoldCandles  ?? 12;
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
  if (avgBody < 0.005 && curBody >= 0.015 && candles[i].close > candles[i].open
    && candles[i].volume / avgVol >= 1.5 && Math.abs(roc48) < 0.05)
    return buyAt(["calm-impulse", `body+${(curBody * 100).toFixed(1)}%`], 0.018, 0.06, trail, maxHold);
  return hold("no-signal");
}

// ─── Anomaly-B: S6-FirstExplosion ────────────────────────────────────────────
function decideB(ctx: StrategyContext, scenario: StrategyScenario): StrategyDecision {
  const { candles, candleIndex: i, position } = ctx;
  const ind     = getInd(candles);
  const trail   = scenario.params.trailingStopPct ?? 0.018;
  const maxHold = scenario.params.maxHoldCandles  ?? 6;
  if (i < 52) return hold("warming-up");
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.3;
    const rev  = ind.bodies[i] < -0.008;
    if (fade || rev || position.holdCandles >= maxHold) return sell(fade ? "volume-fade" : rev ? "reversal" : "time-stop");
    return hold("holding");
  }
  const avgVol = ind.avgVol48[i]; const roc48 = ind.roc48[i];
  if (avgVol === null || roc48 === null) return hold("no-data");
  let calm = true;
  for (let k = 1; k <= 3; k++) {
    if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
  }
  const body = ind.bodies[i]; const volR = candles[i].volume / avgVol; const topR = ind.topRatio[i];
  if (calm && body >= 0.025 && volR >= 3.5 && topR >= 0.60 && Math.abs(roc48) < 0.035)
    return buyAt(["explosion-candle", `vol×${volR.toFixed(1)}`, `body+${(body * 100).toFixed(1)}%`], 0.015, 0.045, trail, maxHold);
  return hold("no-signal");
}

// ─── Anomaly-C: S7-ConfirmedBurst ────────────────────────────────────────────
function decideC(ctx: StrategyContext, scenario: StrategyScenario): StrategyDecision {
  const { candles, candleIndex: i, position } = ctx;
  const ind     = getInd(candles);
  const trail   = scenario.params.trailingStopPct ?? 0.022;
  const maxHold = scenario.params.maxHoldCandles  ?? 8;
  if (i < 53) return hold("warming-up");
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
    const rev  = ind.bodies[i] < -0.01;
    if (fade || rev || position.holdCandles >= maxHold) return sell(fade ? "volume-fade" : rev ? "reversal" : "time-stop");
    return hold("holding");
  }
  const avgVol = ind.avgVol48[i]; const roc48 = ind.roc48[i];
  if (avgVol === null || roc48 === null) return hold("no-data");
  const prevBody = ind.bodies[i - 1]; const prevTop = ind.topRatio[i - 1];
  const prevVol  = candles[i - 1].volume / avgVol; const prevExt = ind.roc48[i - 1];
  let calm = true;
  for (let k = 2; k <= 4; k++) {
    if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
  }
  const prevExploded = calm && prevBody >= 0.025 && prevTop >= 0.60 && prevVol >= 3.5 && (prevExt ?? 1) < 0.035;
  if (!prevExploded) return hold("no-prev-explosion");
  const curVol = candles[i].volume / avgVol;
  if (curVol >= 1.8 && ind.bodies[i] >= 0 && candles[i].close >= candles[i - 1].close)
    return buyAt(["confirmed-burst", `prev×${prevVol.toFixed(1)}`, `cur×${curVol.toFixed(1)}`], 0.018, 0.055, trail, maxHold);
  return hold("no-confirm");
}

// ─── Anomaly-D: Sweep-best (baseline) ────────────────────────────────────────
function makeSweepBestScenario(adapted: AdaptedParams): StrategyScenario {
  return {
    ...anomalyScenario,
    id: "anomaly-sweep-best",
    name: "Sweep-best",
    params: { ...anomalyScenario.params, trailingStopPct: adapted.trailingStopPct },
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
      },
      scenario: sweepBestSc,
    },
  ];
}

// ─── optimization plan builder ────────────────────────────────────────────────
function buildOptimizationPlan(
  v:              Variant,
  guideRuleMode:  GuideRuleMode,
  hist5m:         Record<string, Candle[]>,
  live1m:         Record<string, Candle[]>,
  markets:        string[],
): TraderOptimizationPlan {
  const config = { ...defaultBacktestConfig, guideRuleMode };

  const optimizedMarkets: MarketScenarioOptimization[] = markets.map((market, idx) => {
    const allHist  = hist5m[market] ?? [];
    const candles  = allHist.length > MAX_HIST_CANDLES ? allHist.slice(-MAX_HIST_CANDLES) : allHist;
    let btResult   = null;
    if (candles.length >= 60) {
      try { btResult = runBacktest(v.strategy, v.scenario, candles, config); } catch {}
    }
    const liveCandles = live1m[market] ?? [];
    const quoteVol = liveCandles.length > 0
      ? liveCandles.reduce((s, c) => s + c.quoteVolume, 0)
      : candles.reduce((s, c) => s + c.quoteVolume, 0);

    return {
      market,
      candidateRank: idx + 1,
      tradeValue:    quoteVol,
      score:         Math.max(0, btResult?.returnRate ?? 0) + 1 / (idx + 1) * 0.01,
      bestResult:    btResult ?? {
        strategyId: v.slotId, scenarioId: v.scenarioId, scenarioName: v.scenarioLabel,
        market, finalValue: 1_000_000, returnRate: 0, maxDrawdown: 0, winRate: 0,
        tradeCount: 0, profitFactor: 1, worstTradeReturn: 0,
        guideRuleMode, guideRejectedSignals: 0, trades: [], signalAudit: [], equityCurve: [],
      },
    };
  });

  optimizedMarkets.sort((a, b) => b.score - a.score);

  return {
    strategyId:           v.slotId,
    strategyName:         v.slotName,
    guideRuleMode,
    candidateMarketCount: markets.length,
    monitoringMarketCount: markets.length,
    candidateMarkets:     markets.map(market => ({
      market,
      tradeValue:  (live1m[market] ?? hist5m[market] ?? []).reduce((s, c) => s + c.quoteVolume, 0),
      candleCount: (hist5m[market] ?? []).length,
    })),
    optimizedMarkets,
    selectedMarkets: optimizedMarkets, // all markets monitored — decide() filters entries
  };
}

// ─── main cycle ───────────────────────────────────────────────────────────────
async function runCycle() {
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

  const rawHist = JSON.parse(await readFile(histPath, "utf8"));

  const live1m: Record<string, Candle[]> = rawLive.candlesByMarket ?? {};
  const hist5m: Record<string, Candle[]> = rawHist.candlesByMarket ?? {};

  const sampleMarket  = Object.keys(live1m)[0] ?? "";
  const sampleCandles = live1m[sampleMarket]    ?? [];
  const firstTs = sampleCandles[0]?.timestamp    ?? 0;
  const lastTs  = sampleCandles.at(-1)?.timestamp ?? 0;

  console.log(`\n[${new Date().toISOString()}] Anomaly Variants Forward Simulation`);
  console.log(`  Live 1m : ${live1mSource}`);
  console.log(`            ${Object.keys(live1m).length} markets  ${new Date(firstTs).toISOString().slice(0,16)}–${new Date(lastTs).toISOString().slice(0,16)} UTC`);
  console.log(`  Hist 5m : ${Object.keys(hist5m).length} markets  last=${new Date(rawHist.generatedAt ?? 0).toISOString().slice(0,16)}`);

  // ── Daily market selection (once per KST day) ─────────────────────────────
  const today = kstDateString();
  let selectedMarkets: SelectedMarket[] | null = null;
  let adaptedParams:   Record<TraderId, AdaptedParams> | null = null;
  let isNewSelection   = false;

  try {
    const saved = JSON.parse(await readFile(selectionPath, "utf8"));
    if (saved.date === today && Array.isArray(saved.markets) && saved.adaptedParams) {
      selectedMarkets = saved.markets;
      adaptedParams   = saved.adaptedParams;
    }
  } catch { /* no cache */ }

  if (!selectedMarkets) {
    isNewSelection = true;
    console.log(`\n  Running daily market selection for KST ${today}...`);

    // Detect markets
    selectedMarkets = selectAnomalyMarkets(hist5m, live1m, LOOKBACK_DAYS, REMOVAL_DAYS);

    // Collect yesterday's anomaly events from live 1m for parameter adaptation
    const yesterdayStart = kstTodayStartMs() - MS_DAY;
    const yesterdayEnd   = kstTodayStartMs();
    const yesterdayEvents: AnomalyEvent[] = [];
    for (const [market, candles] of Object.entries(live1m)) {
      const yesterday = candles.filter(c => c.timestamp >= yesterdayStart && c.timestamp < yesterdayEnd);
      if (yesterday.length >= 70) {
        yesterdayEvents.push(...detect1m(market, yesterday));
      }
    }

    adaptedParams = adaptVariantParams(yesterdayEvents);

    // Save cache
    await mkdir(outputDir, { recursive: true });
    await writeFile(selectionPath, JSON.stringify({
      date:          today,
      selectedAt:    new Date().toISOString(),
      markets:       selectedMarkets,
      adaptedParams,
      yesterdayEventCount: yesterdayEvents.length,
      yesterdayMedianMovePct: yesterdayEvents.length > 0
        ? +(yesterdayEvents.map(e => e.priceMoveRatio).sort((a,b)=>a-b)[Math.floor(yesterdayEvents.length/2)] * 100).toFixed(1)
        : null,
    }) + "\n", "utf8");
  }

  const marketNames = selectedMarkets.map(m => m.market);
  console.log(`\n  Selected markets (${marketNames.length}) — KST ${today}${isNewSelection ? " [NEW]" : " [cached]"}:`);

  // Print table
  console.log(`  ${"market".padEnd(18)} ${"hist".padStart(5)} ${"live".padStart(5)} ${"lastEvent".padStart(12)} ${"daysSince".padStart(10)}`);
  console.log(`  ${"─".repeat(55)}`);
  const now = Date.now();
  for (const m of selectedMarkets) {
    const days = ((now - m.lastEventTs) / MS_DAY).toFixed(1);
    const last = new Date(m.lastEventTs).toISOString().slice(0, 10);
    console.log(`  ${m.market.padEnd(18)} ${String(m.histEventCount).padStart(5)} ${String(m.liveEventCount).padStart(5)} ${last.padStart(12)} ${(days + "d").padStart(10)}`);
  }

  if (isNewSelection) {
    console.log(`\n  Adapted parameters (based on yesterday's anomalies):`);
    for (const [slot, p] of Object.entries(adaptedParams!)) {
      const base = BASE_PARAMS[slot as TraderId];
      const trailDiff = ((p.trailingStopPct - base.trailingStopPct) * 100).toFixed(1);
      const holdDiff  = p.maxHoldCandles - base.maxHoldCandles;
      console.log(`    ${slot.padEnd(12)}  trail=${(p.trailingStopPct*100).toFixed(1)}% (base ${(base.trailingStopPct*100).toFixed(1)}%, ${trailDiff > "0" ? "+" : ""}${trailDiff}pp)  hold=${p.maxHoldCandles} (base ${base.maxHoldCandles}, ${holdDiff >= 0 ? "+" : ""}${holdDiff})`);
    }
  }

  // Build variants with (possibly adapted) parameters
  const variants = buildVariants(adaptedParams!);

  // Today's 1m candles (from 00:00 KST)
  const allTodayMap: Record<string, Candle[]> = {};
  for (const m of marketNames) allTodayMap[m] = todayCandles(live1m[m] ?? []);
  const todayCandleCount = allTodayMap[marketNames[0]]?.length ?? 0;
  console.log(`\n  Today's 1m candles since 00:00 KST: ~${todayCandleCount} per market`);
  console.log(`  Paper sim universe: ${marketNames.length} markets (all 4 variants)\n`);

  // ── Build plans + run paper sims ──────────────────────────────────────────
  const plansByMode:   Record<GuideRuleMode, TraderOptimizationPlan[]> = { ignored: [], strict: [] };
  const paperResults:  Record<GuideRuleMode, Record<string, any>>      = { ignored: {}, strict: {} };
  const paperRows:     any[]                                           = [];

  for (const guideRuleMode of GUIDE_MODES) {
    for (const v of variants) {
      const plan = buildOptimizationPlan(v, guideRuleMode, hist5m, live1m, marketNames);
      plansByMode[guideRuleMode].push(plan);

      const result = runPaperTradingSimulation(v.strategy, plan, allTodayMap, {
        guideRuleMode,
        maxCandles: todayCandleCount + 1,
      });

      paperResults[guideRuleMode][v.slotId] = result;

      const retPct = (result.returnRate * 100).toFixed(2);
      const arrow  = result.returnRate > 0.001 ? "▲" : result.returnRate < -0.001 ? "▼" : "≈";
      console.log(
        `  ${v.slotName.padEnd(32)} [${guideRuleMode.padEnd(7)}] ` +
        `${arrow} ${retPct.padStart(7)}%  trades:${result.trades.length}  decisions:${result.decisions.length}`
      );

      paperRows.push({
        strategyId:   v.slotId,
        strategyName: v.slotName,
        guideRuleMode,
        finalValue:   result.finalValue,
        returnRate:   result.returnRate,
        trades:       result.trades.length,
        decisions:    result.decisions.length,
        startedAt:    result.startedAt,
        endedAt:      result.endedAt,
      });
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
  };
  await writeFile(paperPath, `${JSON.stringify(paperOutput)}\n`, "utf8");

  // ② dashboard-results.json
  function buildComparisons(mode: GuideRuleMode) {
    return variants.map(v => {
      const plan = plansByMode[mode].find(p => p.strategyId === v.slotId)!;
      const best = plan.optimizedMarkets.reduce(
        (top, m) => (m.bestResult.returnRate > top.bestResult.returnRate ? m : top),
        plan.optimizedMarkets[0],
      );
      return {
        strategyName:   v.slotName,
        bestResult:     best?.bestResult ?? plan.optimizedMarkets[0].bestResult,
        testedMarkets:  plan.optimizedMarkets.length,
        testedScenarios: 1,
      };
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

  console.log(`\n  ✓ ${path.relative(root, paperPath)}`);
  console.log(`  ✓ ${path.relative(root, dashPath)}`);
  if (isNewSelection) console.log(`  ✓ ${path.relative(root, selectionPath)}`);
}

// ─── entry ────────────────────────────────────────────────────────────────────
await runCycle();

if (LOOP_MS > 0) {
  console.log(`\nLoop mode active — re-running every ${LOOP_MS / 1000}s\n`);
  setInterval(async () => {
    try { await runCycle(); }
    catch (e) { console.error("[loop] error:", e); }
  }, LOOP_MS);
}
