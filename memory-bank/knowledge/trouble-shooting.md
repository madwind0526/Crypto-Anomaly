# Trouble-Shooting

> 발견된 버그, 수정 방법, 미해결 이슈 기록.

---

## [수정완료] 코드 리뷰 1·2라운드 수정 (2026-06-04, 13건)

### 라운드 1 (6건)

| 파일 | 수정 내용 |
|------|-----------|
| `anomaly-variants-sim.ts` | `detectAnomalyEvents`: volRatio 분모 `hourCandles` → `Math.max(prevHourCandles.length, 1)` — 데이터 갭 구간 거짓 이벤트 방지 |
| `anomaly-variants-sim.ts` | inline refit blending: `optimizedCache?.params` → `baseOpt.params` 고정 — 7d backtracking이 기준이 되어야 함 |
| `anomaly-variants-sim.ts` | `selectedMarketSummaries` lastEventTs fallback → `0` (display 전용 필드) |
| `anomaly-daily-rollover.ts` | `updateCandidatePool`: `freshTopMarkets.includes()` 무조건 유지 조건 제거 → 45일 규칙 top-30에도 동일 적용 |
| `App.tsx` | `activeDailyGuideMode` fallback `"strict"` → `"ignored"` (R-08 준수) |
| `anomaly-live-trader.ts` | `decideD` coinP 없는 fallback: `anomalyScenario`(5m 기준) → 1m 기준 override(accelerationMin=0.020, maxExtendedMove=0.25) 추가 |

### 라운드 4 (8건)

| 파일 | 수정 내용 |
|------|-----------|
| `optimize-params.ts:280` | `backtestD` 진입 조건에 양봉 조건 추가 (`candles[i].close > candles[i].open`) — ws-live.ts와 일치 |
| `src/strategies/anomaly.ts:96` | `anomalyStrategy.decide()` 진입 조건에 양봉 조건 추가 (`current.close > current.open`) — 전 경로 통일 |
| `anomaly-live-trader.ts:827` | 워밍업 기준 `< 60` → `< 70` (R-01 기준 및 sim/ws-live 70봉과 통일) |
| `anomaly-live-trader.ts:876` | `executeBuy` 진입부에 lastSellAt 쿨다운 체크 추가 — 매도 직후 same-candle 즉시 재매수 차단 |
| `ws-live.ts:264,287` | WS-X/WS-O fade 기준: 고정 `1.2` → slot별 분기 (`range-grid=1.3`, 나머지=`1.2`) — decideB와 일치 |
| `anomaly-live-trader.ts:1012` | 하트비트 미실현 손익 계산: 이중 reduce → 단일 reduce로 통합 |
| `src/app/App.tsx:765` | UI 텍스트 D 전략 설명 수정: 가속 `4.5%→2.0%`, 과열 기준 `18%→25%` |
| `anomalyMonitor.ts` | 테스트에서 사용 중 확인 (dead code 아님 — 수정 없음) |

### 라운드 3 (8건)

| 파일 | 수정 내용 |
|------|-----------|
| `ws-live.ts:200` | `checkEntryD` volR 임계값: `>= 3.0` → `>= 3.5` (anomaly.ts `relativeVolumeMin: 3.5`와 일치) |
| `optimize-params.ts:279` | `backtestD` 과열 기준: `roc48 >= 0.18` → `roc48 >= 0.25` (R-08 1m 스케일 준수) |
| `anomaly-variants-sim.ts:~993` | refit 스킵 경로 `...baseOpt` 스프레드 제거 → 명시적 필드 (refit 성공 경로와 포맷 통일) |
| `anomaly-variants-sim.ts:196` | live 1m 최소 캔들: `< 100` → `< 70` (backtracking 스캔 기준과 통일) |
| `anomaly-daily-rollover.ts:190` | 페이지네이션 중단 조건: raw `timestamp` → `candleStartMs()` 정규화 기준으로 비교 |
| `anomaly-live-trader.ts:426` | `candidateMarkets` fallback: SelectedMarket 객체 방어 코드 추가 (`.market` 추출 + string 필터) |
| `ws-live.ts:453` | `sel.markets` null-safe 처리 + `candidateMarkets` fallback 추가 |
| `src/simulation/safety.ts:11` | `insufficient-1m-data` 240봉 기준 의도 주석 추가 |

### 라운드 2 (7건)

| 파일 | 수정 내용 |
|------|-----------|
| `anomaly-live-trader.ts:352` | `selectBestStrategy`: `if (!scores[sid] !== undefined)` → `if (!(sid in scores))` — 조건 논리 반전 수정, 방어 코드 복원 |
| `anomaly-variants-sim.ts:955` | `isNewSelection`: `cachedSelection?.markets` → `cachedSelection?.candidateMarkets` — 캐시 히트 체크(line 879)와 필드명 통일 |
| `anomaly-variants-sim.ts:978` | refit 저장 시 `...refitOpt` 스프레드 제거 → 명시적 메타데이터 필드로 교체 (baseDurationMs, refitDurationMs, totalCombos 분리) |
| `anomaly-daily-rollover.ts` | `updateCandidatePool`: `candlesByMarket` 파라미터 추가 → 가격 범위 필터 적용 (candlesByMarket에 데이터 있는 마켓 한정) |
| `anomaly-daily-rollover.ts` | `updateCandidatePool` 호출부에 `candlesByMarket` 인자 추가 |
| `ws-live.ts:193` | `checkEntryD`: `maxExtendedMove = 0.25` 초과열 방지 조건 추가 (`roc48 < 0.25`) — anomaly.ts D전략 로직과 일치 |
| `ws-live.ts:199` | `roc3` 계산: 인라인 계산 → `getRoc(candles, i, 3)` 헬퍼 사용으로 통일 |

