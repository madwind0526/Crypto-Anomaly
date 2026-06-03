/**
 * Upbit WebSocket Live Simulation
 *
 * Connects to Upbit's real-time trade stream for all selected anomaly markets.
 * Runs two parallel paper simulations on the same live data:
 *
 *   WS-O  — reacts immediately when entry conditions are met mid-candle
 *            (entry price = current tick price)
 *
 *   WS-X  — same WebSocket data but decisions only at 1-minute candle close
 *            (entry price = candle.close, equivalent to current REST behavior)
 *
 * Writes public/market/ws-live-results.json every OUTPUT_INTERVAL_MS.
 *
 * Usage:
 *   node scripts/ws-live.mjs
 */

import WebSocket from "ws";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { sma, rateOfChange } from "../src/indicators/technical";
import type { Candle } from "../src/types/trading";

const root       = process.cwd();
const selPath    = path.join(root, "public", "market", "anomaly-selection.json");
// Prefer the accumulated 7-day file (written by sim:anomaly); fall back to fresh 24h fetch.
const live1mPath = path.join(root, "data",   "market", "upbit-krw-1m-anomaly-accum.json");
const live1mFallbackPath = path.join(root, "data", "market", "upbit-krw-1m-anomaly.json");
const paramsPath = path.join(root, "public", "market", "anomaly-optimized-params.json");
const outputDir  = path.join(root, "public", "market");
const outputPath = path.join(outputDir, "ws-live-results.json");

const WS_URL             = "wss://api.upbit.com/websocket/v1";
const OUTPUT_INTERVAL_MS = 5_000;
const RECONNECT_DELAY_MS = 5_000;

// ─── types ────────────────────────────────────────────────────────────────────
type SlotId = "momentum" | "range-grid" | "arbitrage" | "anomaly";
const SLOTS: SlotId[] = ["momentum", "range-grid", "arbitrage", "anomaly"];

interface OptParams {
  trailingStopPct:  number;
  maxHoldCandles:   number;
  curBodyMin?:      number;
  bodyMin?:         number;
  momentumBodyMin?: number;
  accelerationMin?: number;
}

interface WsPos {
  market:    string;
  entry:     number;
  peak:      number;
  holdBars:  number;
  entryTime: number;
}

interface WsState {
  cash:       number;
  pos:        WsPos | null;
  trades:     number;
  returnRate: number;
}

interface LiveCandle {
  open: number; high: number; low: number; close: number;
  volume: number; quoteVolume: number; timestamp: number;
}

interface UpbitTick {
  type:            string;
  code:            string;
  trade_price:     number;
  trade_volume:    number;
  trade_timestamp: number;  // ms, aligned to trade time
  ask_bid:         "ASK" | "BID";
}

// ─── global state ─────────────────────────────────────────────────────────────
let selectedMarkets: string[] = [];
let perCoinParams: Record<string, Record<string, OptParams>> = {};

// Closed (finalized) candles per market — seeded from historical data
const closedCandles: Record<string, Candle[]> = {};
// Current accumulating candle per market
const liveCandle: Record<string, LiveCandle> = {};
// Last minute boundary seen per market (ms)
const lastMinute: Record<string, number> = {};

type Mode = "wsO" | "wsX";
const MODES: Mode[] = ["wsO", "wsX"];

function newState(): WsState { return { cash: 1.0, pos: null, trades: 0, returnRate: 0 }; }

const simStates: Record<Mode, Record<SlotId, WsState>> = {
  wsO: { momentum: newState(), "range-grid": newState(), arbitrage: newState(), anomaly: newState() },
  wsX: { momentum: newState(), "range-grid": newState(), arbitrage: newState(), anomaly: newState() },
};

let wsStatus: "connecting" | "connected" | "disconnected" = "connecting";
let connectedAt  = "";
let totalTicks   = 0;
let activeWs: WebSocket | null = null;

// ─── indicator helpers ────────────────────────────────────────────────────────
function getAvgVol48(candles: Candle[], i: number): number | null {
  if (i < 48) return null;
  return candles.slice(i - 48, i).reduce((s, c) => s + c.volume, 0) / 48;
}
function getBody(c: Candle): number { return (c.close - c.open) / (c.open || 1); }
function getTopRatio(c: Candle): number {
  const r = c.high - c.low; return r < 1e-10 ? 0.5 : (c.close - c.low) / r;
}
function getAvgBody15(candles: Candle[], i: number): number {
  return candles.slice(Math.max(0, i - 15), i).map(c => Math.abs(getBody(c)))
    .reduce((s, v) => s + v, 0) / Math.min(15, i);
}
function getRoc(candles: Candle[], i: number, period: number): number | null {
  if (i < period) return null;
  const prev = candles[i - period].close;
  return prev > 0 ? (candles[i].close - prev) / prev : null;
}

