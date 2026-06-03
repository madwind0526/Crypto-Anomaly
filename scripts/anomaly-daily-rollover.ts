/**
 * anomaly-daily-rollover.ts
 *
 * 매일 00:00 KST 직후 실행하는 일일 재최적화 스크립트.
 *
 * 처리 순서:
 *   1. Upbit API → 100~10,000원 KRW 마켓 거래대금 상위 30개 조회
 *   2. 전날 00:00~24:00 KST 1m 캔들 수집
 *   3. runOptimization으로 per-coin 파라미터 최적화 (전날 데이터 기준)
 *   4. 이전 파라미터 70% + 신규 30% 가중 혼합 (급격한 파라미터 점프 방지)
 *   5. 코인별 파라미터 파일 저장 → data/local/anomaly-market-params/{market}.json
 *   6. anomaly-optimized-params.json 업데이트
 *   7. anomaly-selection.json candidateMarkets 갱신 (pool에 새 top-30 반영)
 *   8. 롤오버 상태 파일 저장
 *
 * 실행:
 *   npm run rollover                 (전날 기준 자동 실행)
 *   ROLLOVER_DRY_RUN=true npm run rollover  (최적화만, 파일 저장 없음)
 *
 * 환경 변수:
 *   ROLLOVER_CANDIDATE_MARKET_COUNT  후보 시장 수 (기본 30)
 *   ROLLOVER_MONITORING_MARKET_COUNT 모니터링 시장 수 (기본 15)
 *   ROLLOVER_MIN_PRICE               최소 코인 가격 (기본 100원)
 *   ROLLOVER_MAX_PRICE               최대 코인 가격 (기본 10,000원)
 *   ROLLOVER_REFIT_PREVIOUS_WEIGHT   이전 파라미터 가중치 (기본 0.7)
 *   ROLLOVER_MIN_COMPLETENESS_RATIO  최소 캔들 완성도 (기본 0.7)
 *   ROLLOVER_AT_KST                  롤오버 기준 시각 ISO (기본: 지금)
 *   ROLLOVER_DRY_RUN                 true면 파일 쓰기 생략
 *   UPBIT_REQUEST_DELAY_MS           API 요청 간격 (기본 180ms)
 *   UPBIT_MAX_RETRIES                재시도 횟수 (기본 4)
 *   POOL_REMOVAL_DAYS                pool에서 제거 기준 일수 (기본 45)
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runOptimization, type OptimizedParams, type OptimizedCoinParams } from "./optimize-params";

// ── 상수 ─────────────────────────────────────────────────────────────────────
const root                = process.cwd();
const outputRoot          = path.join(root, "data", "local");
const marketParamsDir     = path.join(outputRoot, "anomaly-market-params");
const optimizedParamsPath = path.join(root, "public", "market", "anomaly-optimized-params.json");
const selectionPath       = path.join(root, "public", "market", "anomaly-selection.json");
const rolloverStatusPath  = path.join(outputRoot, "anomaly-rollover-status.json");

const candidateMarketCount  = Number(process.env.ROLLOVER_CANDIDATE_MARKET_COUNT  ?? 30);
const monitoringMarketCount = Number(process.env.ROLLOVER_MONITORING_MARKET_COUNT ?? 15);
const minPrice              = Number(process.env.ROLLOVER_MIN_PRICE               ?? 100);
const maxPrice              = Number(process.env.ROLLOVER_MAX_PRICE               ?? 10_000);
const refitPreviousWeight   = clamp(Number(process.env.ROLLOVER_REFIT_PREVIOUS_WEIGHT ?? 0.7), 0, 1);
const minCompletenessRatio  = Number(process.env.ROLLOVER_MIN_COMPLETENESS_RATIO  ?? 0.7);
const requestDelayMs        = Number(process.env.UPBIT_REQUEST_DELAY_MS           ?? 180);
const maxRetries            = Number(process.env.UPBIT_MAX_RETRIES                ?? 4);
const poolRemovalDays       = Number(process.env.POOL_REMOVAL_DAYS                ?? 45);
const dryRun                = process.env.ROLLOVER_DRY_RUN === "true";
const UPBIT_BASE_URL        = "https://api.upbit.com";
const KST_OFFSET_MS         = 9 * 3_600_000;
const MS_DAY                = 86_400_000;

// ── KST 시간 유틸 ─────────────────────────────────────────────────────────────
function kstDateString(ts = Date.now()): string {
  return new Date(ts + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function kstDayStartMs(ts: number): number {
  const kst = ts + KST_OFFSET_MS;
  return kst - (kst % MS_DAY) - KST_OFFSET_MS;
}

function parseKstTime(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+09:00`;
  const ts = Date.parse(withZone);
  if (!Number.isFinite(ts)) throw new Error(`Invalid KST time value: ${value}`);
  return ts;
}

function formatKst(ts: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(ts);
}

// ── 롤오버 기준 시각 및 윈도우 ────────────────────────────────────────────────
const rolloverAt  = parseKstTime(process.env.ROLLOVER_AT_KST ?? process.env.ROLLOVER_AT) ?? Date.now();
const windowEnd   = kstDayStartMs(rolloverAt);           // 오늘 00:00 KST
const windowStart = windowEnd - MS_DAY;                  // 전날 00:00 KST
const today       = kstDateString(rolloverAt);
const yesterday   = kstDateString(rolloverAt - MS_DAY);
const generatedAt = new Date().toISOString();
const expectedWindowCandles = Math.floor((windowEnd - windowStart) / 60_000); // 1440
const minCandles  = Math.floor(expectedWindowCandles * minCompletenessRatio);  // 기본 1008

console.log(`\n[anomaly-rollover] 기준 시각: ${formatKst(rolloverAt)} KST`);
console.log(`[anomaly-rollover] 최적화 윈도우: ${formatKst(windowStart)} ~ ${formatKst(windowEnd)}`);
console.log(`[anomaly-rollover] 최소 캔들: ${minCandles}/${expectedWindowCandles} (완성도 ${(minCompletenessRatio * 100).toFixed(0)}%)`);
if (dryRun) console.log("[anomaly-rollover] ⚠️  DRY RUN 모드 — 파일 저장 생략");

// ── Upbit API ────────────────────────────────────────────────────────────────
interface UpbitTicker {
  market: string;
  trade_price: number;
  acc_trade_price_24h: number;
}

interface UpbitCandle {
  market: string;
  timestamp: number;                  // 마지막 체결 시각 (분 경계 아님 — 직접 쓰지 말 것)
  candle_date_time_utc?: string;      // 분봉 시작 시각 ("2026-06-03T12:24:00")
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  candle_acc_trade_price: number;
}

/** 분봉 시작 시각(ms). candle_date_time_utc 우선, 없으면 timestamp를 1분 경계로 내림. */
function candleStartMs(c: UpbitCandle): number {
  if (typeof c.candle_date_time_utc === "string") {
    const utc = c.candle_date_time_utc;
    const parsed = Date.parse(utc.endsWith("Z") ? utc : `${utc}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Math.floor(c.timestamp / 60_000) * 60_000;
}

async function fetchJson<T>(pathname: string): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${UPBIT_BASE_URL}${pathname}`, { headers: { Accept: "application/json" } });
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) { await sleep(getRetryDelayMs(null, attempt)); continue; }
      break;
    }
    if (res.ok) return res.json() as Promise<T>;
    const text = await res.text();
    lastError = new Error(`Upbit ${res.status}: ${text}`);
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      await sleep(getRetryDelayMs(res, attempt)); continue;
    }
    break;
  }
  throw lastError;
}

