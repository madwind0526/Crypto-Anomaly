# Rules

> Wave 1–4 확정 — 2026-05-28
> 모든 구현 결정은 이 원칙을 우선한다.

---

## R-01. 특이점 감지 기준 (확정)

**규칙:** 아래 두 조건을 동시에 만족해야 특이점 이벤트로 기록한다.
```
조건 1: 10분 내 (max_high - min_low) / min_low > 10%
조건 2: 10분 거래대금 > 직전 1시간 평균 10분 거래대금의 3배
쿨다운: 2시간 (동일 이벤트 중복 감지 방지)
```
**캔들 단위별 구현:**
- 5m 캔들: 2캔들 윈도우, 12캔들 1시간, 24캔들 쿨다운
- 1m 캔들: 10캔들 윈도우, 60캔들 1시간, 120캔들 쿨다운
**볼륨 비교:** `windowVol / (prevHourTotal / hourCandles)` (per-candle avg 기준)

---

## R-02. Pool 누적 및 제거 규칙

**규칙:** candidateMarkets pool은 매일 누적만 하고, 45일 미발생 시에만 제거한다.
```
매일 00:00 KST:
  1. 전날 pool 로드 (anomaly-selection.json candidateMarkets)
  2. 7일 1m backtracking으로 새로 감지된 종목 추출
  3. Union: 전날 pool ∪ 새 종목 (중복 제거, 갯수 무관)
  4. 제거: candidateMarketLastEvents 기준 45일 초과된 종목만 제거
  5. Pool에서 top 9 선정 → 페이퍼 트레이딩
  6. 나머지는 monitoring list 유지
```
**근거:** Gap 분포 p50=2.5일, p90=32.7일, max=72일. 45일 제거 = 반복 이벤트 95% 커버.
**코드:** `POOL_REMOVAL_DAYS = 45` (scripts/anomaly-variants-sim.ts)

---

## R-03. 첫 실행 시 초기 시드

**규칙:** pool이 비어 있으면 KRW 전체 종목 중 거래량 상위 30개로 초기화한다.
**이유:** 처음에 참고할 특이점 히스토리가 없기 때문.

---

## R-04. 데이터 파이프라인 실행 순서

**규칙:** 아래 순서를 반드시 지킨다.
```
1. fetch:anomaly:1m:backtracking  → data/market/ 갱신
2. sim:anomaly                    → anomaly-selection.json + dashboard-results.json 갱신
3. (선택) ws:live                 → ws-live-results.json 갱신
4. (선택) live:dry / live         → anomaly-live-trade-status.json 갱신
```
**이유:** sim이 fetch 결과를 읽고, UI가 sim 결과를 읽으며, ws/live는 selection에 의존.

---

## R-05. 파라미터 적응 (일일 refit)

**규칙:** 매일 00:00 KST에 전일 특이점 이벤트 medianMove 기준으로 trailingStop/maxHold를 자동 조정한다.
- 직전 24h 데이터가 부족하면 refit 생략 (base 파라미터 유지)
- 블렌딩: `newParam = 0.7 * prevParam + 0.3 * prev24hParam`

---

## R-06. 전략 ID ↔ traderId 매핑

**규칙:** 전략 레이블과 내부 traderId는 항상 아래 대응 관계를 유지한다.

| 전략 레이블 | traderId | 이름 |
|------------|----------|------|
| Anomaly-A | `momentum` | Calm Impulse |
| Anomaly-B | `range-grid` | First Explosion |
| Anomaly-C | `arbitrage` | Confirmed Burst |
| Anomaly-D | `anomaly` | Sweep Best |

---

## R-07. Guideline/Safety Case 4가지

**규칙:** 모든 전략의 paper trading 결과는 아래 4 case로 저장한다.
```
strict   / enabled  (Guideline O, Safety O)
strict   / disabled (Guideline O, Safety X)
ignored  / enabled  (Guideline X, Safety O)
ignored  / disabled (Guideline X, Safety X)
```
**이유:** 필터 효과를 독립적으로 측정하기 위해.

---

## R-08. D 전략 — Spike Retracement (2026-06-04 변경)

**규칙:** Anomaly-D는 스파이크 발생 후 눌림목에서 재진입하는 전략이다. 전 경로(sim/optimize/live/ws) 동일 기준:

```
스파이크 감지: body ≥ 2.5%, vol ≥ 3.5×, 양봉 (최근 30봉 스캔)
스파이크 고점: 스파이크 봉 + 직후 3봉 범위의 최고 high
눌림목 진입:   retracePctMin(기본 3%) ≤ (spikeHigh − close) / spikeHigh ≤ 10%
거래량 확인:   curVol ≥ 1.5× (아직 뜨거움)
회복 확인:     close > open (양봉)
```

**최적화 파라미터:** `trailingStopPct`, `maxHoldCandles`, `retracePctMin`
**기본값:** trail=0.022, maxHold=12, retracePctMin=0.030

**이전 전략(Sweep Best) 대비 변경 이유:**
- Sweep Best는 스파이크 중후반에 진입 → 정점 매수 + volume-fade 즉시 청산 패턴
- Retracement는 눌림목 진입 → 진입가 낮음 + 2차 상승 노림

---

## R-09. UI 기본값

**규칙:** Daily 운영 화면의 기본 모드는 아래와 같다.
- Guideline 기본값: `"ignored"`
- Safety 기본값: `"enabled"`
- 이유: 특이점 종목에서는 Guide 룰이 진입을 과도하게 차단하는 것으로 검증됨.
