/**
 * Per-coin parameter optimizer for Anomaly strategies A / B / C / D.
 *
 * For each market × strategy:
 *   - Grid search over (trailingStopPct, maxHoldCandles, strategy-specific entry param)
 *   - Evaluate on yesterday's 1m candles
 *   - Pick best combo with ≥ MIN_TRADES trades; fall back to defaults otherwise
 *
 * Called once at 00:00 KST during daily market selection.
 * Results saved to public/market/anomaly-optimized-params.json.
 */

import { sma, rateOfChange } from "../src/indicators/technical";
import type { Candle } from "../src/types/trading";

// ─── exported types ────────────────────────────────────────────────────────────
export interface OptimizedCoinParams {
  trailingStopPct:  number;
  maxHoldCandles:   number;
  curBodyMin?:      number;  // A
  bodyMin?:         number;  // B
  confirmVolMin?:   number;  // C
  retracePctMin?:   number;  // D (Retracement)
  trades:           number;
  returnRate:       number;
  maxDrawdown:      number;
  winRate:          number;
}

export type OptimizedSlotParams = Partial<Record<string, OptimizedCoinParams>>;
export type OptimizedParams     = Record<string, OptimizedSlotParams>;

export interface OptimizedParamsResult {
  date:         string;
  optimizedAt:  string;
  durationMs:   number;
  totalCombos:  number;
  params:       OptimizedParams;
}

// ─── fee / slippage ───────────────────────────────────────────────────────────
const FEE_RATE = 0.0005;

/** Upbit tick-size based one-way slippage (mirrors backtest.ts upbitTickSlippage). */
function upbitTickSlippage(price: number): number {
  if (price < 10)     return 0.01  / price;
  if (price < 100)    return 0.1   / price;
  if (price < 500)    return 1     / price;
  if (price < 1_000)  return 5     / price;
  if (price < 5_000)  return 10    / price;
  if (price < 10_000) return 50    / price;
  return 100 / price;
}

// ─── indicator (mirrors anomaly-variants-sim's getInd) ────────────────────────
interface Ind {
  bodies:   number[];
  topRatio: number[];
  avgVol48: Array<number | null>;
  roc48:    Array<number | null>;
}

function computeInd(candles: Candle[]): Ind {
  const vols = candles.map(c => c.volume);
  return {
    bodies:   candles.map(c => (c.close - c.open) / (c.open || 1)),
    topRatio: candles.map(c => {
      const r = c.high - c.low; return r < 1e-10 ? 0.5 : (c.close - c.low) / r;
    }),
    avgVol48: sma(vols, 48),
    roc48:    rateOfChange(candles.map(c => c.close), 48),
  };
}

// ─── position helpers ─────────────────────────────────────────────────────────
interface Pos { entry: number; high: number; hold: number; }

function openPos(price: number): Pos {
  // Apply tick-based slippage and fee (buy at ask = price + 1 tick)
  const fillPrice = price * (1 + upbitTickSlippage(price));
  return { entry: fillPrice * (1 + FEE_RATE), high: price, hold: 0 };
}

function closePos(pos: Pos, exitPrice: number, cash: number): number {
  // Apply tick-based slippage and fee (sell at bid = exitPrice - 1 tick)
  const netExit = exitPrice * (1 - upbitTickSlippage(exitPrice)) * (1 - FEE_RATE);
  return cash * (1 + (netExit - pos.entry) / pos.entry);
}

interface BtResult { returnRate: number; trades: number; maxDrawdown: number; winRate: number; }