function getRetryDelayMs(res: Response | null, attempt: number): number {
  const ra = res?.headers?.get("retry-after");
  if (ra && Number.isFinite(Number(ra))) return Number(ra) * 1000;
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

async function fetchTickers(markets: string[]): Promise<UpbitTicker[]> {
  const tickers: UpbitTicker[] = [];
  for (let i = 0; i < markets.length; i += 100) {
    await sleep(requestDelayMs);
    const params = new URLSearchParams({ markets: markets.slice(i, i + 100).join(",") });
    tickers.push(...await fetchJson<UpbitTicker[]>(`/v1/ticker?${params}`));
  }
  return tickers;
}

async function fetchTopKrwMarkets(count: number): Promise<string[]> {
  const allMarkets = await fetchJson<{ market: string }[]>("/v1/market/all?isDetails=false");
  const krwMarkets = allMarkets.filter(m => m.market.startsWith("KRW-")).map(m => m.market);
  const tickers = await fetchTickers(krwMarkets);
  const filtered = tickers
    .filter(t => t.trade_price >= minPrice && t.trade_price <= maxPrice)
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, count);
  console.log(`[anomaly-rollover] 가격 필터(${minPrice}~${maxPrice}원) → ${filtered.length}개 선정`);
  return filtered.map(t => t.market);
}

