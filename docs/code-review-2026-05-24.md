# Code Review — Crypto-Anomaly

리뷰 일자: 2026-05-24

---

## 요약

전체적으로 구조가 명확하고 관심사 분리가 잘 되어 있습니다. esbuild 번들 → ESM 동적 import 방식의 실행 체계, WeakMap 기반 인디케이터 캐시, 루프 중복 실행 방지(overlap guard) 등은 설계 수준이 높습니다. 그러나 몇 가지 Critical/Major 이슈가 존재합니다. 특히 `backtest.ts`의 포지션 청산 후 같은 캔들에서 재매수 가능 문제, `anomaly.ts`의 `Math.max(...spread)` 위험, `backtracking1mPath` 읽기 시 예외 미처리가 즉시 수정이 필요한 영역입니다. 성능 면에서는 `evaluator.ts`의 EMA 매 캔들 재계산과 `safety.ts`의 O(n) 선형 탐색이 잠재적 병목입니다.

---

## 심각도별 이슈

### 🔴 Critical (즉시 수정 필요)

**1. backtest.ts — 청산 후 같은 캔들에서 재매수 가능 (더블-트레이드 위험)**

`runBacktest` 루프에서 stopLoss/trailingStop/takeProfit으로 포지션을 청산한 직후, 같은 캔들에서 `strategy.decide()`를 호출합니다. `position`이 `null`이 되었으므로 전략이 새 매수 신호를 낼 수 있습니다. 실제 시장에서는 불가능한 시나리오이며 백테스트 결과가 과낙관적으로 왜곡됩니다.

```typescript
// 청산 발생
if (takeProfitHit || trailingStopHit || stopLossHit) {
  closePosition(exitPrice, ...);  // position = null
}
// 같은 캔들에서 즉시 결정 → 새 매수 신호 가능
const decision = strategy.decide({ ..., position, ... });
```

**2. anomaly.ts:93 — `Math.max(...array.slice(...))` 스프레드 스택 오버플로 위험**

```typescript
const breaksHigh = current.close >= Math.max(...indicators.closes.slice(Math.max(0, candleIndex - 24), candleIndex));
```

현재는 최대 24개이므로 안전하지만, 향후 범위 계산 오류 또는 파라미터 변경 시 수만 개 원소에 대해 spread 적용 → 스택 오버플로 가능. `reduce`로 교체 권장.

**3. anomaly-variants-sim.ts:765 — backtracking 파일 읽기 try-catch 없음**

```typescript
const rawBacktracking = JSON.parse(await readFile(backtracking1mPath, "utf8"));
// try-catch 없음 — 파일 미존재 시 runCycle 전체 crash
```

live1m 로드는 try-catch 처리되어 있는데 backtracking은 bare `readFile`로 파일이 없으면 루프 사이클 전체가 실패합니다.

---

### 🟠 Major (중요하지만 운영 가능)

**4. anomaly-variants-sim.ts:190 — `liveEventCount` 항상 0인 근본 원인**

```typescript
const recent24h = candles.filter(c => c.timestamp >= oneDayAgo);
if (recent24h.length < 70) continue;  // warmup = 60 + 10 = 70
const events = detect1m(market, recent24h);
```

`detect1m`의 warmup이 정확히 70이므로 `length === 70`이면 루프가 한 번도 실행되지 않습니다. PROGRESS.md에 미해결로 기록된 문제의 근본 원인. 조건을 `< 100` 이상으로 상향 필요.

**5. paperTrading.ts — `resolveOptions`의 guideRuleMode/autoBlockMode 이중 소스**

`guideRuleMode`와 `autoBlockMode`가 `PaperTradingOptions` 최상위와 `BacktestConfig` 내부 두 곳에 존재합니다. `options.config.guideRuleMode`만 전달하면 무시되며, 두 엔진(backtest vs paperTrading)이 미묘하게 다른 결과를 낼 수 있습니다.

**6. safety.ts — `getDailyReturnAtCandleIndex`의 O(n) 선형 탐색**

```typescript
const first = candles.find((item) => item.timestamp >= dayStart && item.timestamp <= candle.timestamp);
```

캔들이 정렬되어 있으므로 이진 탐색이 맞지만 `Array.find`는 선형 탐색입니다. paperTrading 루프에서 종목 수 × 타임스탬프 수만큼 반복 호출되어 성능 저하 유발.

**7. guideRules/evaluator.ts — EMA 계산이 매 캔들마다 전체 배열 재실행**