// ─── Strategy A: Calm Impulse ─────────────────────────────────────────────────
function backtestA(
  candles: Candle[], ind: Ind,
  p: { trailingStopPct: number; maxHoldCandles: number; curBodyMin: number },
): BtResult {
  const { trailingStopPct: trail, maxHoldCandles: maxHold, curBodyMin } = p;
  let cash = 1.0; let pos: Pos | null = null;
  let trades = 0; let wins = 0;
  let peakCash = 1.0; let maxDrawdown = 0;

  for (let i = 52; i < candles.length; i++) {
    const price  = candles[i].close;
    const avgVol = ind.avgVol48[i];
    if (pos) {
      pos.high = Math.max(pos.high, candles[i].high);
      const stop = pos.high * (1 - trail);
      const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
      if (price <= stop || fade || pos.hold >= maxHold) {
        const exitPrice = price <= stop ? stop : price;
        const prevCash = cash;
        cash = closePos(pos, exitPrice, cash);
        if (cash > prevCash) wins++;
        pos = null; trades++;
        peakCash = Math.max(peakCash, cash);
        maxDrawdown = Math.max(maxDrawdown, peakCash > 0 ? (peakCash - cash) / peakCash : 0);
      } else { pos.hold++; }
    } else {
      const roc48 = ind.roc48[i];
      if (avgVol === null || roc48 === null) continue;
      const recentBodies = ind.bodies.slice(i - 15, i).map(Math.abs);
      const avgBody = recentBodies.reduce((s, v) => s + v, 0) / 15;
      const body = ind.bodies[i];
      if (avgBody < 0.005 && body >= curBodyMin && candles[i].close > candles[i].open
        && candles[i].volume / avgVol >= 1.5 && Math.abs(roc48) < 0.05) {
        pos = openPos(price);
      }
    }
  }
  if (pos) {
    const prevCash = cash;
    cash = closePos(pos, candles.at(-1)!.close, cash);
    if (cash > prevCash) wins++;
    trades++;
  }
  return { returnRate: cash - 1, trades, maxDrawdown, winRate: trades > 0 ? wins / trades : 0 };
}

// ─── Strategy B: First Explosion ──────────────────────────────────────────────
function backtestB(
  candles: Candle[], ind: Ind,
  p: { trailingStopPct: number; maxHoldCandles: number; bodyMin: number },
): BtResult {
  const { trailingStopPct: trail, maxHoldCandles: maxHold, bodyMin } = p;
  let cash = 1.0; let pos: Pos | null = null;
  let trades = 0; let wins = 0;
  let peakCash = 1.0; let maxDrawdown = 0;

  for (let i = 52; i < candles.length; i++) {
    const price  = candles[i].close;
    const avgVol = ind.avgVol48[i];
    if (pos) {
      pos.high = Math.max(pos.high, candles[i].high);
      const stop = pos.high * (1 - trail);
      const fade = avgVol !== null && candles[i].volume < avgVol * 1.3;
      const rev  = ind.bodies[i] < -0.008;
      if (price <= stop || fade || rev || pos.hold >= maxHold) {
        const exitPrice = price <= stop ? stop : price;
        const prevCash = cash;
        cash = closePos(pos, exitPrice, cash);
        if (cash > prevCash) wins++;
        pos = null; trades++;
        peakCash = Math.max(peakCash, cash);
        maxDrawdown = Math.max(maxDrawdown, peakCash > 0 ? (peakCash - cash) / peakCash : 0);
      } else { pos.hold++; }
    } else {
      if (avgVol === null) continue;
      let calm = true;
      for (let k = 1; k <= 3; k++) {
        if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
      }
      const pre5Close = candles[Math.max(0, i - 6)].close;
      const pre1Close = candles[i - 1].close;
      const preRoc5   = pre5Close > 0 ? Math.abs((pre1Close - pre5Close) / pre5Close) : 0;
      const body = ind.bodies[i]; const volR = candles[i].volume / avgVol;
      if (calm && body >= bodyMin && volR >= 3.5 && ind.topRatio[i] >= 0.60 && preRoc5 < 0.05) {
        pos = openPos(price);
      }
    }
  }
  if (pos) {
    const prevCash = cash;
    cash = closePos(pos, candles.at(-1)!.close, cash);
    if (cash > prevCash) wins++;
    trades++;
  }
  return { returnRate: cash - 1, trades, maxDrawdown, winRate: trades > 0 ? wins / trades : 0 };
}