async function fetchCandlesForWindow(market: string, start: number, end: number): Promise<import("../src/types/trading").Candle[]> {
  const all: UpbitCandle[] = [];
  let to = new Date(end).toISOString();
  const PAGE_CAP = 10; // 200캔들 × 10 = 2000캔들 (1440분 충분)

  for (let page = 0; page < PAGE_CAP; page++) {
    const params = new URLSearchParams({ count: "200", market, to });
    const page_candles = await fetchJson<UpbitCandle[]>(`/v1/candles/minutes/1?${params}`);
    if (page_candles.length === 0) break;
    all.push(...page_candles);
    const oldest = Math.min(...page_candles.map(c => c.timestamp));
    to = new Date(oldest - 1).toISOString();
    if (oldest <= start) break;
    await sleep(requestDelayMs);
  }

  const byTs = new Map<number, import("../src/types/trading").Candle>();
  for (const c of all) {
    // 윈도우 필터/dedup 은 분 경계로 정규화한 시각 기준
    const ts = candleStartMs(c);
    if (ts < start || ts >= end) continue;
    byTs.set(ts, {
      market: c.market, timestamp: ts,
      open: c.opening_price, high: c.high_price, low: c.low_price, close: c.trade_price,
      volume: c.candle_acc_trade_volume, quoteVolume: c.candle_acc_trade_price,
    });
  }
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// ── 파라미터 혼합 ────────────────────────────────────────────────────────────
function blendCoinSlotParams(prev: OptimizedCoinParams | undefined, next: OptimizedCoinParams | undefined, pw: number): OptimizedCoinParams | undefined {
  if (!prev) return next;
  if (!next) return prev;
  const nw = 1 - pw;
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const p = (prev as Record<string, number>)[key];
    const n = (next as Record<string, number>)[key];
    if (Number.isFinite(p) && Number.isFinite(n)) {
      const v = p * pw + n * nw;
      out[key] = Number.isInteger(p) && Number.isInteger(n) ? Math.round(v) : v;
    } else if (Number.isFinite(n)) out[key] = n;
    else if (Number.isFinite(p)) out[key] = p;
  }
  return out as OptimizedCoinParams;
}

function blendOptimizedParams(prev: OptimizedParams, next: OptimizedParams, pw: number): OptimizedParams {
  const blended: OptimizedParams = {};
  const markets = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const market of markets) {
    blended[market] = {};
    const slots = new Set([...Object.keys(prev[market] ?? {}), ...Object.keys(next[market] ?? {})]);
    for (const slot of slots) {
      const merged = blendCoinSlotParams(
        prev[market]?.[slot] as OptimizedCoinParams | undefined,
        next[market]?.[slot] as OptimizedCoinParams | undefined,
        pw,
      );
      if (merged) blended[market]![slot] = merged;
    }
  }
  return blended;
}

// ── 파일 I/O ────────────────────────────────────────────────────────────────
async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filePath, "utf8")) as T; } catch { return null; }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

