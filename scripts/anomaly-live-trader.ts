/**
 * anomaly-live-trader.ts — Anomaly 전략 실매매 실행기
 *
 * 설정 (.env):
 *   UPBIT_ACCESS_KEY=<key>
 *   UPBIT_SECRET_KEY=<secret>
 *   LIVE_TRADING_ENABLED=true        (실제 주문을 보내려면 반드시 필요)
 *   LIVE_BUDGET=5000000              (총 운용금액, 기본 5,000,000원)
 *   LIVE_MAX_POSITIONS=9             (최대 동시 포지션 수, 기본 9)
 *   MAX_DAILY_LOSS_KRW=500000        (일일 최대 손실, 기본 total*10%)
 *
 * 실행:
 *   node scripts/anomaly-live-trader.mjs --dry-run   (주문 없이 신호만 로그)
 *   node scripts/anomaly-live-trader.mjs             (실제 주문)
 *
 * 전략 선택:
 *   public/market/dashboard-results.json 의 optimizationPlansByGuideMode.ignored 에서
 *   평균 returnRate가 가장 높은 전략(A/B/C/D)을 자동 선택합니다.
 *
 * 자금 배분:
 *   LIVE_BUDGET ÷ LIVE_MAX_POSITIONS = 코인당 예산
 *   매수금액 = 코인당 예산 × 0.95 (5% 수수료·슬리피지 여유)
 */

