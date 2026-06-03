# Crypto-Anomaly

Upbit KRW 시장에서 **특이점(Anomaly) 종목**을 자동 선별하고, 4가지 전략으로 페이퍼 트레이딩 시뮬레이션 및 실시간 모의/실거래를 실행하는 도구입니다.

---

## 핵심 아이디어

> "한번 튄 종목은 특이점 유형의 코인이다. 잊혀질 만큼 시간이 지나면 다시 튄다."

과거 데이터 분석에서 다수 종목이 3회 이상 반복 신호를 보임으로써 가설이 지지됩니다. 특이점 발생 주기(gap) 분포는 p50≈2.5일, p90≈32.7일이며, **21~45일 구간**이 재발 확률이 가장 높은 prime window입니다.

---

## 특이점 감지 기준

```
조건 1: 10분 내 가격 변동 (max_high - min_low) / min_low > 10%
조건 2: 10분 거래대금 > 직전 1시간 평균 10분 거래대금의 3배
쿨다운: 2시간 (같은 이벤트 중복 감지 방지)
```

---

## 4가지 전략

모든 전략은 **동일한 감시 종목 리스트**를 공유하며, 진입 타이밍·보유 방식만 다릅니다.

| 전략 | 이름 | 진입 조건 | Hold | Trailing |
|------|------|---------|------|---------|
| **A** | Calm Impulse | 15봉 조용한 구간 후 첫 충동 (avgBody < 0.5%, curBody ≥ 1.5%, vol ≥ 1.5×) | 12봉 | 2.8% |
| **B** | First Explosion | 폭발 캔들 직접 진입 (body ≥ 2.5%, vol ≥ 3.5×, topRatio ≥ 60%, 3봉 선행 조용함) | 6봉 | 1.8% |
| **C** | Confirmed Burst | 폭발 다음 봉에서 확인 후 진입 (prevExplosion + curVol ≥ 1.8×) | 8봉 | 2.2% |
| **D** | Sweep Best | 가속 + 거래량 스파이크 기반 (anomaly baseline) | 12봉 | 1.8% |

> 각 전략의 `trailingStop` / `maxHoldCandles` 등은 종목별로 grid search 최적화된 값이 주입됩니다(아래 종목 선택 로직 참고).

---

## 종목 선택 로직

매일 00:00 KST에 1회 실행 후 `anomaly-selection.json`에 캐시되며, 같은 날에는 풀이 유지됩니다.

1. **거래량 상위 30개 후보 선정** — 전체 KRW 마켓 중 **가격 100~10,000원** 범위 + 24h 거래대금 상위 30개
2. **특이점 스캔** — 1m 7일 백트래킹 + live 1m 최근 24h 스캔으로 특이점 발생 종목 추출
3. **풀 누적(Union)** — 이전 풀 ∪ 신규 감지 종목 (날짜가 바뀌어도 누적 유지)
4. **풀 제거** — 가격 범위를 벗어났거나, 마지막 특이점 발생 후 **45일** 초과한 종목 제거
5. **종목별 파라미터 최적화** — 전날 1m 데이터로 grid search → 전략별 최적 파라미터 저장
6. **top-15 선정** — `cycleScore`(특이점 주기 점수, 21~45일 = 1.0) → 백테스트 수익률 → 거래대금 순으로 정렬해 전략별 상위 15개 모니터링
7. 선택된 종목을 4개 전략이 공통으로 모니터링 (Guideline O/X × Safety O/X 4케이스 동시 시뮬레이션)

---

## 현실적 비용 모델

시뮬레이션과 페이퍼 트레이딩은 Upbit 호가 단위 기반 **동적 슬리피지**를 적용합니다.

```
단방향 슬리피지 = 1 tick / price   (시장가 주문이 최우선 호가에 체결된다고 가정)
예) 100원 코인 → 0.1원/100원 = 0.1%,  1,000원 코인 → 5원/1,000원 = 0.5%
수수료: 매수·매도 각 0.05%
```

---

## 시작 방법

### 첫 실행

```bash
# 1. 7일 1m 백트래킹 데이터 수집 (거래량 상위 30개)
npm run fetch:anomaly:1m:backtracking

# 2. 종목 선택 + 파라미터 최적화 + 시뮬레이션
npm run sim:anomaly

# 3. UI 확인
npm run dev
```

### 일일 운영 (루프 모드)

```bash
# 60초 간격 자동 실행 (1m 데이터 자동 fetch 포함)
npm run sim:anomaly:loop

# 또는 watchdog으로 자동 재시작 관리 (권장)
npm run sim:anomaly:watchdog
```