// ── per-market 파일 저장 ───────────────────────────────────────────────────
async function persistMarketParams(blendedParams: OptimizedParams): Promise<void> {
  await mkdir(marketParamsDir, { recursive: true });
  for (const [market, slots] of Object.entries(blendedParams)) {
    await writeJson(path.join(marketParamsDir, `${market}.json`), {
      generatedAt, market,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd:   new Date(windowEnd).toISOString(),
      windowStartKst: formatKst(windowStart),
      windowEndKst:   formatKst(windowEnd),
      ...slots,
    });
  }
  console.log(`[anomaly-rollover] per-market 파일 ${Object.keys(blendedParams).length}개 저장 → ${path.relative(root, marketParamsDir)}`);
}

// ── candidateMarkets pool 갱신 ────────────────────────────────────────────
async function updateCandidatePool(freshTopMarkets: string[]): Promise<void> {
  const cached = await readJsonOrNull<any>(selectionPath);
  const prevPool: string[] = Array.isArray(cached?.candidateMarkets) ? cached.candidateMarkets : [];
  const prevLastEvents: Record<string, number> = cached?.candidateMarketLastEvents ?? {};

  const poolRemovalCutoff = Date.now() - poolRemovalDays * MS_DAY;
  const poolSet = new Set([...freshTopMarkets, ...prevPool]);
  const retained = [...poolSet].filter(market => {
    if (freshTopMarkets.includes(market)) return true; // 새 top-30은 항상 유지
    const lastTs = prevLastEvents[market];
    if (lastTs === undefined) return true;
    return lastTs >= poolRemovalCutoff;
  });

  const newlyAdded  = freshTopMarkets.filter(m => !prevPool.includes(m));
  const removedCount = prevPool.filter(m => !retained.includes(m)).length;
  console.log(`[anomaly-rollover] Pool 갱신: ${prevPool.length}개 이전 + ${newlyAdded.length}개 신규 top30 - ${removedCount}개 stale = ${retained.length}개`);

  // selection 파일의 candidateMarkets만 갱신 (나머지 필드는 유지)
  const updated = {
    ...(cached ?? {}),
    date: cached?.date ?? today,    // 날짜는 시뮬레이션 사이클이 갱신
    candidateMarkets: retained,
    candidateMarketLastEvents: prevLastEvents,
    rolloverAt: generatedAt,
    rolloverTopMarkets: freshTopMarkets,
    monitoringMarketCount,
  };
  await writeJson(selectionPath, updated);
  console.log(`[anomaly-rollover] anomaly-selection.json 갱신 완료`);
}

// ── 메인 ────────────────────────────────────────────────────────────────────
console.log(`\n[anomaly-rollover] 시작 (${today} 롤오버, 전날 ${yesterday} 데이터 기준)`);

// 1. 상위 30개 시장 조회
console.log(`\n[anomaly-rollover] Step 1: Upbit API → 거래대금 상위 ${candidateMarketCount}개 조회 (${minPrice}~${maxPrice}원)`);
const topMarkets = await fetchTopKrwMarkets(candidateMarketCount);
console.log(`  선정: ${topMarkets.map(m => m.replace("KRW-", "")).join(", ")}`);

// 2. 전날 1m 캔들 수집
console.log(`\n[anomaly-rollover] Step 2: 1m 캔들 수집 (${topMarkets.length}개 마켓)`);
const candlesByMarket: Record<string, import("../src/types/trading").Candle[]> = {};
let eligibleCount = 0;

for (const market of topMarkets) {
  await sleep(requestDelayMs);
  const candles = await fetchCandlesForWindow(market, windowStart, windowEnd);
  candlesByMarket[market] = candles;
  const ok = candles.length >= minCandles;
  if (ok) eligibleCount++;
  console.log(`  ${market.replace("KRW-", "").padEnd(10)} ${candles.length}캔들 ${ok ? "✓" : `⚠ (< ${minCandles})`}`);
}

if (eligibleCount < monitoringMarketCount) {
  const reason = `적격 마켓 ${eligibleCount}개 < 최소 ${monitoringMarketCount}개. 파라미터 갱신 생략.`;
  console.warn(`\n[anomaly-rollover] ⚠ 롤오버 스킵: ${reason}`);
  await writeJson(rolloverStatusPath, { generatedAt, skipped: true, skipReason: reason, eligibleCount, minCandles, topMarkets });
  process.exit(0);
}
console.log(`[anomaly-rollover] 적격 마켓: ${eligibleCount}/${topMarkets.length}개`);