// ─── strategy entry checks ────────────────────────────────────────────────────
// Each returns null (no signal) or { trail, maxHold } (entry signal)
interface EntrySignal { trail: number; maxHold: number; }

function checkEntryA(candles: Candle[], coinP?: OptParams | null): EntrySignal | null {
  const n = candles.length; if (n < 52) return null;
  const i = n - 1;
  const avgVol = getAvgVol48(candles, i); if (!avgVol) return null;
  const roc48  = getRoc(candles, i, 48);  if (roc48 === null || Math.abs(roc48) >= 0.05) return null;
  const avgBody   = getAvgBody15(candles, i);
  const curBodyMin = coinP?.curBodyMin ?? 0.015;
  const body = getBody(candles[i]);
  if (avgBody < 0.005 && body >= curBodyMin && candles[i].close > candles[i].open
    && candles[i].volume / avgVol >= 1.5) {
    return { trail: coinP?.trailingStopPct ?? 0.028, maxHold: coinP?.maxHoldCandles ?? 12 };
  }
  return null;
}

function checkEntryB(candles: Candle[], coinP?: OptParams | null): EntrySignal | null {
  const n = candles.length; if (n < 52) return null;
  const i = n - 1;
  const avgVol = getAvgVol48(candles, i); if (!avgVol) return null;
  for (let k = 1; k <= 3; k++) {
    if (Math.abs(getBody(candles[i - k])) > 0.008 || candles[i - k].volume / avgVol > 1.6) return null;
  }
  const pre5Close = candles[Math.max(0, i - 6)].close;
  const preRoc5   = pre5Close > 0 ? Math.abs((candles[i - 1].close - pre5Close) / pre5Close) : 0;
  const bodyMin = coinP?.bodyMin ?? 0.025;
  if (getBody(candles[i]) >= bodyMin && candles[i].volume / avgVol >= 3.5
    && getTopRatio(candles[i]) >= 0.60 && preRoc5 < 0.05) {
    return { trail: coinP?.trailingStopPct ?? 0.018, maxHold: coinP?.maxHoldCandles ?? 6 };
  }
  return null;
}

function checkEntryC(candles: Candle[], coinP?: OptParams | null): EntrySignal | null {
  // Mirrors decideC in anomaly-variants-sim.ts: explosion on i-1, confirmation on i
  const n = candles.length; if (n < 53) return null;
  const i = n - 1;
  const avgVol = getAvgVol48(candles, i); if (!avgVol) return null;
  const confirmVolMin = coinP?.confirmVolMin ?? 1.8;

  const prevBody = getBody(candles[i - 1]);
  const prevTop  = getTopRatio(candles[i - 1]);
  const prevVol  = candles[i - 1].volume / avgVol;

  // Require 3 calm candles before the explosion (i-4 to i-2)
  let calm = true;
  for (let k = 2; k <= 4; k++) {
    if (Math.abs(getBody(candles[i - k])) > 0.008 || candles[i - k].volume / avgVol > 1.6) { calm = false; break; }
  }

  // Check no runup into explosion candle (preRoc5 < 5%)
  const prev5Close  = candles[Math.max(0, i - 7)].close;
  const prev2Close  = candles[i - 2].close;
  const prevPreRoc5 = prev5Close > 0 ? Math.abs((prev2Close - prev5Close) / prev5Close) : 0;

  const prevExploded = calm && prevBody >= 0.025 && prevTop >= 0.60 && prevVol >= 3.5 && prevPreRoc5 < 0.05;
  if (!prevExploded) return null;

  const curVol = candles[i].volume / avgVol;
  if (curVol >= confirmVolMin && getBody(candles[i]) >= 0 && candles[i].close >= candles[i - 1].close) {
    return { trail: coinP?.trailingStopPct ?? 0.022, maxHold: coinP?.maxHoldCandles ?? 8 };
  }
  return null;
}

function checkEntryD(candles: Candle[], coinP?: OptParams | null): EntrySignal | null {
  const n = candles.length; if (n < 52) return null;
  const i = n - 1;
  const avgVol = getAvgVol48(candles, i); if (!avgVol) return null;
  const volR = candles[i].volume / avgVol;
  const accelerationMin = coinP?.accelerationMin ?? 0.020;
  const maxExtendedMove = 0.25; // 1m 기준 (anomaly.ts makeSweepBestScenario와 동일)
  const roc3  = getRoc(candles, i, 3)  ?? 0;
  const roc48 = getRoc(candles, i, 48) ?? 0;
  if (volR >= 3.5 && roc3 >= accelerationMin && roc48 < maxExtendedMove && candles[i].close > candles[i].open) {
    return { trail: coinP?.trailingStopPct ?? 0.018, maxHold: coinP?.maxHoldCandles ?? 12 };
  }
  return null;
}