import WebSocket from "ws";
import { access, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { cancelOrder, getAccounts, getKrwBalance, getOrder, placeMarketBuy, placeMarketSell } from "./upbitOrder";
import { sma, rateOfChange } from "../src/indicators/technical";
import { anomalyStrategy, anomalyScenario } from "../src/strategies/anomaly";
import type { Candle, StrategyContext, StrategyDecision, StrategyScenario, TraderId } from "../src/types/trading";
import type { OptimizedParams } from "./optimize-params";

// ── 환경 변수 ─────────────────────────────────────────────────────────────────
// dotenv 없이 Node.js 내장 env 사용. 실행 전 .env 파일을 --env-file 플래그로 로드:
//   node --env-file=.env scripts/anomaly-live-trader.mjs

const ACCESS_KEY    = process.env.UPBIT_ACCESS_KEY ?? "";
const SECRET_KEY    = process.env.UPBIT_SECRET_KEY ?? "";
const LIVE_ENABLED  = process.env.LIVE_TRADING_ENABLED === "true";
const DRY_RUN       = process.argv.includes("--dry-run") || !ACCESS_KEY || !SECRET_KEY || !LIVE_ENABLED;

const TOTAL_BUDGET      = Number(process.env.LIVE_BUDGET            ?? 5_000_000);
const MAX_POSITIONS     = Number(process.env.LIVE_MAX_POSITIONS      ?? 9);
const BUDGET_PER_COIN   = Math.floor(TOTAL_BUDGET / MAX_POSITIONS);
const ORDER_AMOUNT      = Math.floor(BUDGET_PER_COIN * 0.95);   // 5% 슬리피지·수수료 여유
const MIN_ORDER_KRW     = 5_500;
const MAX_DAILY_LOSS_KRW = Number(process.env.MAX_DAILY_LOSS_KRW ?? Math.floor(TOTAL_BUDGET * 0.10));
const MAX_CANDLES       = 1_500;

// ── 경로 ─────────────────────────────────────────────────────────────────────
const root              = process.cwd();
const selectionPath     = path.join(root, "public", "market", "anomaly-selection.json");
const dashboardPath     = path.join(root, "public", "market", "dashboard-results.json");
const optimizedPath     = path.join(root, "public", "market", "anomaly-optimized-params.json");
const daily1mPath       = path.join(root, "public", "market", "upbit-krw-1m-daily.json");
const statePath         = path.join(root, "data", "local", "anomaly-live-trader-state.json");
const publicStatusPath  = path.join(root, "public", "market", "anomaly-live-trade-status.json");
const lockPath          = path.join(root, "data", "local", "anomaly-live-trader.lock");
const emergencyStopPath = path.join(root, "data", "local", "live-trading-disabled.flag");
const freezeAllPath     = path.join(root, "data", "local", "live-trading-freeze-all.flag");

// ── 상태 타입 ─────────────────────────────────────────────────────────────────
interface LivePosition {
  market:       string;
  quantity:     string;      // 코인 수량
  avgBuyPrice:  number;      // 평균 매입가 (KRW)
  entryAt:      string;      // ISO timestamp
  orderUuid:    string;
  highestPrice: number;      // trailing stop 계산용 최고가
}

interface LiveTradeLog {
  at:          string;
  market:      string;
  side:        "buy" | "sell";
  amount:      number;       // KRW (buy) | 코인 수량 (sell)
  price:       number;       // 추정 체결가
  actualPrice?: number;
  netKrw?:     number;
  pnlKrw?:     number;
  dryRun:      boolean;
  reasonCodes: string[];
}

interface PendingBuy {
  uuid:        string;
  market:      string;
  amount:      number;
  price:       number;
  reasonCodes: string[];
  at:          string;
}

interface PendingSell {
  uuid:        string;
  market:      string;
  quantity:    string;
  price:       number;
  reasonCodes: string[];
  at:          string;
  costBasis:   number;
}

interface LiveState {
  startedAt:    string;
  strategyId:   TraderId;
  strategyName: string;
  totalBudget:  number;
  positions:    Record<string, LivePosition>;
  trades:       LiveTradeLog[];
  lastSellAt:   Record<string, number>;     // market → candle timestamp
  pendingBuys?:  Record<string, PendingBuy>;
  pendingSells?: Record<string, PendingSell>;
  startBalance?: number;
}

// ── WebSocket 타입 ────────────────────────────────────────────────────────────
interface UpbitTick {
  type:            string;
  code:            string;
  trade_price:     number;
  trade_volume:    number;
  trade_timestamp: number;
}

interface LiveCandle {
  market: string; timestamp: number;
  open: number; high: number; low: number; close: number;
  volume: number; quoteVolume: number;
}

// ── 런타임 상태 ───────────────────────────────────────────────────────────────
let selectedMarkets: string[] = [];
let perCoinParams:   OptimizedParams = {};
let activeStrategy:  TraderId = "anomaly";
let activeStrategyName = "";
let state: LiveState;

const closedCandles: Record<string, Candle[]> = {};
const liveCandle:    Record<string, LiveCandle> = {};
const lastMinute:    Record<string, number> = {};
const orderInProgress = new Set<string>();

let saveChain: Promise<void> = Promise.resolve();
let activeWs:  WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lockHandle: Awaited<ReturnType<typeof open>> | null = null;
let statusPublishingEnabled = false;
let statusSequence = 0;
const writerRunId = `${process.pid}-${Date.now()}`;

// ── 지표 캐시 ─────────────────────────────────────────────────────────────────
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

// ── 전략 decide 함수 ─────────────────────────────────────────────────────────
function decideA(candles: Candle[], i: number, position: LivePosition | null, scenario: StrategyScenario): StrategyDecision {
  const coinP = perCoinParams[candles[0]?.market ?? ""]?.["momentum"];
  const trail   = coinP?.trailingStopPct ?? scenario.params.trailingStopPct ?? 0.028;
  const maxHold = coinP?.maxHoldCandles  ?? scenario.params.maxHoldCandles  ?? 12;
  const curBodyMin = coinP?.curBodyMin ?? 0.015;
  const ind = getInd(candles);
  if (i < 52) return { action: "hold", confidence: 0, reasonCodes: ["warming-up"], targetWeight: 0 };
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
    const holdBars = Math.floor((Date.now() - new Date(position.entryAt).getTime()) / 60_000);
    if (fade || holdBars >= maxHold) return { action: "sell", confidence: 0.8, reasonCodes: [fade ? "volume-fade" : "time-stop"], targetWeight: 0 };
    // Trailing stop check
    if (position.highestPrice > 0 && candles[i].close < position.highestPrice * (1 - trail))
      return { action: "sell", confidence: 0.8, reasonCodes: ["trailing-stop"], targetWeight: 0 };
    return { action: "hold", confidence: 0, reasonCodes: ["holding"], targetWeight: 0 };
  }
  const avgVol = ind.avgVol48[i]; const roc48 = ind.roc48[i];
  if (avgVol === null || roc48 === null) return { action: "hold", confidence: 0, reasonCodes: ["no-data"], targetWeight: 0 };
  const recentBodies = ind.bodies.slice(i - 15, i).map(Math.abs);
  const avgBody = recentBodies.reduce((s, v) => s + v, 0) / 15;
  const curBody = ind.bodies[i];
  if (avgBody < 0.005 && curBody >= curBodyMin && candles[i].close > candles[i].open
    && candles[i].volume / avgVol >= 1.5 && Math.abs(roc48) < 0.05)
    return { action: "buy", confidence: 0.72, reasonCodes: ["calm-impulse"], targetWeight: 0.95,
      stopLossPct: 0.018, takeProfitPct: 0.06, trailingStopPct: trail, maxHoldCandles: maxHold };
  return { action: "hold", confidence: 0, reasonCodes: ["no-signal"], targetWeight: 0 };
}

function decideB(candles: Candle[], i: number, position: LivePosition | null, scenario: StrategyScenario): StrategyDecision {
  const coinP = perCoinParams[candles[0]?.market ?? ""]?.["range-grid"];
  const trail   = coinP?.trailingStopPct ?? scenario.params.trailingStopPct ?? 0.018;
  const maxHold = coinP?.maxHoldCandles  ?? scenario.params.maxHoldCandles  ?? 6;
  const bodyMin = coinP?.bodyMin ?? 0.025;
  const ind = getInd(candles);
  if (i < 52) return { action: "hold", confidence: 0, reasonCodes: ["warming-up"], targetWeight: 0 };
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.3;
    const rev  = ind.bodies[i] < -0.008;
    const holdBars = Math.floor((Date.now() - new Date(position.entryAt).getTime()) / 60_000);
    if (fade || rev || holdBars >= maxHold)
      return { action: "sell", confidence: 0.8, reasonCodes: [fade ? "volume-fade" : rev ? "reversal" : "time-stop"], targetWeight: 0 };
    if (position.highestPrice > 0 && candles[i].close < position.highestPrice * (1 - trail))
      return { action: "sell", confidence: 0.8, reasonCodes: ["trailing-stop"], targetWeight: 0 };
    return { action: "hold", confidence: 0, reasonCodes: ["holding"], targetWeight: 0 };
  }
  const avgVol = ind.avgVol48[i];
  if (avgVol === null) return { action: "hold", confidence: 0, reasonCodes: ["no-data"], targetWeight: 0 };
  let calm = true;
  for (let k = 1; k <= 3; k++) {
    if (Math.abs(ind.bodies[i - k]) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
  }
  const pre5Close = candles[Math.max(0, i - 6)].close;
  const pre1Close = candles[i - 1].close;
  const preRoc5   = pre5Close > 0 ? Math.abs((pre1Close - pre5Close) / pre5Close) : 0;
  const body = ind.bodies[i]; const volR = candles[i].volume / avgVol; const topR = ind.topRatio[i];
  if (calm && body >= bodyMin && volR >= 3.5 && topR >= 0.60 && preRoc5 < 0.05)
    return { action: "buy", confidence: 0.72, reasonCodes: ["explosion-candle", `vol×${volR.toFixed(1)}`], targetWeight: 0.95,
      stopLossPct: 0.015, trailingStopPct: trail, maxHoldCandles: maxHold };
  return { action: "hold", confidence: 0, reasonCodes: ["no-signal"], targetWeight: 0 };
}