---

## [수정완료] B/C 전략 roc48 진입 차단 버그

**현상:** Anomaly-B/C 전략이 1m 캔들에서 거래를 전혀 내지 못함.
**근본 원인:** `roc48 < 0.035` 조건 사용. 1m 기준 roc48 = 48분 ROC. 펌프 자체가 roc48을 3.5% 이상으로 밀어버려 진입이 차단됨.
**수정:**
- B: `roc48 < 0.035` → `preRoc5 < 0.05`
  - `pre5Close = candles[i-6].close`, `pre1Close = candles[i-1].close`
  - `preRoc5 = |pre1Close - pre5Close| / pre5Close`
- C: 동일 패턴, `prev5Close = candles[i-7].close`, `prev2Close = candles[i-2].close`
**주의:** 수정 자체는 맞지만 거래 발생은 시장 조건(body>=2.5%, vol>=3.5x) 충족에 의존.

---

## [수정완료] D 전략 1m 스케일 파라미터 오류

**현상:** Anomaly-D 전략 진입 조건이 5m 기준 파라미터를 1m에 그대로 사용.
**수정:**
- `accelerationMin`: `0.045` → `0.020` (5m 기준값 → 1m 스케일)
- `maxExtendedMove`: `0.18` → `0.25`

---

## [수정완료] Pool 매일 재생성 버그 (2026-05-28)

**현상:** 2026-05-23 변경 후 pool이 매일 당일 backtracking 감지 결과로만 교체됨. 5개로 축소.
**근본 원인:**
- 날짜 변경 시 전날 pool을 버리고 당일 감지 결과로 대체하는 방식으로 잘못 구현.
- `REMOVAL_DAYS=7` 이 pool 제거에도 적용되어 7일 이벤트 없으면 즉시 제거.
**수정:**
- `POOL_REMOVAL_DAYS = 45` 상수 추가 (`REMOVAL_DAYS=7`은 detection 전용으로 유지)
- 날짜 변경 분기: 교체 → Union 누적 + 45일 제거
- `candidateMarketLastEvents` 필드 추가로 각 종목의 마지막 이벤트 타임스탬프 추적
- `anomaly-selection.json`에 `candidateMarketLastEvents` 저장 (pool 영속성 보장)

---

## [수정완료] 포트 5177 워크트리 충돌

**현상:** 포트 5177이 구버전 `.claude` 워크트리 서버를 서빙하고 있어 UI가 2026-05-19 이전 stale 데이터를 보여줌.
**수정:**
- 구버전 워크트리 서버 및 WS 프로세스 정지
- main 프로젝트를 포트 5177에서 재시작
- `claude/eager-varahamihira-1db0b7` 로컬/원격 브랜치 삭제. main 단일화.

---

## [수정완료] anomaly-watchdog 첫 사이클 즉시 kill 버그

**현상:** watchdog이 이전 result 파일이 이미 stale이면 첫 시뮬레이션 사이클을 kill함.
**수정:** child 시작 시점부터 freshness를 추적하고, file mtime 변화 여부로만 kill 판단.

---

## [미해결] liveEventCount=0

**현상:** 전일 live 1m 특이점 이벤트가 항상 0으로 감지되어 파라미터 적응이 base값 고정.
**추정 원인:** `detectAnomalyEvents`의 1m 경로에서 24h 데이터 스캔이 제대로 동작하지 않을 가능성.
**영향:** 전략 파라미터가 이전 날의 시장 특성을 반영하지 못함.
**다음 단계:** `detectAnomalyEvents` 1m 분기 코드 직접 검증 필요.

---

## [미해결] B/C 전략 0거래 (시장 조건)

**현상:** roc 수정 후에도 B/C 전략 거래가 거의 발생하지 않음.
**현재 이해:** 수정 자체는 정확. 거래 발생 조건 (body>=2.5%, vol>=3.5x) 이 조용하거나 하락 장세에서 미달.
**상태:** 알려진 한계. 시장 조건 개선 시 자연스럽게 해결될 수 있음.

---

## [참고] hist5m stale 문제

**현상:** Codex 메인 프로젝트가 `fetch:hist5m` 갱신을 멈춤 (2026-05-12 이후).
**해결:** 이 프로젝트에서 독립적으로 `npm run fetch:hist5m`으로 갱신 가능.
**권장:** 주 1회 `fetch:hist5m` 실행.

---

## [참고] Windows에서 ROLLOVER_DRY_RUN 환경변수 설정

**현상:** `rollover:dry` 스크립트가 Windows PowerShell에서 `ROLLOVER_DRY_RUN=true` 구문 오류.
**해결:** `$env:ROLLOVER_DRY_RUN="true"; node scripts/anomaly-daily-rollover.mjs`
또는 `.env` 파일 사용.

---

## [참고] fetch:anomaly:1m:backtracking Windows 스크립트 구문

**현상:** package.json의 `set VAR=value&&` 패턴은 PowerShell에서 다르게 동작.
**해결:** PowerShell에서 실행 시:
```powershell
$env:UPBIT_CANDLE_UNIT="1"
$env:UPBIT_LOOKBACK_DAYS="7"
$env:UPBIT_CACHE_LABEL="upbit-krw-1m-anomaly-backtracking"
$env:UPBIT_WRITE_PUBLIC="false"
node scripts/fetch-upbit-market-data.mjs
```
