# Crypto-Anomaly — Progress & Context

## 왜 이 프로젝트가 만들어졌는가

원래 `C:\Claude\Crypto-Currency`(Codex 프로젝트)에서 워크트리로 작업하다가 데이터 의존성 문제로 완전히 분리.

**핵심 문제:**
- Codex의 `upbit-krw-1m-daily.json`은 Codex가 선택한 종목(General-A/B/C/Anomaly)만 포함
- Claude가 선택한 특이점 종목(PROS, KITE, CPOOL 등)의 1m 데이터가 없었음
- 따라서 Claude는 자체 데이터 파일과 독립 실행 환경이 필요

---

## 핵심 아이디어 — 특이점(Anomaly) 종목 선택 철학

### 가설 (데이터로 검증됨)
> "한번 튄 종목은 특이점 유형의 코인이다. 잊혀질 만큼 시간이 지나면 다시 튄다."

### 검증 결과 (hist5m 90일 분석)
- 10%/3x 조건으로 18개 종목 감지
- 16/18개 (89%)가 3회 이상 반복 신호 → **가설 지지됨**
- Gap 분포: p50=2.5일, p90=32.7일, max=72일
- **45일 제거 기준** → 전체 반복 이벤트의 95% 커버

---

## 특이점 감지 기준 (확정)

```
조건 1: 10분 내 가격 변동 (max_high - min_low) / min_low > 10%
조건 2: 10분 거래대금 > 직전 1시간 평균 10분 거래대금의 3배
쿨다운: 2시간 (같은 이벤트 중복 감지 방지)
```

**구현 세부:**
- 5m 캔들: 2캔들 윈도우, 12캔들 1시간, 24캔들 쿨다운
- 1m 캔들: 10캔들 윈도우, 60캔들 1시간, 120캔들 쿨다운
- 볼륨 비교: `windowVol / (prevHourTotal / hourCandles)` (per-candle avg 기준)

---

## 종목 선택 로직

```
매일 00:00 KST에 1회 실행 → anomaly-selection.json 캐시

1. hist5m 90일 스캔 → 특이점 발생 종목 추출
2. live 1m 최근 24h 스캔 → 새로운 종목 추가 (union)
3. 마지막 특이점 발생 후 45일 초과 → 제거
4. 전일 특이점 이벤트 기반 파라미터 적응 (trailingStop, maxHoldCandles)
5. 선택된 전체 종목을 4개 전략 모두 공통으로 모니터링
```

**현재 선택된 종목 (2026-05-15 기준, 16개):**
PROS, KITE, CPOOL, MED, MBL, LAYER, SAHARA, B3, BIO, PIEVERSE, TOKAMAK, DRIFT, SONIC, CHIP, MOVE, ORDER

---

## 4개 전략 (Anomaly-A/B/C/D)

| 전략 | slot | 진입 조건 | hold | trailing |
|------|------|---------|------|---------|
| **Anomaly-A / Calm Impulse** | momentum | 15봉 조용한 구간 후 첫 충동 (avgBody<0.5%, curBody≥1.5%, vol≥1.5x) | 12봉 | 2.8% |
| **Anomaly-B / First Explosion** | range-grid | 폭발 캔들 직접 진입 (body≥2.5%, vol≥3.5x, 3봉 선행 조용함) | 6봉 | 1.8% |
| **Anomaly-C / Confirmed Burst** | arbitrage | 폭발 다음 봉에서 확인 후 진입 (prevExplosion + curVol≥1.8x) | 8봉 | 2.2% |
| **Anomaly-D / Sweep Best** | anomaly | 기존 anomaly 전략 + trailingStop=1.8% | 12봉 | 1.8% |

**파라미터 적응:** 매일 전일 특이점의 medianMove 기준으로 trailingStop/maxHold 자동 조정

---

## npm 스크립트