function decideC(candles: Candle[], i: number, position: LivePosition | null, scenario: StrategyScenario): StrategyDecision {
  const coinP = perCoinParams[candles[0]?.market ?? ""]?.["arbitrage"];
  const trail   = coinP?.trailingStopPct  ?? scenario.params.trailingStopPct ?? 0.022;
  const maxHold = coinP?.maxHoldCandles   ?? scenario.params.maxHoldCandles  ?? 8;
  const confirmVolMin = coinP?.confirmVolMin ?? 1.8;
  const ind = getInd(candles);
  if (i < 53) return { action: "hold", confidence: 0, reasonCodes: ["warming-up"], targetWeight: 0 };
  if (position) {
    const avgVol = ind.avgVol48[i];
    const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
    const rev  = ind.bodies[i] < -0.01;
    const holdBars = Math.floor((Date.now() - new Date(position.entryAt).getTime()) / 60_000);
    if (fade || rev || holdBars >= maxHold)
      return { action: "sell", confidence: 0.8, reasonCodes: [fade ? "volume-fade" : rev ? "reversal" : "time-stop"], targetWeight: 0 };
    if (position.highestPrice > 0 && candles[i].close < position.highestPrice * (1 - trail))
      return { action: "sell", confidence: 0.8, reasonCodes: ["trailing-stop"], targetWeight: 0 };
    return { action: "hold", confidence: 0, reasonCodes: ["holding"], targetWeight: 0 };
  }
  const avgVol = ind.avgVol48[i];
  if (avgVol === null) return { action: "hold", confidence: 0, reasonCodes: ["no-data"], targetWeight: 0 };
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
  if (prevExploded && curVol >= confirmVolMin && ind.bodies[i] >= 0 && candles[i].close >= candles[i - 1].close)
    return { action: "buy", confidence: 0.72, reasonCodes: ["confirmed-burst", `cur×${curVol.toFixed(1)}`], targetWeight: 0.95,
      stopLossPct: 0.018, trailingStopPct: trail, maxHoldCandles: maxHold };
  return { action: "hold", confidence: 0, reasonCodes: ["no-confirm"], targetWeight: 0 };
}

function decideD(candles: Candle[], i: number, position: LivePosition | null): StrategyDecision {
  const market = candles[0]?.market ?? "";
  const coinP = perCoinParams[market]?.["anomaly"];
  const sc: StrategyScenario = coinP ? {
    ...anomalyScenario,
    params: {
      ...anomalyScenario.params,
      trailingStopPct:  coinP.trailingStopPct,
      maxHoldCandles:   coinP.maxHoldCandles,
      accelerationMin:  coinP.accelerationMin ?? 0.020,
      maxExtendedMove:  0.25,
    },
  } : anomalyScenario;

  const pos = position ? {
    market, averagePrice: position.avgBuyPrice, quantity: parseFloat(position.quantity),
    openedAt: new Date(position.entryAt).getTime(),
    highestPrice: position.highestPrice || position.avgBuyPrice,
    holdCandles: Math.floor((Date.now() - new Date(position.entryAt).getTime()) / 60_000),
  } : null;

  const ctx: StrategyContext = {
    market, candles, candleIndex: i, position: pos,
    portfolioValue: 0, lastSellPrice: undefined,
  };
  return anomalyStrategy.decide(ctx, sc);
}

type DecideFn = (candles: Candle[], i: number, position: LivePosition | null, scenario: StrategyScenario) => StrategyDecision;

const STRATEGY_DECIDES: Record<TraderId, DecideFn> = {
  "momentum":   (c, i, p, sc) => decideA(c, i, p, sc),
  "range-grid": (c, i, p, sc) => decideB(c, i, p, sc),
  "arbitrage":  (c, i, p, sc) => decideC(c, i, p, sc),
  "anomaly":    (c, i, p, _sc) => decideD(c, i, p),
};