```typescript
export function evaluateMovingAverages(candles: Candle[], candleIndex: number) {
  const closes = candles.map((candle) => candle.close);
  const short = ema(closes, 10);   // 전체 candles 배열마다 3회 계산
  const medium = ema(closes, 50);
  const long = ema(closes, 100);
```

`evaluateGuideRules`는 백테스트 루프 내 매 캔들마다 호출됩니다. `anomaly.ts`처럼 WeakMap 캐시 적용 필요. 현재 구조는 종목 수 × 캔들 수 × EMA 계산 = O(n²) 복잡도.

**8. optimize-params.ts — `closePos` 수수료 계산 방식이 backtest.ts와 불일치**

`optimize-params.ts`는 `cash * (1 + returnRate)` 방식, `backtest.ts`는 `proceeds - fee - entryCost` 방식으로 수익률을 계산합니다. 동일 파라미터로도 두 엔진이 다른 결과를 내므로 optimizer의 결과와 실제 paper trading 결과가 일관되지 않을 수 있습니다.

**9. anomaly-variants-sim.ts — `isNewSelection` 플래그가 실제 파일 쓰기와 불일치**

`isNewSelection`이 `false`여도 `selectionPath`는 항상 덮어쓰입니다. 플래그는 console.log 출력 여부만 제어하는데, 로그 메시지와 실제 동작이 불일치하여 혼란을 줄 수 있습니다.

---

### 🟡 Minor (개선 권장)

**10. anomaly.ts — `extendedMove`가 `volumeLookback` 파라미터로 계산**

```typescript
extendedMove: rateOfChange(closes, scenario.params.volumeLookback),
```

파라미터 이름 `volumeLookback`이 `extendedMove` 계산에 사용되는 것은 의미론적 불일치. `extendedMoveLookback` 등 별도 파라미터로 분리 권장.

**11. anomaly-variants-sim.ts — `perCoinParams` 날짜 변경 시 명시적 클리어 없음**

전역 mutable 상태인 `perCoinParams`는 날짜 변경 시 `optimizedCache?.date === today` 조건으로 간접 초기화되지만, 명시적으로 `perCoinParams = {}`를 하지 않아 엣지 케이스에서 이전 날 값이 혼입될 수 있습니다.

**12. anomaly-variants-sim.ts — `medianMove` 짝수 배열 처리 미흡**

```typescript
const medianMove = moves[Math.floor(moves.length / 2)];
```

짝수 길이일 때 상위 중앙값만 취합니다. 고빈도 펌프가 많은 날 편향 발생. 두 중간값 평균 처리 권장.

**13. optimize-params.ts — `MIN_TRADES = 1` 과적합 위험**

단 1개 거래만 있어도 최적 파라미터로 인정. 특이점 종목은 저빈도라 불가피하지만, `trades < 2`면 가중치를 낮추는 방어 로직 권장.

**14. fetch-anomaly-1m.mjs — 매 실행마다 24h 전체 재다운로드**

`UPBIT_LOOKBACK_DAYS` 기본값 `"1"`(24h). 루프 모드에서 60초마다 실행되므로 매번 24h치 전체를 재다운로드합니다. 증분 업데이트 방법이 없어 불필요한 네트워크 부하.

**15. paperTrading.ts — `equityCurve` 마지막 타임스탬프 중복 삽입 가능성**

루프 마지막 반복에서 `equityCurve.push`가 실행된 후, 열린 포지션 청산 시 같은 타임스탬프로 다시 push됩니다. 마지막 항목이 중복될 수 있습니다.

**16. App.tsx — `compareStrategies` 첫 로드 시 UI 블로킹**

`dashboardResults`가 없을 때 `compareStrategies(...)`를 동기 계산합니다. 전 종목 × 전 시나리오 백테스트이므로 브라우저가 수 초간 블로킹됩니다.

---

### 🟢 Positive (잘된 점)