const CHECK_ENTRY: Record<SlotId, (c: Candle[], p?: OptParams | null) => EntrySignal | null> = {
  "momentum":   checkEntryA,
  "range-grid": checkEntryB,
  "arbitrage":  checkEntryC,
  "anomaly":    checkEntryD,
};

// ─── simulation state transitions ─────────────────────────────────────────────
function enterPosition(state: WsState, market: string, price: number, ts: number) {
  state.pos = { market, entry: price, peak: price, holdBars: 0, entryTime: ts };
}

function exitPosition(state: WsState, price: number): number {
  const pos = state.pos!;
  const ret = (price - pos.entry) / pos.entry;
  state.cash *= (1 + ret);
  state.trades++;
  state.returnRate = state.cash - 1;
  state.pos = null;
  return ret;
}

// Called on every tick — only updates trailing stop for WS-O positions
function tickWsO(market: string, price: number, ts: number) {
  for (const slot of SLOTS) {
    const state = simStates.wsO[slot];
    if (state.pos && state.pos.market === market) {
      // Update peak and check trailing stop
      state.pos.peak = Math.max(state.pos.peak, price);
      const stop = state.pos.peak * (1 - getCoinTrail(slot, market));
      if (price <= stop) {
        exitPosition(state, stop);
      }
    }
  }
}

function getCoinTrail(slot: SlotId, market: string): number {
  const p = perCoinParams[market]?.[slot];
  return p?.trailingStopPct ?? { momentum: 0.028, "range-grid": 0.018, arbitrage: 0.022, anomaly: 0.018 }[slot];
}

// Called when a candle closes — runs WS-X decisions and WS-O bar-based exits
function onCandleClose(market: string, closedC: Candle) {
  const candles = closedCandles[market] ?? [];

  // WS-X: full candle-close decisions (entry + exit)
  for (const slot of SLOTS) {
    const state = simStates.wsX[slot];
    const coinP = perCoinParams[market]?.[slot] as OptParams | undefined;

    if (state.pos && state.pos.market === market) {
      // Exit check at candle close
      state.pos.peak = Math.max(state.pos.peak, closedC.high);
      const stop  = state.pos.peak * (1 - (coinP?.trailingStopPct ?? getCoinTrail(slot, market)));
      const avgV  = getAvgVol48(candles, candles.length - 1);
      const fadeMul = slot === "range-grid" ? 1.3 : 1.2; // B전략 1.3× (anomaly-variants-sim.ts decideB와 일치)
      const fade  = avgV !== null && closedC.volume < avgV * fadeMul;
      const rev   = getBody(closedC) < -0.008;
      state.pos.holdBars++;
      const maxHold = coinP?.maxHoldCandles ?? 8;
      if (closedC.close <= stop || fade || rev || state.pos.holdBars >= maxHold) {
        exitPosition(state, closedC.close <= stop ? stop : closedC.close);
      }
    } else if (!state.pos) {
      // Entry check at candle close
      const sig = CHECK_ENTRY[slot](candles, coinP);
      if (sig) enterPosition(state, market, closedC.close, closedC.timestamp);
    }
  }

  // WS-O: bar-based exit checks (trailing stop already handled per-tick)
  for (const slot of SLOTS) {
    const state = simStates.wsO[slot];
    const coinP = perCoinParams[market]?.[slot] as OptParams | undefined;
    if (state.pos && state.pos.market === market) {
      state.pos.holdBars++;
      state.pos.peak = Math.max(state.pos.peak, closedC.high);
      // Fade / reversal / time exit (trailing stop already triggered per-tick)
      const avgV  = getAvgVol48(candles, candles.length - 1);
      const fadeMul = slot === "range-grid" ? 1.3 : 1.2; // B전략 1.3× (anomaly-variants-sim.ts decideB와 일치)
      const fade  = avgV !== null && closedC.volume < avgV * fadeMul;
      const rev   = getBody(closedC) < -0.008;
      const maxHold = coinP?.maxHoldCandles ?? 8;
      if (fade || rev || state.pos.holdBars >= maxHold) {
        exitPosition(state, closedC.close);
      }
    } else if (!state.pos) {
      // WS-O entry: check entry conditions with current virtual candle already processed
      // (mid-candle entries are handled in onTick; here we just allow re-entry if still no pos)
      const sig = CHECK_ENTRY[slot](candles, coinP);
      if (sig) enterPosition(state, market, closedC.close, closedC.timestamp);
    }
  }
}

