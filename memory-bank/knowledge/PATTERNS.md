# Patterns

> 검증된 코드 패턴. 복붙 바로 가능한 형태로 유지.

---

## Pool 누적 패턴

**사용 시점:** 매일 00:00 KST 종목 선정 시 (scripts/anomaly-variants-sim.ts)

```typescript
// 1. 전날 pool 로드
const prevPool: string[] = selection?.candidateMarkets ?? [];
const prevLastEvents: Record<string, number> = selection?.candidateMarketLastEvents ?? {};

// 2. 오늘 새로 감지된 종목
const todayDetected: string[] = detectAnomalyMarkets(candles7d);

// 3. Union 누적 (중복 제거)
const unionPool = Array.from(new Set([...prevPool, ...todayDetected]));

// 4. 45일 초과 종목 제거
const nowMs = Date.now();
const POOL_REMOVAL_DAYS = 45;
const activePool = unionPool.filter((market) => {
  const lastEvent = prevLastEvents[market] ?? 0;
  const daysSince = (nowMs - lastEvent) / (1000 * 60 * 60 * 24);
  return daysSince <= POOL_REMOVAL_DAYS;
});

// 5. top 9 선정
const selected = activePool.slice(0, 9);
```

---

## candidateMarketLastEvents 영속성 패턴

**사용 시점:** 특이점 이벤트 발생 시 타임스탬프를 업데이트하고 저장

```typescript
// 이벤트 감지 시 타임스탬프 갱신
for (const event of detectedEvents) {
  prevLastEvents[event.market] = Math.max(
    prevLastEvents[event.market] ?? 0,
    event.timestamp
  );
}

// anomaly-selection.json에 함께 저장
const selection = {
  candidateMarkets: activePool,
  candidateMarketLastEvents: prevLastEvents,
  selectedMarkets: selected,
  generatedAt: new Date().toISOString(),
  // ...
};
```

---

## 70/30 파라미터 블렌딩 패턴

**사용 시점:** 매일 refit 시 이전 파라미터와 전일 이벤트 기반 파라미터 혼합

```typescript
function blendParams(prevParam: number, newParam: number, alpha = 0.7): number {
  return alpha * prevParam + (1 - alpha) * newParam;
}

// 적용 예: trailingStop
const trailingStop = blendParams(prevParams.trailingStop, adaptedParams.trailingStop);
```

---

## 4개 전략 공통 진입 조건 체크 패턴

**사용 시점:** scripts/anomaly-variants-sim.ts 의 decideA/B/C/D 함수

```typescript
// Anomaly-A (Calm Impulse): 조용한 구간 후 충동
function decideA(candles: Candle[], i: number, params: Params): boolean {
  const calm = candles.slice(i - 15, i);
  const avgBody = calm.reduce((sum, c) => sum + Math.abs(c.close - c.open) / c.open, 0) / 15;
  const cur = candles[i];
  const curBody = Math.abs(cur.close - cur.open) / cur.open;
  const vol48 = avgVolume(candles, i, 48);
  const roc48 = (cur.close - candles[i - 48].close) / candles[i - 48].close;
  return avgBody < 0.005 && curBody >= 0.015 && cur.volume >= vol48 * 1.5 && roc48 < 0.05;
}

// Anomaly-B (First Explosion): 폭발 캔들 직접 진입
function decideB(candles: Candle[], i: number): boolean {
  const cur = candles[i];
  const curBody = Math.abs(cur.close - cur.open) / cur.open;
  const vol48 = avgVolume(candles, i, 48);
  const pre5Close = candles[i - 6].close;
  const pre1Close = candles[i - 1].close;
  const preRoc5 = Math.abs(pre1Close - pre5Close) / pre5Close;
  const prev3Calm = /* 선행 3봉 조용함 체크 */;
  return curBody >= 0.025 && cur.volume >= vol48 * 3.5 && preRoc5 < 0.05 && prev3Calm;
}
```

---

## WS 실시간 결과 5초 폴링 패턴

**사용 시점:** App.tsx의 WS 상태 폴링

```typescript
useEffect(() => {
  let active = true;
  async function pollWsLiveResults() {
    const result = await loadWsLiveResults();
    if (active) setWsLiveResults(result);
  }
  pollWsLiveResults();
  const timer = window.setInterval(pollWsLiveResults, 5_000);
  return () => { active = false; window.clearInterval(timer); };
}, []);
```

---

## Live Trade 상태 10초 폴링 패턴

**사용 시점:** App.tsx의 Live Trade 상태 폴링

```typescript
useEffect(() => {
  let active = true;
  async function pollLiveTradeStatus() {
    try {
      const res = await fetch("/market/anomaly-live-trade-status.json", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json() as LiveTradeStatus;
      if (active) setLiveTradeStatus(data);
    } catch { /* not running */ }
  }
  pollLiveTradeStatus();
  const timer = window.setInterval(pollLiveTradeStatus, 10_000);
  return () => { active = false; window.clearInterval(timer); };
}, []);
```

---

## Daily Operation 15초 폴링 패턴

**사용 시점:** App.tsx의 daily paper 결과 폴링 (화면 갱신용)

```typescript
useEffect(() => {
  // generatedAt 변경 시에만 state 업데이트 (불필요한 리렌더 방지)
  const timer = window.setInterval(async () => {
    const [nextDaily, nextPaper] = await loadDailyOperationState();
    const nextAt = nextDaily?.generatedAt ?? "";
    if (nextAt && nextAt !== lastDailyMarketGeneratedAtRef.current) {
      lastDailyMarketGeneratedAtRef.current = nextAt;
      setDailyMarketData(nextDaily);
    }
    // paper도 동일 패턴
  }, 15_000);
  return () => window.clearInterval(timer);
}, []);
```

---

## Guideline/Safety 4 Case 결과 구조

**사용 시점:** paper-trading-1m-daily-results.json 읽기/쓰기

```typescript
interface DailyPaperResultsPayload {
  generatedAt: string;
  caseResults: {
    strict: {
      enabled: Record<TraderId, DailyPaperResult>;
      disabled: Record<TraderId, DailyPaperResult>;
    };
    ignored: {
      enabled: Record<TraderId, DailyPaperResult>;
      disabled: Record<TraderId, DailyPaperResult>;
    };
  };
}
```
