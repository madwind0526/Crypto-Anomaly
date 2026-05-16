# Crypto-Anomaly

Upbit KRW 시장에서 **특이점(Anomaly) 종목**을 자동 선별하고, 4가지 전략으로 페이퍼 트레이딩 시뮬레이션을 실행하는 도구입니다.

---

## 핵심 아이디어

> "한번 튄 종목은 특이점 유형의 코인이다. 잊혀질 만큼 시간이 지나면 다시 튄다."

hist5m 90일 데이터 분석에서 89% 종목이 3회 이상 반복 신호를 보임으로써 가설이 지지됩니다.

---

## 특이점 감지 기준

```
조건 1: 10분 내 가격 변동 (max_high - min_low) / min_low > 10%
조건 2: 10분 거래대금 > 직전 1시간 평균 10분 거래대금의 3배
쿨다운: 2시간 (같은 이벤트 중복 감지 방지)
```

---

## 4가지 전략

| 전략 | 이름 | 진입 조건 | Hold | Trailing |
|------|------|---------|------|---------|
| **A** | Calm Impulse | 15봉 조용한 구간 후 첫 충동 (avgBody < 0.5%, curBody ≥ 1.5%, vol ≥ 1.5×) | 12봉 | 2.8% |
| **B** | First Explosion | 폭발 캔들 직접 진입 (body ≥ 2.5%, vol ≥ 3.5×, 3봉 선행 조용함) | 6봉 | 1.8% |
| **C** | Confirmed Burst | 폭발 다음 봉에서 확인 후 진입 (prevExplosion + curVol ≥ 1.8×) | 8봉 | 2.2% |
| **D** | Sweep Best | 가속+거래량 스파이크 기반 (anomaly baseline) | 12봉 | 1.8% |

---

## 종목 선택 로직

매일 00:00 KST에 1회 실행 후 `anomaly-selection.json`에 캐시됩니다.

1. hist5m 90일 스캔 → 특이점 발생 종목 추출
2. live 1m 최근 24h 스캔 → 새 종목 추가 (union)
3. 마지막 특이점 발생 후 45일 초과 → 제거
4. 전일 특이점 이벤트 기반으로 trailingStop / maxHoldCandles 적응
5. **종목별 파라미터 최적화**: 전날 1m 데이터로 grid search → 전략별 최적 파라미터 저장
6. 선택된 전체 종목을 4개 전략이 공통으로 모니터링

---

## 시작 방법

### 첫 실행

```bash
# 1. 90일 5m 역사 데이터 수집 (~5분 소요)
npm run fetch:hist5m

# 2. 선택 파일 생성 및 종목 확인
npm run sim:anomaly

# 3. 선택 종목의 1m 데이터 수집
npm run fetch:anomaly:1m

# 4. 시뮬레이션 실행
npm run sim:anomaly

# 5. UI 확인
npm run dev
```

### 일일 운영 (루프 모드)

```bash
# 60초 간격 자동 실행 (1m 데이터 자동 fetch 포함)
npm run sim:anomaly:loop
```

루프 모드는 매 사이클마다 `fetch:anomaly:1m`을 자동 실행하며, 00:00 KST에 종목 선택과 파라미터 최적화를 자동으로 수행합니다.

### hist5m 정기 갱신 (주 1회 권장)

```bash
npm run fetch:hist5m
```

---

## 데이터 파일

```
data/market/
  upbit-krw-5m.json              ← 90일 5m 역사 데이터
  upbit-krw-1m-anomaly.json      ← 선택 종목 1m 데이터

public/market/
  anomaly-selection.json         ← 당일 선택 종목 + 적응된 파라미터
  anomaly-optimized-params.json  ← 종목별 최적화 파라미터 (00:00에 생성)
  dashboard-results.json         ← UI용 최적화 결과
  paper-trading-1m-daily-results.json  ← UI용 페이퍼 트레이딩 결과
```

---

## 기술 스택

- **UI**: React + TypeScript + Vite + lightweight-charts v5
- **시뮬레이션**: Node.js + TypeScript (esbuild 번들링)
- **데이터**: Upbit Public API (REST)
- **차트**: lightweight-charts v5 (캔들 + 볼륨 + 커스텀 프리미티브)