// Mid-candle WS-O entry check (called on each tick)
function tryWsOEntry(market: string, tickPrice: number, tickTs: number) {
  const closed = closedCandles[market] ?? [];
  const lc     = liveCandle[market];
  if (!lc || closed.length < 52) return;

  // Build virtual candle (current tick as close)
  const virtualCandle: Candle = {
    open: lc.open, high: Math.max(lc.high, tickPrice),
    low: Math.min(lc.low, tickPrice), close: tickPrice,
    volume: lc.volume + 1e-9, quoteVolume: lc.quoteVolume,
    timestamp: lc.timestamp,
  };
  const allCandles = [...closed, virtualCandle];

  for (const slot of SLOTS) {
    const state = simStates.wsO[slot];
    if (state.pos) continue; // already in a position
    const coinP = perCoinParams[market]?.[slot] as OptParams | undefined;
    const sig = CHECK_ENTRY[slot](allCandles, coinP);
    if (sig) enterPosition(state, market, tickPrice, tickTs);
  }
}

// ─── tick handler ─────────────────────────────────────────────────────────────
function handleTick(tick: UpbitTick) {
  const market = tick.code;
  if (!selectedMarkets.includes(market)) return;
  totalTicks++;

  const tickTs  = tick.trade_timestamp;
  const minTs   = Math.floor(tickTs / 60_000) * 60_000;
  const prevMin = lastMinute[market];

  if (prevMin !== undefined && minTs > prevMin) {
    // Minute boundary — finalize the previous candle
    const lc = liveCandle[market];
    if (lc) {
      const closedC: Candle = { ...lc };
      if (!closedCandles[market]) closedCandles[market] = [];
      closedCandles[market].push(closedC);
      // Keep only last 500 candles to limit memory (slice is O(n) copy but avoids O(n) shift per tick)
      if (closedCandles[market].length > 500) closedCandles[market] = closedCandles[market].slice(-500);
      onCandleClose(market, closedC);
    }
    // Start new candle
    liveCandle[market] = {
      open: tick.trade_price, high: tick.trade_price,
      low:  tick.trade_price, close: tick.trade_price,
      volume: tick.trade_volume, quoteVolume: tick.trade_price * tick.trade_volume,
      timestamp: minTs,
    };
  } else if (!liveCandle[market]) {
    // First tick for this market
    liveCandle[market] = {
      open: tick.trade_price, high: tick.trade_price,
      low:  tick.trade_price, close: tick.trade_price,
      volume: tick.trade_volume, quoteVolume: tick.trade_price * tick.trade_volume,
      timestamp: minTs,
    };
  } else {
    // Update existing live candle
    const lc = liveCandle[market];
    lc.high         = Math.max(lc.high, tick.trade_price);
    lc.low          = Math.min(lc.low,  tick.trade_price);
    lc.close        = tick.trade_price;
    lc.volume      += tick.trade_volume;
    lc.quoteVolume += tick.trade_price * tick.trade_volume;
  }

  lastMinute[market] = minTs;

  // WS-O: mid-candle trailing stop check
  tickWsO(market, tick.trade_price, tickTs);

  // WS-O: mid-candle entry check (throttled to every ~10 ticks to reduce CPU)
  if (totalTicks % 10 === 0) {
    tryWsOEntry(market, tick.trade_price, tickTs);
  }
}

// ─── output ───────────────────────────────────────────────────────────────────
async function writeOutput() {
  const output = {
    connectedAt,
    updatedAt:       new Date().toISOString(),
    status:          wsStatus,
    tickCount:       totalTicks,
    selectedMarkets,
    wsO: Object.fromEntries(SLOTS.map(s => [s, {
      returnRate: simStates.wsO[s].returnRate,
      trades:     simStates.wsO[s].trades,
      cash:       simStates.wsO[s].cash,
      position:   simStates.wsO[s].pos ? { market: simStates.wsO[s].pos!.market, entryPrice: simStates.wsO[s].pos!.entry, holdBars: simStates.wsO[s].pos!.holdBars } : null,
    }])),
    wsX: Object.fromEntries(SLOTS.map(s => [s, {
      returnRate: simStates.wsX[s].returnRate,
      trades:     simStates.wsX[s].trades,
      cash:       simStates.wsX[s].cash,
      position:   simStates.wsX[s].pos ? { market: simStates.wsX[s].pos!.market, entryPrice: simStates.wsX[s].pos!.entry, holdBars: simStates.wsX[s].pos!.holdBars } : null,
    }])),
    liveCandles: Object.fromEntries(
      Object.entries(liveCandle).map(([m, c]) => [m, { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: c.timestamp }])
    ),
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(output) + "\n", "utf8");
}

