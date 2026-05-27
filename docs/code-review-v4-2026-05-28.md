# Code Review v4 — Crypto-Anomaly

리뷰 일자: 2026-05-28
리뷰 대상: pool 누적 로직 수정 + cycleScore 추가 이후 전체 재검토

---

## 요약

**Critical 0건 / Major 1건 / Minor 5건 / Cosmetic 3건**

v3 이후 수정 사항(pool 누적, cycleScore, perCoinParams 리셋)은 모두 정상. 새로 발견된 구조적 문제 1건이 있음.

---

## 🔴 Major

### M1: `paperTrading.ts`에 trailing stop / stop-loss / take-profit 없음

**파일**: `src/simulation/paperTrading.ts`

`runPaperTradingSimulation`은 포지션 exit을 오직 `strategy.decide()` → `"sell"` 반환에만 의존.
trailing stop / stop-loss / take-profit에 대한 risk rule 체크 코드가 없음.

```typescript
// paperTrading.ts 포지션 처리 (lines 98–107)
if (position) {
  position.highestPrice = Math.max(position.highestPrice, candle.high);
  if (lastPositionCandleTimestamp !== candle.timestamp) {
    position.holdCandles += 1;
    ...
  }
  // ← trailing stop 체크 없음. 가격이 30% 폭락해도 포지션 유지.
}
```

반면 `runBacktest`는 동일 캔들에서 risk rule exit을 정상 처리 (backtest.ts lines 44–73).

**영향**:
- Anomaly-A/B/C: `decideA/B/C`가 buy 신호에 `stopLossPct: 0.015~0.018`을 포함하지만 paper trading에서는 무시됨
- Anomaly-D: `anomalyStrategy.decide()`도 buy 신호에 `stopLossPct`, `takeProfitPct`를 포함하지만 동일하게 무시
- 결과적으로 paper trading의 손실 곡선이 실제보다 더 악화될 수 있음 (stop이 없으므로)
- 반대로 이익도 take-profit 없이 strategy sell 신호까지 보유하므로 더 좋아질 수도 있음
- 실제 환경에 배포 시 완전히 다른 결과 예상

**권장 대응**: `paperTrading.ts`에 trailing stop / stop-loss 체크 추가 (backtest.ts의 lines 44–73 참고).

---

## 🟡 Minor

### m1: `optimize-params.ts` — 매수 수수료 미적용

**파일**: `scripts/optimize-params.ts`

```typescript
function openPos(price: number): Pos {
  return { entry: price * (1 + SLIPPAGE_RATE), high: price, hold: 0 };
}
// 슬리피지만 적용. FEE_RATE 미적용.
```

`backtest.ts`는 매수 시 수수료를 deduct:
```typescript
const fee = budget * config.feeRate;
const quantity = Math.max(0, (budget - fee) / fillPrice);
```

optimizer의 returnRate가 거래당 ~0.05% 과대평가됨. 결과의 상대적 ranking은 유지되므로 최적 params 선택에는 영향 없지만, 절대값은 부정확.

**권장 대응**: `openPos`에서 `price * (1 + SLIPPAGE_RATE) / (1 - FEE_RATE)` 또는 `closePos`에서 양방향 수수료 통합 처리.

---

### m2: `backtestD` — 포지션 보유 중 exit 조건 불완전

**파일**: `scripts/optimize-params.ts`

`backtestD` 보유 중 exit:
```typescript
if (price <= stop || pos.hold >= maxHold) { ... }
// trailing stop + time stop만 체크
```

실제 `anomalyStrategy.decide()` 보유 중 exit (anomaly.ts lines 76–88):
```typescript
const volumeFade = current.volume < averageVolume * 1.2;
const timeStop = position.holdCandles >= scenario.params.maxHoldCandles;
if (volumeFade || timeStop) return sell();
// volumeFade exit이 핵심이지만 backtestD에는 없음
```

optimizer는 trailing stop 기준으로 최적화하지만, 실제 실행은 volumeFade 기준으로 종료.
최적화된 trailing stop이 live 시뮬레이션에서의 exit 타이밍을 반영하지 않음.

**권장 대응**: `backtestD`에 volumeFade 조건 추가:
```typescript
const avgVol = ind.avgVol48[i];
const fade = avgVol !== null && candles[i].volume < avgVol * 1.2;
if (price <= stop || fade || pos.hold >= maxHold) { ... }
```

---