1. **루프 중복 실행 방지**: `running` 플래그로 이전 사이클이 실행 중이면 새 tick을 건너뜁니다.
2. **WeakMap 기반 인디케이터 캐시**: `anomaly.ts`와 `anomaly-variants-sim.ts` 양쪽에서 같은 Candle[] 참조를 공유해 재계산 없이 결과를 반환. `slicedBacktracking`으로 동일 참조를 만드는 설계가 세심합니다.
3. **타입 안전성**: `StrategyDecision`, `BacktestResult` 등 핵심 구조체에 TypeScript 타입이 일관되게 적용.
4. **이진 탐색 `findLastIndexAtOrBefore`**: paperTrading의 타임스탬프 탐색에 이진 탐색 사용.
5. **blendOptimizedParams 70/30 weighting**: 이전 파라미터와 24h refit 혼합으로 과적합 완화. 정수형 파라미터(`maxHoldCandles`)에 `Math.round` 적용하는 세심함.
6. **에러 비전파 설계**: live1m fetch 실패, backtest 예외 등을 적절히 catch하고 fallback 제공.
7. **날짜 전환 시 일간 로그 기록**: KST 날짜 변경 감지 → 전날 결과 자동 append.
8. **fetch-upbit-market-data.mjs 재시도/백오프**: `Retry-After` 헤더 파싱 + 지수 백오프 + 지터 조합.

---

## 파일별 상세

### scripts/anomaly-variants-sim.ts

| 위치 | 이슈 |
|------|------|
| Line 765 | `readFile(backtracking1mPath)` — try-catch 없음 (Critical) |
| Line 190 | `recent24h.length < 70` warmup 조건 미달 가능 (Major) |
| Line 871 | `medianMove` 짝수 처리 미흡 (Minor) |
| 전역 | `perCoinParams` 날짜 변경 시 명시적 클리어 없음 (Minor) |
| Line 910 | `isNewSelection` 플래그와 실제 파일 쓰기 불일치 (Minor) |

### scripts/fetch-anomaly-1m.mjs

- 구조 단순 명확, 오류 처리 양호.
- 매 실행마다 24h 전체 재다운로드 — 증분 업데이트 없음 (Minor).

### src/strategies/anomaly.ts

- Line 93: `Math.max(...spread)` — `reduce` 교체 권장 (Critical).
- `extendedMove`/`volumeLookback` 파라미터명 의미 불일치 (Minor).
- `decide()`의 exit 로직이 backtest 레이어와 paperTrading 레이어에 분산 — 일관성 검토 필요.

### src/simulation/paperTrading.ts

- `resolveOptions` guideRuleMode/autoBlockMode 이중 소스 (Major).
- `equityCurve` 마지막 타임스탬프 중복 (Minor).
- `getDailyReturnAtCandleIndex` O(n) 탐색 (Major).

### src/simulation/optimizer.ts

- 구조 단순 명확.
- `scoreBacktestResult` 가중치에 대한 근거 문서 없음.
- `backtest.ts`와 수수료 계산 방식 불일치 (Major).

### src/guideRules/evaluator.ts

- EMA 매 캔들마다 전체 배열 재계산 — WeakMap 캐시 필요 (Major).

### src/simulation/safety.ts

- `getDailyReturnAtCandleIndex` O(n) 선형 탐색 (Major).
- 임계값 근거 문서 없음.
- 전체적으로 간결하고 이해하기 쉬움.

### src/data/marketData.ts

- `loadDashboardMarketData`가 5m 파일 폴백 → anomaly 프로젝트에서 해당 파일 부재 시 sample data 사용. 의도적이지만 혼란 가능.

---

## 개선 제안 요약

| 우선순위 | 파일 | 내용 |
|---------|------|------|
| 🔴 Critical | `backtest.ts` | 청산 후 같은 캔들 재매수 방지 — 청산 발생 시 해당 캔들 결정 skip |
| 🔴 Critical | `anomaly.ts:93` | `Math.max(...spread)` → `reduce` 교체 |
| 🔴 Critical | `anomaly-variants-sim.ts:765` | `readFile(backtracking1mPath)` try-catch 추가 |
| 🟠 Major | `anomaly-variants-sim.ts:190` | `liveEventCount=0` 원인 — warmup 조건 `< 100` 이상으로 상향 |
| 🟠 Major | `paperTrading.ts` | `guideRuleMode`/`autoBlockMode` 단일 소스로 통합 |
| 🟠 Major | `safety.ts` | `getDailyReturnAtCandleIndex` 이진 탐색 교체 |
| 🟠 Major | `evaluator.ts` | EMA 계산 WeakMap 캐시 추가 |
| 🟠 Major | `optimize-params.ts` | `backtest.ts`와 수수료 계산 방식 통일 |
| 🟡 Minor | `anomaly-variants-sim.ts` | `perCoinParams` 날짜 변경 시 명시적 클리어 |
| 🟡 Minor | `optimize-params.ts` | `MIN_TRADES=1` 과적합 방지 조건 추가 |
| 🟡 Minor | `anomaly.ts` | `extendedMove`/`volumeLookback` 파라미터명 분리 |