// ─── WebSocket connection ─────────────────────────────────────────────────────
function connect() {
  wsStatus = "connecting";
  console.log(`[WS] Connecting to ${WS_URL}…`);
  const ws = new WebSocket(WS_URL);
  activeWs = ws;

  ws.on("open", () => {
    wsStatus    = "connected";
    connectedAt = new Date().toISOString();
    console.log(`[WS] Connected — subscribing to ${selectedMarkets.length} markets`);
    const payload = JSON.stringify([
      { ticket: "anomaly-ws-live" },
      { type: "trade", codes: selectedMarkets },
    ]);
    ws.send(payload);
  });

  ws.on("message", (data: Buffer) => {
    try {
      const tick: UpbitTick = JSON.parse(data.toString("utf8"));
      if (tick.type === "trade") handleTick(tick);
    } catch { /* ignore parse errors */ }
  });

  ws.on("close", () => {
    wsStatus  = "disconnected";
    activeWs  = null;
    console.log(`[WS] Disconnected — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err: Error) => {
    console.error(`[WS] Error: ${err.message}`);
    ws.terminate();
  });
}

// ─── init ─────────────────────────────────────────────────────────────────────
async function init() {
  // 1. Load market selection
  const sel = JSON.parse(await readFile(selPath, "utf8"));
  if (Array.isArray(sel.markets)) {
    selectedMarkets = (sel.markets as Array<{ market: string }>).map(m => m.market);
  } else if (Array.isArray(sel.candidateMarkets)) {
    selectedMarkets = (sel.candidateMarkets as unknown[])
      .filter((m): m is string => typeof m === "string");
  } else {
    throw new Error("anomaly-selection.json에 markets / candidateMarkets 필드가 없습니다.");
  }
  console.log(`[init] Selected markets: ${selectedMarkets.length}`);

  // 2. Load per-coin optimized params (optional)
  try {
    const saved = JSON.parse(await readFile(paramsPath, "utf8"));
    perCoinParams = saved.params ?? {};
    console.log(`[init] Loaded optimized params for ${Object.keys(perCoinParams).length} markets`);
  } catch { console.log("[init] No optimized params found — using defaults"); }

  // 3. Seed historical candles — prefer accumulated 7-day file, fall back to fresh 24h fetch.
  try {
    let rawText: string;
    try {
      rawText = await readFile(live1mPath, "utf8");
    } catch {
      rawText = await readFile(live1mFallbackPath, "utf8");
      console.log("[init] Accumulated file not found — using fresh 24h data");
    }
    const raw  = JSON.parse(rawText);
    const byM: Record<string, Candle[]> = raw.candlesByMarket ?? {};
    for (const market of selectedMarkets) {
      // Use last 500 candles for indicator context
      closedCandles[market] = (byM[market] ?? []).slice(-500);
    }
    const sample = selectedMarkets[0];
    console.log(`[init] Seeded ${closedCandles[sample]?.length ?? 0} historical candles per market`);
  } catch { console.log("[init] No historical 1m data — starting fresh"); }

  // 4. Connect WebSocket
  connect();

  // 5. Periodic output
  setInterval(() => {
    writeOutput().catch(e => console.error("[output]", e));
  }, OUTPUT_INTERVAL_MS);

  // 6. Periodic status log
  setInterval(() => {
    const wsoR = SLOTS.map(s => `${s.slice(0,3)}:${(simStates.wsO[s].returnRate*100).toFixed(2)}%`).join("  ");
    const wsxR = SLOTS.map(s => `${s.slice(0,3)}:${(simStates.wsX[s].returnRate*100).toFixed(2)}%`).join("  ");
    console.log(`[${new Date().toISOString().slice(11,19)}] ticks:${totalTicks}  WS-O: ${wsoR}  WS-X: ${wsxR}`);
  }, 60_000);

  // Write initial state
  await writeOutput();
  console.log(`[init] Writing results to ${path.relative(root, outputPath)}`);
}

init().catch(e => { console.error("[init] Fatal:", e); process.exit(1); });

// Graceful shutdown
process.on("SIGINT",  () => { activeWs?.terminate(); process.exit(0); });
process.on("SIGTERM", () => { activeWs?.terminate(); process.exit(0); });
