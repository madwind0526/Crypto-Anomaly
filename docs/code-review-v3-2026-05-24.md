# Code Review v3 — Crypto-Anomaly

리뷰 일자: 2026-05-24 (Major 2건 수정 후 재검토)

---

## 요약

v2 리뷰에서 지적한 **Major 2건** 모두 올바르게 수정되었으며, **새로운 Critical / Major 이슈 없음**. Minor 수준 관찰 사항 2건만 남아 있습니다.

---

## ✅ 수정 확인

### Fix 1: `perCoinParams` 날짜 변경 시 리셋
**파일**: `scripts/anomaly-variants-sim.ts` ~line 783

매 사이클마다 `perCoinParams = {};`로 초기화한 뒤 캐시를 읽으므로:
- 새로운 날짜 → 캐시 miss → `Object.keys(perCoinParams).length === 0` 조건 발동 → 정상 최적화 실행
- 같은 날짜 캐시 hit → `perCoinParams`에 올바르게 재로드
- loop overlap guard가 있으므로 사이클 간 race condition 없음

**결론: ✅ 수정 정상**

---

### Fix 2: `backtestD` 진입 조건 정렬
**파일**: `scripts/optimize-params.ts` ~line 263–268

| 조건 | `anomalyStrategy.decide()` | `backtestD` (수정 후) | 상태 |
|------|--------------------------|----------------------|------|
| `relativeVolumeMin >= 3.5` | ✓ (anomaly.ts:96) | ✓ `volR >= 3.5` | ✅ 일치 |
| `isAccelerating` (roc3 >= accelerationMin) | ✓ accelerationLookback=3 | ✓ `roc3` = (close[i] - close[i-3]) / close[i-3] | ✅ 일치 |
| `breaksHigh` (24봉 고점 돌파) | ✓ (anomaly.ts:93-94, reduce) | ✓ `prevHigh` reduce + `i < 24` guard | ✅ 일치 |
| `!isTooExtended` (roc48 < 0.18) | ✓ (anomaly.ts:92, volumeLookback=48) | ✓ `ind.roc48[i] >= 0.18` | ✅ 일치 |

`roc3` 계산 방식은 `anomaly.ts`의 `rateOfChange(closes, accelerationLookback=3)`와 수학적으로 동일합니다.

**결론: ✅ 수정 정상**

---

## 추가 검증

- `src/simulation/backtest.ts` — risk exit 후 `continue` (v1 수정) 여전히 정상
- `backtestA / B / C` vs `decideA / B / C` — 진입 조건 불일치 없음
- `perCoinParams` 블렌딩 로직 (`blendOptimizedParams`) — 정상

---

## 잔여 이슈

### 🟡 Minor

**1. `computeInd`에서 D 전략이 사용하지 않는 필드 계산**

`scripts/optimize-params.ts` — `Ind` 구조의 `bodies`, `topRatio`는 전략 A/B/C에만 쓰이고, `backtestD`는 사용하지 않습니다. 성능 영향은 미미하지만, 향후 전략이 추가되면 혼란의 소지가 있습니다. 필요 시 `computeInd`를 필드별로 lazy하게 분리하거나 주석으로 명시하면 됩니다.

**2. 캐시 소스 접두사 필터링**

`scripts/anomaly-variants-sim.ts` ~line 785:
```typescript
optimizedCache.source.startsWith("1m-7d-backtracking")
```
`"1m-7d-backtracking"` 과 `"1m-7d-backtracking+24h-refit"` 두 값 모두 통과합니다. 현재 저장 로직이 이 두 값만 생성하므로 실질적 문제는 없습니다. 다만 미래에 다른 source가 추가될 경우 의도치 않게 통과될 수 있으므로, 명시적인 set 비교로 전환하면 더 안전합니다.

---

## 전체 이슈 현황 요약

| 리뷰 | Critical | Major | Minor | 상태 |
|------|:--------:|:-----:|:-----:|------|
| v1 (초기) | 3 | 4 | 9 | ✅ 전체 수정 완료 |
| v2 (수정 후) | 0 | 2 | 3 | ✅ Major 수정 완료 |
| v3 (현재) | 0 | 0 | 2 | ✅ 신규 이슈 없음 |