// ─── Strategy C: Confirmed Burst ──────────────────────────────────────────────
function backtestC(
  candles: Candle[], ind: Ind,
  p: { trailingStopPct: number; maxHoldCandles: number; confirmVolMin: number },
): BtResult {
  const { trailingStopPct: trail, maxHoldCandles: maxHold, confirmVolMin } = p;
  let cash = 1.0; let pos: Pos | null = null;
  let trades = 0; let wins = 0;
  let peakCash = 1.0; let maxDrawdown = 0;

  for (let i = 53; i < candles.length; i++) {
    const price  = candles[i].close;
    const avgVol = ind.avgVol48[i];
    if (pos) {
      pos.high = Math.max(pos.high, candles[i].high);
      const stop = pos.high * (1 - trail);
      const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
      const rev  = ind.bodies[i] < -0.01;
      if (price <= stop || fade || rev || pos.hold >= maxHold) {
        const exitPrice = price <= stop ? stop : price;
        const prevCash = cash;
        cash = closePos(pos, exitPrice, cash);
        if (cash > prevCash) wins++;
        pos = null; trades++;
        peakCash = Math.max(peakCash, cash);
        maxDrawdown = Math.max(maxDrawdown, peakCash > 0 ? (peakCash - cash) / peakCash : 0);
      } else { pos.hold++; }
    } else {
      if (avgVol === null) continue;
      const prevBody = ind.bodies[i - 1]; const prevTop = ind.topRatio[i - 1];
      const prevVol  = candles[i - 1].volume / avgVol;
      let calm = true;
      for (let k = 2; k <= 4; k++) {
        if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
      }
      const prev5Close  = candles[Math.max(0, i - 7)].close;
      const prev2Close  = candles[i - 2].close;
      const prevPreRoc5 = prev5Close > 0 ? Math.abs((prev2Close - prev5Close) / prev5Close) : 0;
      const prevExploded = calm && prevBody >= 0.025 && prevTop >= 0.60 && prevVol >= 3.5 && prevPreRoc5 < 0.05;
      const curVol = candles[i].volume / avgVol;
      if (prevExploded && curVol >= confirmVolMin && ind.bodies[i] >= 0 && candles[i].close >= candles[i - 1].close) {
        pos = openPos(price);
      }
    }
  }
  if (pos) {
    const prevCash = cash;
    cash = closePos(pos, candles.at(-1)!.close, cash);
    if (cash > prevCash) wins++;
    trades++;
  }
  return { returnRate: cash - 1, trades, maxDrawdown, winRate: trades > 0 ? wins / trades : 0 };
}

// ─── Strategy D: Spike Retracement Entry ──────────────────────────────────────
// 스파이크 발생 후 3~10% 눌림목에서 거래량이 아직 뜨거울 때 재진입하여 2차 상승 노림
const D_SPIKE_WIN    = 30;   // 최근 N봉 내 스파이크 탐색
const D_RETRACE_MAX  = 0.10; // 스파이크 고점 대비 10% 초과 하락 시 패턴 무효
const D_CONFIRM_VOL  = 1.5;  // 눌림목 진입 시 최소 거래량 배수
const D_SPIKE_BODY   = 0.025;
const D_SPIKE_VOL    = 2.5; // 리트레이스 탐지용 — 진입은 리트레이스 조건이 추가 필터링

