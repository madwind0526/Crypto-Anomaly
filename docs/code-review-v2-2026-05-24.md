# Code Review v2 — Crypto-Anomaly

리뷰 일자: 2026-05-24 (수정 후 재검토)

---

## 요약

v1 리뷰에서 지적한 **Critical 3건 / Major 4건** 이슈가 모두 올바르게 수정되었습니다. 새 Critical 이슈는 없습니다. 다만 수정 과정에서 기존에 존재하던 두 가지 Major 이슈가 미처 포함되지 않았으며, Minor 이슈도 몇 가지 남아 있습니다.

---

## ✅ 수정 확인 (v1 이슈)

| # | 파일 | 이슈 | 상태 |
|---|------|------|------|
| 1 | `src/simulation/backtest.ts` | 청산 후 같은 캔들 재매수 방지 (`continue` 추가) | ✅ 수정됨 |
| 2 | `src/strategies/anomaly.ts:93` | `Math.max(...spread)` → `reduce` 교체 | ✅ 수정됨 |
| 3 | `scripts/anomaly-variants-sim.ts` | `backtracking1mPath` readFile try-catch 추가 | ✅ 수정됨 |
| 4 | `scripts/anomaly-variants-sim.ts:190` | warmup 조건 `< 70` → `< 100` 상향 | ✅ 수정됨 |
| 5 | `src/guideRules/evaluator.ts` | EMA WeakMap 캐시 추가 (O(n²) → O(n)) | ✅ 수정됨 |
| 6 | `src/simulation/safety.ts` | `getDailyReturnAtCandleIndex` 이진 탐색 교체 | ✅ 수정됨 |
| 7 | `src/simulation/paperTrading.ts` | `resolveOptions` 단일 소스 정리 | ✅ 수정됨 |

---

## 심각도별 잔여 이슈

### 🟠 Major (권장 수정)

**1. `anomaly-variants-sim.ts` — 날짜 변경 시 `perCoinParams` 미초기화**

`perCoinParams`는 모듈 레벨 전역 변수입니다. `initDailyState()`는 날짜별 캐시를 확인하지만, 날짜가 바뀌어 캐시 miss가 발생해도 **`perCoinParams`를 `{}`로 초기화하지 않습니다**.

```typescript
// 현재 코드 (anomaly-variants-sim.ts ~824)
if (Object.keys(perCoinParams).length === 0) {
  // 최적화 실행
}
```

문제 흐름:
1. 첫째 날: `perCoinParams`가 비어 있어 최적화 → 결과 저장
2. 날짜 변경: 캐시 파일의 `date !== today` → 캐시 로드 건너뜀
3. 하지만 전역 `perCoinParams`는 여전히 전날 데이터로 채워져 있음
4. `Object.keys(perCoinParams).length > 0` → 최적화 건너뜀 (버그!)
5. **결과**: 둘째 날은 전날 파라미터로 계속 실행됨

**수정 방안**: `initDailyState()` 시작 시 `perCoinParams = {};` 로 초기화한 뒤 캐시를 읽음.

---

**2. `scripts/optimize-params.ts` — `backtestD` 진입 조건이 실제 전략과 불일치**

`backtestD` (optimize-params.ts:262)의 진입 조건:
```typescript
if (volR >= 3.0 && roc3 >= accelerationMin && candles[i].close > candles[i].open)
```

실제 `anomalyStrategy.decide()` (anomaly.ts:96)의 진입 조건:
```typescript
if (relativeVolume >= scenario.params.relativeVolumeMin  // 기본 3.5
    && isAccelerating
    && breaksHigh    // 24봉 고점 돌파
    && !isTooExtended)
```

불일치 포인트:
- `volR >= 3.0` vs 실제 기본값 `3.5`
- `close > open` (단순 양봉) vs `breaksHigh` (24봉 고점 돌파)
- `!isTooExtended` 조건 없음

최적화 결과로 선택된 `accelerationMin`이 실제 전략 진입 필터와 다른 환경에서 튜닝되므로, 파라미터의 라이브 전이 효과가 낮을 수 있습니다.

**수정 방안**: `backtestD`의 진입 조건을 `anomalyStrategy.decide()`의 실제 조건과 일치시킴. `relativeVolumeMin`을 3.5로, `breaksHigh` 로직을 추가, `isTooExtended` 체크 추가.

---

### 🟡 Minor (개선 권장)

**3. warmup 임계값 불일치**

- 백트래킹 감지: `recent24h.length < 70` (수정 전 값 그대로)
- 라이브 감지: `< 100` (v1에서 수정됨)

같은 감지 함수(`detect1m`)를 쓴다면 두 경로의 워밍업 임계값을 맞추는 것이 일관성에 좋습니다. 현재는 백트래킹 쪽만 70봉으로 진입이 더 일찍 허용됩니다.

**파일**: `scripts/anomaly-variants-sim.ts` — `selectAnomalyMarkets` 또는 `detect1m` 호출부

---

**4. `src/app/App.tsx` — 구형 UI 문자열**

- **Line 716**: `"hist5m 90일 스캔 (10%/3×) + live 1m 24h → union. 마지막 특이점 후 45일 초과 시 제거."` — 현재 시스템은 hist5m이 아닌 `1m 7일` 백트래킹을 사용하며 제거 기준도 다를 수 있음.
- **Line 1319**: `"Top 30 → 12"` — 실제로는 30개 후보에서 **9개**를 선택하므로 `"Top 30 → 9"`로 표시 필요.

---

**5. `scripts/optimize-params.ts:286` — `MIN_TRADES = 1` 과적합 위험**

```typescript
const MIN_TRADES = 1;  // 최소 1회 거래
```

단 1회 거래만으로도 최적 파라미터로 선택됩니다. 특이점 시장은 저빈도이지만, 단일 거래의 운에 의해 극단적인 파라미터(예: trail=0.040, maxHold=20)가 선택될 수 있습니다. `MIN_TRADES = 2`가 제외 시장을 너무 많이 만든다면, 단일 거래인 경우 기본 파라미터 유지(`keep defaults`) 로직이 명시적으로 적용되어 있으므로 현 상태는 허용 가능합니다만, 팀이 알고 있어야 할 설계 트레이드오프입니다.

---

## 파일별 현황 요약

| 파일 | Critical | Major | Minor | 상태 |
|------|:--------:|:-----:|:-----:|------|
| `src/simulation/backtest.ts` | 0 | 0 | 0 | ✅ 클린 |
| `src/strategies/anomaly.ts` | 0 | 0 | 0 | ✅ 클린 |
| `src/guideRules/evaluator.ts` | 0 | 0 | 0 | ✅ 클린 |
| `src/simulation/safety.ts` | 0 | 0 | 0 | ✅ 클린 |
| `src/simulation/paperTrading.ts` | 0 | 0 | 0 | ✅ 클린 |
| `scripts/anomaly-variants-sim.ts` | 0 | 1 | 1 | 🟠 수정 권장 |
| `scripts/optimize-params.ts` | 0 | 1 | 1 | 🟠 수정 권장 |
| `src/app/App.tsx` | 0 | 0 | 1 | 🟡 미용 수정 |