const STRATEGY_SCENARIO: Record<TraderId, StrategyScenario> = {
  "momentum":   { id: "anomaly-a", traderId: "momentum",   name: "Calm Impulse",    description: "", params: { trailingStopPct: 0.028, maxHoldCandles: 12 } },
  "range-grid": { id: "anomaly-b", traderId: "range-grid", name: "First Explosion",  description: "", params: { trailingStopPct: 0.018, maxHoldCandles: 6  } },
  "arbitrage":  { id: "anomaly-c", traderId: "arbitrage",  name: "Confirmed Burst",  description: "", params: { trailingStopPct: 0.022, maxHoldCandles: 8  } },
  "anomaly":    anomalyScenario,
};

// ── 전략 선택 (backtracking 결과 기반) ────────────────────────────────────────
async function selectBestStrategy(): Promise<{ id: TraderId; name: string }> {
  const SLOT_MAP: Record<string, TraderId> = {
    "momentum": "momentum", "range-grid": "range-grid", "arbitrage": "arbitrage", "anomaly": "anomaly",
  };
  try {
    const dash = JSON.parse(await readFile(dashboardPath, "utf8")) as any;
    const plans: any[] = dash?.optimizationPlansByGuideMode?.ignored ?? [];
    const scores: Record<TraderId, number> = { momentum: 0, "range-grid": 0, arbitrage: 0, anomaly: 0 };
    const counts: Record<TraderId, number> = { momentum: 0, "range-grid": 0, arbitrage: 0, anomaly: 0 };
    for (const plan of plans) {
      const sid: TraderId = SLOT_MAP[plan.strategyId] ?? plan.strategyId;
      if (!scores[sid] !== undefined) continue;
      for (const m of plan.optimizedMarkets ?? []) {
        const rr = m?.bestResult?.returnRate;
        if (typeof rr === "number" && Number.isFinite(rr)) {
          scores[sid] += rr;
          counts[sid] += 1;
        }
      }
    }
    let best: TraderId = "anomaly";
    let bestAvg = -Infinity;
    for (const [sid, total] of Object.entries(scores) as [TraderId, number][]) {
      const avg = counts[sid] > 0 ? total / counts[sid] : -Infinity;
      if (avg > bestAvg) { bestAvg = avg; best = sid; }
    }
    const nameMap: Record<TraderId, string> = {
      "momentum": "Anomaly-A (Calm Impulse)", "range-grid": "Anomaly-B (First Explosion)",
      "arbitrage": "Anomaly-C (Confirmed Burst)", "anomaly": "Anomaly-D (Sweep Best)",
    };
    console.log(`[live-trader] 전략 선택:`);
    for (const [sid, total] of Object.entries(scores) as [TraderId, number][]) {
      const avg = counts[sid] > 0 ? total / counts[sid] : 0;
      const mark = sid === best ? " ← 선택" : "";
      console.log(`  ${nameMap[sid as TraderId].padEnd(36)} avg returnRate=${(avg * 100).toFixed(2)}% (${counts[sid]}개 마켓)${mark}`);
    }
    return { id: best, name: nameMap[best] };
  } catch (e) {
    console.warn(`[live-trader] dashboard-results 없음, Anomaly-D 기본 사용: ${String(e).slice(0, 80)}`);
    return { id: "anomaly", name: "Anomaly-D (Sweep Best)" };
  }
}

// ── 초기화 ───────────────────────────────────────────────────────────────────
async function init() {
  await acquireProcessLock();

  if (DRY_RUN) {
    console.log("[live-trader] ⚠️  DRY RUN 모드 — 실제 주문 없음");
    if (!ACCESS_KEY)   console.log("  이유: UPBIT_ACCESS_KEY 미설정");
    else if (!SECRET_KEY) console.log("  이유: UPBIT_SECRET_KEY 미설정");
    else if (!LIVE_ENABLED) console.log("  이유: LIVE_TRADING_ENABLED=true 미설정");
  } else {
    console.log("[live-trader] 🔴 실매매 모드");
  }

  // 전략 선택
  const best = await selectBestStrategy();
  activeStrategy = best.id;
  activeStrategyName = best.name;

  // 코인 선택 (anomaly-selection.json)
  const selection = JSON.parse(await readFile(selectionPath, "utf8")) as any;
  selectedMarkets = Array.isArray(selection.markets)
    ? selection.markets.map((m: any) => m.market).filter((m: unknown) => typeof m === "string")
    : Array.isArray(selection.candidateMarkets)
      ? selection.candidateMarkets.slice(0, 9)
      : [];
  if (selectedMarkets.length === 0) throw new Error("anomaly-selection.json에 markets가 없습니다.");

  // per-coin 파라미터 로드
  const optFile = JSON.parse(await readFile(optimizedPath, "utf8")) as any;
  perCoinParams = optFile?.params ?? {};

  console.log(`[live-trader] 전략: ${activeStrategyName}`);
  console.log(`[live-trader] 대상 코인 (${selectedMarkets.length}개): ${selectedMarkets.map(m => m.replace("KRW-", "")).join(", ")}`);
  console.log(`[live-trader] 총 예산: ${TOTAL_BUDGET.toLocaleString()}원 | 코인당: ${BUDGET_PER_COIN.toLocaleString()}원 | 1회 매수: ${ORDER_AMOUNT.toLocaleString()}원`);

  // 캔들 히스토리 로드
  await loadCandleHistory();

  // 상태 로드
  state = await loadState();

  // 실매매 모드: 업비트 잔고 동기화
  if (!DRY_RUN) {
    await syncPositionsFromUpbit();
    await reconcilePending();
  }

  const startBal = await computeBalance();
  if (!state.startBalance) {
    state.startBalance = startBal.totalValue;
    await saveState(state);
  }
  statusPublishingEnabled = true;
  console.log(`[live-trader] 시작 잔고: ${Math.floor(state.startBalance).toLocaleString()}원 | 포지션: ${Object.keys(state.positions).length}개`);

  await writePublicStatus();
  connect();
}