function backtestDRetrace(
  candles: Candle[], ind: Ind,
  p: { trailingStopPct: number; maxHoldCandles: number; retracePctMin: number },
): BtResult {
  const { trailingStopPct: trail, maxHoldCandles: maxHold, retracePctMin } = p;
  let cash = 1.0; let pos: Pos | null = null;
  let trades = 0; let wins = 0;
  let peakCash = 1.0; let maxDrawdown = 0;

  for (let i = 52; i < candles.length; i++) {
    const price  = candles[i].close;
    const avgVol = ind.avgVol48[i];
    if (pos) {
      pos.high = Math.max(pos.high, candles[i].high);
      const stop = pos.high * (1 - trail);
      const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
      if (price <= stop || fade || pos.hold >= maxHold) {
        const exitPrice = price <= stop ? stop : price;
        const prevCash = cash;
        cash = closePos(pos, exitPrice, cash);
        if (cash > prevCash) wins++;
        pos = null; trades++;
        peakCash = Math.max(peakCash, cash);
        maxDrawdown = Math.max(maxDrawdown, peakCash > 0 ? (peakCash - cash) / peakCash : 0);
      } else { pos.hold++; }
    } else {
      if (avgVol === null) continue;
      // 최근 스파이크 탐색
      let spikeIdx = -1;
      for (let k = 1; k <= Math.min(D_SPIKE_WIN, i - 1); k++) {
        const j = i - k;
        const body = ind.bodies[j];
        if (body >= D_SPIKE_BODY && candles[j].volume / avgVol >= D_SPIKE_VOL && candles[j].close > candles[j].open) {
          spikeIdx = j; break;
        }
      }
      if (spikeIdx < 0) continue;
      // 스파이크 이후 최고점
      const spikeHigh = candles.slice(spikeIdx, Math.min(spikeIdx + 4, i))
        .reduce((m, c) => (c.high > m ? c.high : m), 0);
      if (spikeHigh <= 0) continue;
      // 눌림목 확인
      const retrace = (spikeHigh - price) / spikeHigh;
      if (retrace < retracePctMin || retrace > D_RETRACE_MAX) continue;
      // 거래량 여전히 뜨거움 + 회복 양봉
      const curVol = candles[i].volume / avgVol;
      if (curVol >= D_CONFIRM_VOL && candles[i].close > candles[i].open) {
        pos = openPos(price);
      }
    }
  }
  if (pos) {
    const prevCash = cash;
    cash = closePos(pos, candles.at(-1)!.close, cash);
    if (cash > prevCash) wins++;
    trades++;
  }
  return { returnRate: cash - 1, trades, maxDrawdown, winRate: trades > 0 ? wins / trades : 0 };
}

// ─── Grid definitions ─────────────────────────────────────────────────────────
const TRAILS    = [0.008, 0.012, 0.016, 0.020, 0.025, 0.030, 0.040];
const MAX_HOLDS = [4, 6, 8, 10, 12, 16, 20];
const BODY_MINS_A = [0.010, 0.012, 0.015, 0.018, 0.022];
const BODY_MINS_B = [0.015, 0.018, 0.020, 0.025, 0.030];
const CONF_VOL_C  = [1.2, 1.5, 1.8, 2.0, 2.5];
const RETRACE_MIN_D = [0.020, 0.030, 0.040, 0.050]; // D: 눌림목 최소 비율

// Require at least 1 completed trade to accept an optimization result.
// Anomaly markets are low-frequency; setting MIN_TRADES=2 excludes too many markets.
const MIN_TRADES = 1;

function bestCombo<P extends object>(
  candles: Candle[], ind: Ind, combos: P[],
  backtest: (c: Candle[], ind: Ind, p: P) => BtResult,
  defaults: P,
): { params: P; result: BtResult } {
  let bestReturn = -Infinity; let bestP = defaults;
  let bestR: BtResult = { returnRate: 0, trades: 0, maxDrawdown: 0, winRate: 0 };
  for (const p of combos) {
    const r = backtest(candles, ind, p);
    if (r.trades >= MIN_TRADES && r.returnRate > bestReturn) {
      bestReturn = r.returnRate; bestP = p; bestR = r;
    }
  }
  if (bestReturn === -Infinity) { bestP = defaults; bestR = { returnRate: 0, trades: 0, maxDrawdown: 0, winRate: 0 }; }
  return { params: bestP, result: bestR };
}