루프 모드는 매 사이클마다 `fetch:anomaly:1m`을 자동 실행하며, 00:00 KST에 종목 선택과 파라미터 최적화를 자동으로 수행합니다.

### 일일 롤오버 (00:00 KST 재최적화)

```bash
# 어제 데이터로 재최적화 + 파라미터 평활화 (이전 70% + 신규 30%)
npm run rollover

# 파라미터 계산만 (파일 저장 없음)
npm run rollover:dry
```

롤오버는 급격한 파라미터 점프를 방지하기 위해 이전 파라미터 70% + 신규 30%로 가중 혼합하며, 종목별 결과를 `data/local/anomaly-market-params/`에 저장합니다.

---

## Live Trading (모의/실거래)

`.env`에 Upbit API 키를 설정하면 실시간 WebSocket 기반 매매를 실행할 수 있습니다.

```bash
# .env 예시
UPBIT_ACCESS_KEY=your_key
UPBIT_SECRET_KEY=your_secret
LIVE_TRADING_ENABLED=true      # 실제 주문을 보내려면 필요
LIVE_BUDGET=1000000            # 총 운용금액
LIVE_MAX_POSITIONS=15          # 최대 동시 포지션 수
```

```bash
# Dry-run — 실제 주문 없이 신호만 시뮬레이션 (API 키 있으면 실잔고 표시)
npm run live:dry

# 실거래 — 실제 시장가 주문 실행 (LIVE_TRADING_ENABLED=true 필요)
npm run live
```

- **전략 자동 선택**: 백트래킹 평균 수익률이 가장 높은 전략(A/B/C/D)을 자동 채택
- **잔고 표시**: API 키가 있으면 Upbit 실제 보유자산(총 매수/총 평가/보유 현금)을 그대로 사용
- **틱 레벨 trailing stop**: 분봉 마감 전에도 즉시 손절
- **비상 정지**: `data/local/live-trading-disabled.flag` 파일 생성 시 신규 매수 차단
- **상태 표시**: UI 좌측 메뉴 **Live Trade** 탭에서 포지션·거래내역·손익 실시간 확인

> ⚠️ `npm run live`는 실제 자산으로 거래합니다. 충분히 dry-run으로 검증한 뒤 사용하세요.

---

## 데이터 파일

```
data/market/
  upbit-krw-1m-anomaly-backtracking.json  ← 7일 1m 백트래킹 데이터 (상위 30개)
  upbit-krw-1m-anomaly.json               ← 선택 종목 live 1m 데이터

data/local/                               ← 런타임 상태 (git 미추적)
  anomaly-live-trader-state.json          ← live trader 포지션/거래 상태
  anomaly-market-params/                  ← 롤오버 종목별 파라미터

public/market/
  anomaly-selection.json                  ← 당일 선택 종목 + 적응 파라미터
  anomaly-optimized-params.json           ← 종목별 최적화 파라미터
  dashboard-results.json                  ← UI용 최적화 결과
  paper-trading-1m-daily-results.json     ← UI용 페이퍼 트레이딩 결과
  anomaly-live-trade-status.json          ← UI용 live trading 상태
```

> 캔들 타임스탬프는 Upbit `candle_date_time_utc`(분봉 시작 시각)를 사용해 분 경계로 정규화합니다. `candle.timestamp`(마지막 체결 시각)를 쓰면 같은 분봉이 서로 다른 캔들로 인식되어 over-trading 버그가 발생하므로 사용하지 않습니다.

---

## 기술 스택

- **UI**: React + TypeScript + Vite + lightweight-charts v5
- **시뮬레이션**: Node.js + TypeScript (esbuild 번들링)
- **데이터**: Upbit Public API (REST) + WebSocket (실시간 틱)
- **거래**: Upbit Open API (JWT 인증 시장가 주문)
- **차트**: lightweight-charts v5 (캔들 + 볼륨 + 커스텀 프리미티브)

---

## 운영 워크플로 요약

1. `fetch:anomaly:1m:backtracking` — 가격 100~10,000원 거래량 상위 30개를 7일 1m 캔들로 수집
2. `sim:anomaly` — 1m/7d 백트래킹으로 종목별 파라미터 최적화 + 4전략 × 4케이스 시뮬레이션
3. **00:00 KST** — `rollover`로 어제 데이터 재최적화(이전 70% + 신규 30% 평활화)
4. 각 전략이 동일한 상위 30개 후보 풀에서 cycleScore 기반 상위 15개를 선정
5. `sim:anomaly:watchdog` — 일일 운영 자동 갱신, `live:dry`/`live`로 모의/실거래