async function loadCandleHistory() {
  try {
    const cache = JSON.parse(await readFile(daily1mPath, "utf8")) as any;
    for (const market of selectedMarkets) {
      closedCandles[market] = (cache.candlesByMarket?.[market] ?? []).slice(-MAX_CANDLES);
    }
    console.log("[live-trader] 캔들 히스토리 로드 완료");
  } catch {
    for (const market of selectedMarkets) closedCandles[market] = [];
    console.warn("[live-trader] 캔들 히스토리 없음 — 워밍업 필요 (최소 60분 소요)");
  }
}

async function loadState(): Promise<LiveState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as LiveState;
  } catch {
    const fresh: LiveState = {
      startedAt: new Date().toISOString(),
      strategyId: activeStrategy,
      strategyName: activeStrategyName,
      totalBudget: TOTAL_BUDGET,
      positions: {}, trades: [], lastSellAt: {},
    };
    await saveState(fresh);
    return fresh;
  }
}

async function saveState(s: LiveState): Promise<void> {
  const snapshot = JSON.stringify(s, null, 2);
  await (saveChain = saveChain.catch(() => {}).then(async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, statePath);
    await writePublicStatus();
  }));
}

// ── 잔고 ─────────────────────────────────────────────────────────────────────
async function computeBalance() {
  if (DRY_RUN) {
    const invested = Object.values(state.positions)
      .reduce((s, p) => s + parseFloat(p.quantity) * p.avgBuyPrice, 0);
    const coinValue = Object.values(state.positions)
      .reduce((s, p) => s + parseFloat(p.quantity) * getLatestPrice(p.market, p.avgBuyPrice), 0);
    return { krwCash: Math.max(0, TOTAL_BUDGET - invested), invested, coinValue, totalValue: Math.max(0, TOTAL_BUDGET - invested) + coinValue };
  }
  try {
    const accounts = await getAccounts(ACCESS_KEY, SECRET_KEY);
    const krw = accounts.find(a => a.currency === "KRW");
    const krwCash = krw ? parseFloat(krw.balance) + parseFloat(krw.locked) : 0;
    const coinValue = Object.values(state.positions)
      .reduce((s, p) => s + parseFloat(p.quantity) * getLatestPrice(p.market, p.avgBuyPrice), 0);
    return { krwCash, invested: 0, coinValue, totalValue: krwCash + coinValue };
  } catch {
    return { krwCash: 0, invested: 0, coinValue: 0, totalValue: 0 };
  }
}

function getLatestPrice(market: string, fallback: number): number {
  return liveCandle[market]?.close
    ?? closedCandles[market]?.at(-1)?.close
    ?? fallback;
}

async function syncPositionsFromUpbit() {
  try {
    const accounts = await getAccounts(ACCESS_KEY, SECRET_KEY);
    for (const market of selectedMarkets) {
      const currency = market.replace("KRW-", "");
      const account = accounts.find(a => a.currency === currency);
      if (account && parseFloat(account.balance) > 0) {
        const existing = state.positions[market];
        state.positions[market] = {
          market, quantity: account.balance,
          avgBuyPrice: parseFloat(account.avg_buy_price),
          entryAt: existing?.entryAt ?? new Date().toISOString(),
          orderUuid: existing?.orderUuid ?? "synced-from-upbit",
          highestPrice: existing?.highestPrice ?? parseFloat(account.avg_buy_price),
        };
      }
    }
    await saveState(state);
    console.log("[live-trader] 포지션 동기화 완료");
  } catch (e) {
    console.error("[live-trader] 잔고 동기화 실패:", e);
  }
}

async function reconcilePending() {
  const buys = state.pendingBuys ?? {};
  for (const [uuid, pb] of Object.entries(buys)) {
    try {
      const order = await getOrder(ACCESS_KEY, SECRET_KEY, uuid);
      const vol = parseFloat(order.executed_volume ?? "0");
      if (vol > 0) {
        state.positions[pb.market] = {
          market: pb.market, quantity: String(vol),
          avgBuyPrice: order.avg_price ? parseFloat(order.avg_price) : pb.price,
          entryAt: pb.at, orderUuid: uuid,
          highestPrice: order.avg_price ? parseFloat(order.avg_price) : pb.price,
        };
      }
      delete buys[uuid];
    } catch { /* skip */ }
  }
  const sells = state.pendingSells ?? {};
  for (const [uuid, ps] of Object.entries(sells)) {
    try {
      const order = await getOrder(ACCESS_KEY, SECRET_KEY, uuid);
      if (order.state === "done") {
        delete state.positions[ps.market];
        delete sells[uuid];
      }
    } catch { /* skip */ }
  }
  await saveState(state);
}