// ─── main ─────────────────────────────────────────────────────────────────────
export async function runOptimization(
  live1m:          Record<string, Candle[]>,
  yesterdayStart:  number,
  yesterdayEnd:    number,
  marketNames:     string[],
  date:            string,
): Promise<OptimizedParamsResult> {
  const t0 = Date.now();
  console.log(`\n  [opt] Running per-coin parameter optimization for ${marketNames.length} markets…`);

  // Pre-build all combos (same set for every market)
  const combosA = TRAILS.flatMap(t => MAX_HOLDS.flatMap(h => BODY_MINS_A.map(b =>
    ({ trailingStopPct: t, maxHoldCandles: h, curBodyMin: b }))));
  const combosB = TRAILS.flatMap(t => MAX_HOLDS.flatMap(h => BODY_MINS_B.map(b =>
    ({ trailingStopPct: t, maxHoldCandles: h, bodyMin: b }))));
  const combosC = TRAILS.flatMap(t => MAX_HOLDS.flatMap(h => CONF_VOL_C.map(v =>
    ({ trailingStopPct: t, maxHoldCandles: h, confirmVolMin: v }))));
  const combosD = TRAILS.flatMap(t => MAX_HOLDS.flatMap(h => RETRACE_MIN_D.map(r =>
    ({ trailingStopPct: t, maxHoldCandles: h, retracePctMin: r }))));

  const totalCombos = (combosA.length + combosB.length + combosC.length + combosD.length) * marketNames.length;
  console.log(`  [opt] ${combosA.length + combosB.length + combosC.length + combosD.length} combos/market × ${marketNames.length} markets = ${totalCombos} backtests`);

  const params: OptimizedParams = {};

  for (const market of marketNames) {
    const allCandles = live1m[market] ?? [];
    const candles    = allCandles.filter(c => c.timestamp >= yesterdayStart && c.timestamp < yesterdayEnd);
    if (candles.length < 60) {
      console.log(`  [opt] ${market.replace("KRW-", "").padEnd(10)} skip (only ${candles.length} candles)`);
      continue;
    }

    const ind = computeInd(candles);

    const { params: pA, result: rA } = bestCombo(candles, ind, combosA, backtestA,
      { trailingStopPct: 0.028, maxHoldCandles: 12, curBodyMin:     0.015 });
    const { params: pB, result: rB } = bestCombo(candles, ind, combosB, backtestB,
      { trailingStopPct: 0.018, maxHoldCandles: 6,  bodyMin:        0.025 });
    const { params: pC, result: rC } = bestCombo(candles, ind, combosC, backtestC,
      { trailingStopPct: 0.022, maxHoldCandles: 8,  confirmVolMin:  1.8   });
    const { params: pD, result: rD } = bestCombo(candles, ind, combosD, backtestDRetrace,
      { trailingStopPct: 0.022, maxHoldCandles: 12, retracePctMin: 0.030 });

    const tag = (r: BtResult) => `${(r.returnRate * 100).toFixed(1)}%(${r.trades}t,dd${(r.maxDrawdown * 100).toFixed(1)}%)`;
    console.log(`  [opt] ${market.replace("KRW-", "").padEnd(10)} A:${tag(rA)}  B:${tag(rB)}  C:${tag(rC)}  D:${tag(rD)}`);

    params[market] = {
      "momentum":   { ...pA, trades: rA.trades, returnRate: rA.returnRate, maxDrawdown: rA.maxDrawdown, winRate: rA.winRate },
      "range-grid": { ...pB, trades: rB.trades, returnRate: rB.returnRate, maxDrawdown: rB.maxDrawdown, winRate: rB.winRate },
      "arbitrage":  { ...pC, trades: rC.trades, returnRate: rC.returnRate, maxDrawdown: rC.maxDrawdown, winRate: rC.winRate },
      "anomaly":    { ...pD, trades: rD.trades, returnRate: rD.returnRate, maxDrawdown: rD.maxDrawdown, winRate: rD.winRate },
    };
  }

  const durationMs = Date.now() - t0;
  console.log(`  [opt] Done in ${(durationMs / 1000).toFixed(1)}s`);

  return { date, optimizedAt: new Date().toISOString(), durationMs, totalCombos, params };
}