```bash
npm run fetch:hist5m        # 90일치 5m 데이터 (처음 한번 또는 갱신 시)
npm run fetch:anomaly:1m    # 선택 종목 1m 데이터 (매일 또는 주기적)
npm run sim:anomaly         # 시뮬레이션 1회 실행
npm run sim:anomaly:loop    # 60초 간격 연속 실행
npm run dev                 # UI 개발 서버 (포트 5173)
```

**첫 실행 순서:**
```bash
# 1. 선택 파일 생성 (hist5m 기반, 1m 없어도 실행됨)
npm run sim:anomaly

# 2. 선택된 종목의 1m 데이터 fetch
npm run fetch:anomaly:1m

# 3. 전체 시뮬레이션 실행
npm run sim:anomaly

# 4. UI 확인
npm run dev
```

---

## 데이터 파일 구조

```
data/market/
  upbit-krw-5m.json           ← 90일 5m 역사 데이터 (fetch:hist5m으로 갱신)
  upbit-krw-1m-anomaly.json   ← 선택 종목 1m 데이터 (fetch:anomaly:1m으로 갱신)

public/market/
  anomaly-selection.json      ← 당일 선택 종목 + 적응된 파라미터 (시뮬레이션이 생성)
  dashboard-results.json      ← UI용 최적화 결과
  paper-trading-1m-daily-results.json  ← UI용 paper trading 결과
```

---

## 현재 상태 (2026-05-15)

- [x] 독립 프로젝트 생성 (`C:\Claude\Crypto-Anomaly`)
- [x] 특이점 감지 로직 구현 (10%/3x, 2h cooldown)
- [x] 종목 선택 + 45일 제거 + 일일 캐시
- [x] 파라미터 적응 (전일 medianMove 기반)
- [x] 4개 전략 (A/B/C/D) 동일 종목 모니터링
- [x] 전용 데이터 fetch 스크립트 (fetch:anomaly:1m, fetch:hist5m)
- [x] git main 브랜치 초기화
- [x] 의존성 설치 완료
- [ ] UI 확인 (npm run dev → 브라우저에서 확인)
- [ ] 루프 모드 실제 운영 테스트
- [ ] hist5m 정기 갱신 전략 (현재 2026-05-12 이후 stale)

---

## 미해결 / 다음 세션에서 할 것

### 단기
1. `npm run dev` 로 UI 열어서 대시보드 정상 표시 확인
2. `npm run sim:anomaly:loop` 으로 루프 모드 안정성 확인
3. hist5m 갱신: `npm run fetch:hist5m` (30분 소요, 처음 한번)

### 중기
4. 선택 종목이 0개일 때 graceful 처리 (hist5m stale 극단 케이스)
5. live 1m 감지에서 liveEventCount가 항상 0인 이유 확인
   - 24h 데이터에서 1m 기준 감지가 제대로 동작하는지 검증
6. B/C/D 전략이 trade를 전혀 못 내는 이유 분석
   - 1m 캔들에서 5m 기준 로직(decideB/C)이 작동하는지 확인

### 아이디어 (논의된 것)
- Set 누적 방식: 추가만, 45일 미발생 시 제거
- 우선순위: 마지막 특이점 후 21~45일 구간이 "다음 펌프 대기" 최우선
- hist5m stale 문제 → 주 1회 `fetch:hist5m` 스케줄 권장

---

## 알려진 이슈

### B/C/D 전략 trade 없음
현재 B(FirstExplosion)/C(ConfirmedBurst)/D(SweepBest)가 trade=0.
- B/C는 5m 캔들 기준으로 설계 (2.5% body, 3.5x vol) → 1m 캔들에서는 기준이 너무 엄격
- D는 anomalyStrategy 원본 로직 → 1m 스케일 미확인

### 파라미터 적응이 base와 동일
전일 live 1m에서 특이점 이벤트가 감지되지 않아 적응이 일어나지 않음.
liveEventCount=0인 것과 같은 원인.

### hist5m이 2026-05-12 이후 stale
메인 프로젝트(Codex)가 fetch를 멈춘 것으로 보임.
이 프로젝트에서 독립적으로 `npm run fetch:hist5m`으로 갱신 가능.