### m3: 동일날 캐시 히트 시 `candidateMarketLastEvents` 갱신 안 됨

**파일**: `scripts/anomaly-variants-sim.ts`

같은 날짜 캐시 hit 분기:
```typescript
if (cachedSelection?.date === today && ...) {
  candidateMarketNames = cachedSelection.candidateMarkets;
  candidateMarketLastEvents = cachedSelection.candidateMarketLastEvents ?? {};
  // ← 오늘 새로 감지된 anomaly 이벤트 반영 안 됨
}
```

매 사이클마다 `detectedAnomalyMarkets`는 fresh하게 계산되지만, 동일날 cache hit 시 오늘 감지된 이벤트의 lastEventTs가 `candidateMarketLastEvents`에 업데이트되지 않음.

**영향**: 오늘 15:00에 이벤트가 발생한 코인이 내일 reset 시에도 stale한 lastEventTs로 `cycleScore` 계산. 단, 내일 else 분기에서 `mergedLastEvents`가 fresh `detectedAnomalyMarkets`와 merge되므로 cross-day 전파는 방지됨. 당일 내 cycleScore만 stale.

**실질 영향 낮음** (cycleScore는 하루 단위 선정에만 사용, 선정 결과가 당일 내 변경되지 않음).

---

### m4: Pool seeding 마켓 — 이벤트 없으면 영구 보존

**파일**: `scripts/anomaly-variants-sim.ts`

첫 실행 시 top-30으로 seed한 경우 `candidateMarketLastEvents = {}`:
```typescript
const retained = [...poolSet].filter(market => {
  const lastTs = mergedLastEvents[market];
  if (lastTs === undefined) return true; // ← 이벤트 기록 없으면 무조건 유지
  return lastTs >= poolRemovalCutoff;
});
```

첫 실행 seed 마켓 중 한 번도 anomaly가 없는 코인은 `lastTs === undefined` 상태로 45일이 지나도 제거되지 않음.

**실질 영향 낮음** (해당 코인들은 volume 상위권이므로 backtracking 갱신 시 자연 교체됨. 단, 이론적으로 pool leak).

---

### m5: `backtest.ts` — `tradeCount`가 round trip의 2배

**파일**: `src/simulation/backtest.ts`

```typescript
tradeCount: trades.length,  // buy 레코드 + sell 레코드 합산
```

`winRate`는 `roundTripReturns.length` 기준 (= round trip 횟수). 하지만 `tradeCount`는 2배.

예: 5회 매매 = `tradeCount: 10`, `winRate`의 분모 = 5.

콘솔 로그나 UI에서 "trades:10 → 10번 매매"로 오해 가능.

---

## ⚪ Cosmetic

### c1: `isNewSelection` 조건식 — 과도한 라인 길이

**파일**: `scripts/anomaly-variants-sim.ts` line 897

```typescript
const isNewSelection = cachedSelection?.date !== today || !Array.isArray(cachedSelection?.markets) || cachedSelection?.source !== "1m-7d-backtracking" || cachedSelection?.monitoringMarketCount !== MONITORING_MARKET_COUNT;
```

200자 이상. 가독성 저하.

---

### c2: 함수명 불일치

- `anomaly-variants-sim.ts`: `sumRecentQuoteValue(candles, count)`
- `src/simulation/traderOptimization.ts`: `sumRecentTradeValue(candles, lookbackCandles)`

동일 로직, 다른 이름. 통일 권장.

---

### c3: `anomaly.ts` — `extendedMove` 파라미터명 혼란

```typescript
extendedMove: rateOfChange(closes, scenario.params.volumeLookback),
```

`extendedMove`(가격 ROC)를 계산하는데 `volumeLookback`(=48) 파라미터를 사용.
별도 파라미터(`extendedMoveLookback` 등)로 분리하거나 주석 추가 권장.

---

## ✅ 이전 이슈 유지 확인

| 항목 | 상태 |
|------|------|
| `perCoinParams` 날짜 변경 시 리셋 | ✅ 정상 |
| `backtestD` 진입 조건 정렬 (volR≥3.5, breaksHigh, !isTooExtended) | ✅ 정상 |
| Pool 누적 로직 (Union + 45일 제거) | ✅ 정상 |
| `cycleScore` 계산 (21–45일 prime window) | ✅ 정상 |
| WeakMap EMA 캐시 적용 | ✅ 정상 |
| binary search (`findLastIndexAtOrBefore`) | ✅ 정상 |