// ── 비상 정지 ─────────────────────────────────────────────────────────────────
async function isEntryBlocked() {
  try { await access(emergencyStopPath); return true; } catch {}
  try { await access(freezeAllPath); return true; } catch { return false; }
}
async function isAllBlocked() {
  try { await access(freezeAllPath); return true; } catch { return false; }
}

// ── 공개 상태 파일 ────────────────────────────────────────────────────────────
async function writePublicStatus() {
  if (!statusPublishingEnabled) return;
  const balance = await computeBalance().catch(() => ({ krwCash: 0, invested: 0, coinValue: 0, totalValue: 0 }));
  const payload = {
    schemaVersion: 1, writerPid: process.pid, writerRunId,
    sequence: ++statusSequence,
    updatedAt: new Date().toISOString(),
    mode: DRY_RUN ? "dry-run" : "live",
    strategyId: activeStrategy, strategyName: activeStrategyName,
    totalBudget: TOTAL_BUDGET, budgetPerCoin: BUDGET_PER_COIN, orderAmount: ORDER_AMOUNT,
    selectedMarkets, positions: state?.positions ?? {}, trades: state?.trades ?? [],
    balance, startBalance: state?.startBalance,
  };
  try {
    await mkdir(path.dirname(publicStatusPath), { recursive: true });
    const tmp = `${publicStatusPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, publicStatusPath);
  } catch { /* ignore */ }
}

// ── Process lock ──────────────────────────────────────────────────────────────
async function acquireProcessLock() {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lockHandle = await open(lockPath, "wx");
      await lockHandle.writeFile(JSON.stringify({ pid: process.pid, writerRunId, startedAt: new Date().toISOString(), mode: DRY_RUN ? "dry-run" : "live" }), "utf8");
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let lock: any = null;
      try { lock = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
      if (lock?.pid && isProcessAlive(lock.pid)) throw new Error(`live-trader 이미 실행 중 (pid=${lock.pid})`);
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("anomaly-live-trader lock 획득 실패");
}
async function releaseProcessLock() {
  const h = lockHandle; lockHandle = null;
  if (!h) return;
  try { await h.close(); } catch {}
  try { const lock = JSON.parse(await readFile(lockPath, "utf8")); if (!lock?.pid || lock.pid === process.pid) await unlink(lockPath); } catch {}
}
function isProcessAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  if (activeWs && (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const ws = new WebSocket("wss://api.upbit.com/websocket/v1");
  activeWs = ws;

  ws.on("open", () => {
    ws.send(JSON.stringify([{ ticket: "anomaly-live-trader" }, { type: "trade", codes: selectedMarkets }]));
    console.log(`[live-trader] WebSocket 연결됨 (${selectedMarkets.length}개 구독)`);
  });
  ws.on("message", (data: Buffer) => {
    try { const tick = JSON.parse(data.toString("utf8")) as UpbitTick; if (tick.type === "trade") handleTick(tick); } catch {}
  });
  ws.on("close", () => {
    console.log("[live-trader] WebSocket 끊김. 5초 후 재연결...");
    if (activeWs === ws) activeWs = null;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5_000);
  });
  ws.on("error", (e: Error) => { console.error("[live-trader] WS 오류:", e.message); ws.terminate(); });
}

// ── 틱 처리 → 1m 캔들 빌드 ──────────────────────────────────────────────────
function handleTick(tick: UpbitTick) {
  const market = tick.code;
  const minuteTs = Math.floor(tick.trade_timestamp / 60_000) * 60_000;
  const prev = lastMinute[market];

  if (prev !== undefined && minuteTs > prev) {
    const closed = closeLiveCandle(market);
    if (closed) {
      upsertCandle(closedCandles[market] ??= [], closed);
      setTimeout(() => processMinuteClose(market, closed).catch(console.error), 1_500);
    }
    liveCandle[market] = newLiveCandle(market, tick, minuteTs);
  } else if (!liveCandle[market]) {
    liveCandle[market] = newLiveCandle(market, tick, minuteTs);
  } else {
    updateLiveCandle(liveCandle[market], tick);
  }
  lastMinute[market] = minuteTs;

  // 틱 레벨 trailing stop 체크 (분봉 마감 전 즉시 대응)
  checkTickTrailingStop(market, tick.trade_price);
}

function newLiveCandle(market: string, tick: UpbitTick, ts: number): LiveCandle {
  return { market, timestamp: ts, open: tick.trade_price, high: tick.trade_price, low: tick.trade_price, close: tick.trade_price, volume: tick.trade_volume, quoteVolume: tick.trade_price * tick.trade_volume };
}
function updateLiveCandle(c: LiveCandle, tick: UpbitTick) {
  c.close = tick.trade_price;
  if (tick.trade_price > c.high) c.high = tick.trade_price;
  if (tick.trade_price < c.low)  c.low  = tick.trade_price;
  c.volume += tick.trade_volume;
  c.quoteVolume += tick.trade_price * tick.trade_volume;
}
function closeLiveCandle(market: string): Candle | null {
  const c = liveCandle[market];
  if (!c) return null;
  return { market: c.market, timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, quoteVolume: c.quoteVolume };
}
function upsertCandle(arr: Candle[], candle: Candle) {
  const last = arr[arr.length - 1];
  if (last?.timestamp === candle.timestamp) arr[arr.length - 1] = candle;
  else { arr.push(candle); if (arr.length > MAX_CANDLES) arr.shift(); }
}

// ── 전략 실행 (분봉 마감 시) ──────────────────────────────────────────────────
async function processMinuteClose(market: string, _closed: Candle) {
  const candles = closedCandles[market];
  if (!candles || candles.length < 60) return; // 워밍업

  const position = state.positions[market] ?? null;
  const i = candles.length - 1;

  // 최고가 업데이트 (trailing stop 계산용)
  if (position) {
    const cur = candles[i].close;
    if (cur > position.highestPrice) {
      position.highestPrice = cur;
      state.positions[market] = position;
    }
  }

  const scenario = STRATEGY_SCENARIO[activeStrategy];
  const decideFn = STRATEGY_DECIDES[activeStrategy];
  const decision = decideFn(candles, i, position, scenario);

  if (decision.action === "buy" && !position) {
    await executeBuy(market, candles[i].close, decision.reasonCodes);
  } else if (decision.action === "sell" && position) {
    await executeSell(market, position, candles[i].close, decision.reasonCodes);
  }
}

// 틱 레벨 trailing stop 체크
function checkTickTrailingStop(market: string, tickPrice: number) {
  if (!state || orderInProgress.has(market)) return;
  const position = state.positions[market];
  if (!position) return;
  const coinP = perCoinParams[market]?.[activeStrategy];
  const sc = STRATEGY_SCENARIO[activeStrategy];
  const trail = coinP?.trailingStopPct ?? sc.params.trailingStopPct ?? 0;
  if (trail <= 0) return;
  const hp = position.highestPrice || position.avgBuyPrice;
  if (tickPrice <= hp * (1 - trail)) {
    executeSell(market, position, tickPrice, ["trailing-stop-tick"]).catch(console.error);
  }
}

// ── 일일 손실 집계 ────────────────────────────────────────────────────────────
function getDailyRealizedLoss(): number {
  const today = new Date().toISOString().slice(0, 10);
  return state.trades
    .filter(t => t.at.startsWith(today) && t.side === "sell" && !t.dryRun && (t.pnlKrw ?? 0) < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnlKrw ?? 0), 0);
}

// ── 주문 실행 ─────────────────────────────────────────────────────────────────
async function executeBuy(market: string, price: number, reasonCodes: string[]) {
  if (orderInProgress.has(market)) return;
  if (Object.values(state.pendingBuys ?? {}).some(pb => pb.market === market)) return;
  orderInProgress.add(market);

  try {
    const coin = market.replace("KRW-", "");
    const log = `[BUY] ${coin} ${ORDER_AMOUNT.toLocaleString()}원 @ ~${price.toLocaleString()}원 | ${reasonCodes.join(",")}`;
    if (ORDER_AMOUNT < MIN_ORDER_KRW) { console.log("[live-trader] 스킵 — 주문금액 부족"); return; }

    if (DRY_RUN) {
      console.log(`[dry-run] ${log}`);
      state.positions[market] = { market, quantity: String((ORDER_AMOUNT / price).toFixed(8)), avgBuyPrice: price, entryAt: new Date().toISOString(), orderUuid: "dry-run", highestPrice: price };
      state.trades.push({ at: new Date().toISOString(), market, side: "buy", amount: ORDER_AMOUNT, price, dryRun: true, reasonCodes });
      await saveState(state);
      return;
    }

    if (await isEntryBlocked()) { console.warn("[live-trader] 🛑 비상 정지 — 매수 차단"); return; }

    const openCount = Object.keys(state.positions).length + Object.keys(state.pendingBuys ?? {}).length;
    if (openCount >= MAX_POSITIONS) { console.log(`[live-trader] 스킵 — 최대 포지션 (${openCount}/${MAX_POSITIONS})`); return; }

    const invested = Object.values(state.positions).reduce((s, p) => s + parseFloat(p.quantity) * p.avgBuyPrice, 0);
    const pendingAmt = Object.values(state.pendingBuys ?? {}).reduce((s, p) => s + p.amount, 0);
    if (invested + pendingAmt + ORDER_AMOUNT > TOTAL_BUDGET) { console.log("[live-trader] 스킵 — 예산 초과"); return; }

    const krwAvail = await getKrwBalance(ACCESS_KEY, SECRET_KEY).catch(() => 0);
    if (krwAvail < ORDER_AMOUNT) { console.log(`[live-trader] 스킵 — KRW 잔고 부족 (${Math.floor(krwAvail).toLocaleString()}원)`); return; }

    if (getDailyRealizedLoss() >= MAX_DAILY_LOSS_KRW) { console.warn("[live-trader] 스킵 — 일일 손실 한도 도달"); return; }

    const order = await placeMarketBuy(ACCESS_KEY, SECRET_KEY, market, ORDER_AMOUNT);
    console.log(`[live-trader] ✅ ${log} → uuid=${order.uuid}`);

    await sleep(2_000);
    let filled = await getOrder(ACCESS_KEY, SECRET_KEY, order.uuid);
    if (filled.state !== "done") { await sleep(2_000); filled = await getOrder(ACCESS_KEY, SECRET_KEY, order.uuid); }

    if (filled.state !== "done") {
      state.pendingBuys = state.pendingBuys ?? {};
      state.pendingBuys[order.uuid] = { uuid: order.uuid, market, amount: ORDER_AMOUNT, price, reasonCodes, at: new Date().toISOString() };
      await saveState(state);
      return;
    }

    const vol = parseFloat(filled.executed_volume ?? "0");
    if (vol <= 0) return;
    const avgP = filled.avg_price ? parseFloat(filled.avg_price) : price;
    state.positions[market] = { market, quantity: String(vol), avgBuyPrice: avgP, entryAt: new Date().toISOString(), orderUuid: order.uuid, highestPrice: avgP };
    state.trades.push({ at: new Date().toISOString(), market, side: "buy", amount: ORDER_AMOUNT, price, actualPrice: avgP, netKrw: ORDER_AMOUNT, dryRun: false, reasonCodes });
    await saveState(state);
  } catch (e) {
    console.error(`[live-trader] ❌ 매수 실패 ${market}:`, e);
  } finally {
    orderInProgress.delete(market);
  }
}

async function executeSell(market: string, position: LivePosition, price: number, reasonCodes: string[]) {
  if (orderInProgress.has(market)) return;
  if (Object.values(state.pendingSells ?? {}).some(ps => ps.market === market)) return;
  orderInProgress.add(market);

  try {
    const coin = market.replace("KRW-", "");
    const log = `[SELL] ${coin} ${position.quantity}개 @ ~${price.toLocaleString()}원 | ${reasonCodes.join(",")}`;

    if (DRY_RUN) {
      console.log(`[dry-run] ${log}`);
      const qty = parseFloat(position.quantity);
      const netKrw = qty * price * (1 - 0.0005);
      const pnlKrw = netKrw - qty * position.avgBuyPrice;
      delete state.positions[market];
      state.trades.push({ at: new Date().toISOString(), market, side: "sell", amount: qty, price, netKrw, pnlKrw, dryRun: true, reasonCodes });
      await saveState(state);
      return;
    }

    if (await isAllBlocked()) { console.warn("[live-trader] 🛑 freeze-all — 매도 차단"); return; }

    const order = await placeMarketSell(ACCESS_KEY, SECRET_KEY, market, position.quantity);
    console.log(`[live-trader] ✅ ${log} → uuid=${order.uuid}`);

    await sleep(2_000);
    let filled = await getOrder(ACCESS_KEY, SECRET_KEY, order.uuid);
    if (filled.state !== "done") { await sleep(2_000); filled = await getOrder(ACCESS_KEY, SECRET_KEY, order.uuid); }

    if (filled.state !== "done") {
      state.pendingSells = state.pendingSells ?? {};
      state.pendingSells[order.uuid] = { uuid: order.uuid, market, quantity: position.quantity, price, reasonCodes, at: new Date().toISOString(), costBasis: parseFloat(position.quantity) * position.avgBuyPrice };
      await saveState(state);
      return;
    }

    const actualPrice = filled.avg_price ? parseFloat(filled.avg_price) : undefined;
    const netKrw = filled.executed_funds && filled.paid_fee ? parseFloat(filled.executed_funds) - parseFloat(filled.paid_fee) : undefined;
    const costBasis = parseFloat(position.quantity) * position.avgBuyPrice;
    const pnlKrw = netKrw !== undefined ? netKrw - costBasis : undefined;
    if (actualPrice) {
      const pnlStr = pnlKrw !== undefined ? ` | 손익: ${pnlKrw >= 0 ? "+" : ""}${Math.floor(pnlKrw).toLocaleString()}원` : "";
      console.log(`[live-trader]   체결가: ${actualPrice.toLocaleString()}원${pnlStr}`);
    }

    delete state.positions[market];
    state.trades.push({ at: new Date().toISOString(), market, side: "sell", amount: parseFloat(position.quantity), price, actualPrice, netKrw, pnlKrw, dryRun: false, reasonCodes });
    await saveState(state);
  } catch (e) {
    console.error(`[live-trader] ❌ 매도 실패 ${market}:`, e);
  } finally {
    orderInProgress.delete(market);
  }
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

// ── 하트비트 ──────────────────────────────────────────────────────────────────
setInterval(() => {
  if (!state) return;
  writePublicStatus().catch(e => console.error("[live-trader] 상태 쓰기 실패:", e));
}, 30_000);

setInterval(() => {
  if (!state) return;
  const pos = Object.keys(state.positions).map(m => m.replace("KRW-", "")).join(", ") || "없음";
  const bal = state.startBalance ? `수익: ${(Object.values(state.positions).reduce((s, p) => s + parseFloat(p.quantity) * getLatestPrice(p.market, p.avgBuyPrice), 0) - Object.values(state.positions).reduce((s, p) => s + parseFloat(p.quantity) * p.avgBuyPrice, 0)).toFixed(0)}원` : "";
  console.log(`[live-trader] [${new Date().toISOString().slice(11, 19)}] 포지션: ${pos} | 거래: ${state.trades.length}회 | ${DRY_RUN ? "DRY-RUN" : "실매매"} | ${bal}`);
}, 60_000);

// ── 종료 ──────────────────────────────────────────────────────────────────────
async function shutdown(code: number) {
  try { activeWs?.close(); } catch {}
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  await releaseProcessLock().catch(() => {});
  process.exit(code);
}
process.once("SIGINT",  () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));

init().catch(async e => {
  console.error("[live-trader] 초기화 실패:", e);
  await releaseProcessLock().catch(() => {});
  process.exit(1);
});