// 3. per-coin 파라미터 최적화
console.log(`\n[anomaly-rollover] Step 3: per-coin 파라미터 최적화`);
const newOptResult = await runOptimization(candlesByMarket, windowStart, windowEnd, topMarkets, today);
const newParams = newOptResult.params;
console.log(`  최적화 완료: ${Object.keys(newParams).length}개 마켓, ${newOptResult.durationMs}ms`);

// 4. 이전 파라미터와 혼합 (70% 이전 + 30% 신규)
console.log(`\n[anomaly-rollover] Step 4: 파라미터 혼합 (이전 ${(refitPreviousWeight * 100).toFixed(0)}% + 신규 ${((1 - refitPreviousWeight) * 100).toFixed(0)}%)`);
const prevOptimized = await readJsonOrNull<any>(optimizedParamsPath);
const prevParams: OptimizedParams = prevOptimized?.params ?? {};
const prevMarketCount = Object.keys(prevParams).length;

let blendedParams: OptimizedParams;
if (prevMarketCount > 0 && refitPreviousWeight > 0) {
  blendedParams = blendOptimizedParams(prevParams, newParams, refitPreviousWeight);
  console.log(`  혼합 완료: 이전 ${prevMarketCount}개 + 신규 ${Object.keys(newParams).length}개 → ${Object.keys(blendedParams).length}개`);
} else {
  blendedParams = newParams;
  console.log(`  이전 파라미터 없음 → 신규 파라미터 그대로 사용`);
}

if (dryRun) {
  console.log("\n[anomaly-rollover] DRY RUN — 파일 저장 생략");
  process.exit(0);
}

// 5. per-market 파일 저장
console.log(`\n[anomaly-rollover] Step 5: per-market 파라미터 파일 저장`);
await persistMarketParams(blendedParams);

// 6. anomaly-optimized-params.json 업데이트
console.log(`\n[anomaly-rollover] Step 6: anomaly-optimized-params.json 업데이트`);
await writeJson(optimizedParamsPath, {
  date: today,
  generatedAt,
  optimizedAt: generatedAt,
  source: "daily-rollover-1m",
  durationMs: newOptResult.durationMs,
  totalCombos: newOptResult.totalCombos,
  rollover: {
    windowStart: new Date(windowStart).toISOString(),
    windowEnd:   new Date(windowEnd).toISOString(),
    windowStartKst: formatKst(windowStart),
    windowEndKst:   formatKst(windowEnd),
    eligibleMarkets: eligibleCount,
    minCandles,
    previousWeight: refitPreviousWeight,
    newWeight: 1 - refitPreviousWeight,
  },
  params: blendedParams,
});
console.log(`  → ${path.relative(root, optimizedParamsPath)}`);

// 7. candidateMarkets pool 갱신
console.log(`\n[anomaly-rollover] Step 7: candidateMarkets pool 갱신`);
await updateCandidatePool(topMarkets);

// 8. 롤오버 상태 저장
await writeJson(rolloverStatusPath, {
  generatedAt,
  skipped: false,
  date: today,
  yesterday,
  window: {
    start: new Date(windowStart).toISOString(),
    end:   new Date(windowEnd).toISOString(),
    startKst: formatKst(windowStart),
    endKst:   formatKst(windowEnd),
  },
  candidateMarketCount, monitoringMarketCount, minPrice, maxPrice,
  eligibleMarkets: eligibleCount, minCandles,
  refit: { previousWeight: refitPreviousWeight, newWeight: 1 - refitPreviousWeight },
  topMarkets,
  blendedMarketCount: Object.keys(blendedParams).length,
});

console.log(`\n[anomaly-rollover] ✅ 완료 — ${formatKst(Date.now())} KST`);
console.log(`  다음 sim 사이클이 anomaly-optimized-params.json (source=daily-rollover-1m) 을 자동으로 사용합니다.`);

// ── 유틸 ────────────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)); }
