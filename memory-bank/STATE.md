# State

## Current Wave

- **Wave:** 5 — 코드 리뷰 4라운드 버그 수정 (8건 추가, 누적 29건)
- **Status:** Ready
- **Cache Status:** CLEAN
- **Last Checkpoint:** 4라운드 리뷰 수정 완료 (2026-06-04)

## Wave History

| Wave | 작업 내용 | 상태 | 날짜 |
|------|-----------|------|------|
| 1 | 독립 프로젝트 생성 + 특이점 감지 로직 구현 | ✅ 완료 | 2026-05-16 |
| 2 | 4개 전략(A/B/C/D) + 종목 선택 + 파라미터 적응 + UI 기본 | ✅ 완료 | 2026-05-20 |
| 3 | 운영 안전장치 + WS 복원 + General-style Workflow 전환 | ✅ 완료 | 2026-05-23 |
| 4 | Pool 누적 로직 복원 + Live Trade UI | ✅ 완료 | 2026-05-28 |

## Wave 4 진행 상황

### 완료
- [x] 2026-05-23 방식(매일 pool 재생성)이 누적 설계와 다름을 발견
- [x] `POOL_REMOVAL_DAYS = 45` 상수 추가 (detection용 `REMOVAL_DAYS=7`과 분리)
- [x] `candidateMarketLastEvents` 타입 추가 — 마지막 이벤트 타임스탬프 추적
- [x] 날짜 변경 분기: Union 누적 + 45일 제거로 교체
- [x] `anomaly-selection.json`에 `candidateMarketLastEvents` 필드 저장
- [x] Live Trade 탭 추가 (dry-run / 실매매 모드)
- [x] `anomaly-live-trade-status.json` 10초 폴링 UI 반영

### 다음 단계
- [ ] `liveEventCount=0` 원인 분석 → 1m 24h 특이점 감지 로직 검증
- [ ] `sim:anomaly:loop` 루프 모드 장시간 안정성 확인
- [ ] 선택 종목 0개일 때 graceful 처리 (hist5m stale 극단 케이스)

## Session Notes

- 2026-05-28: Pool 누적 로직 복원. 2026-05-23 변경이 매일 재생성으로 잘못 구현된 것을 발견하고 Union 누적 + 45일 제거로 교체. candidateMarketLastEvents 필드 추가로 영속성 확보.
- 2026-05-23: General-style workflow로 전환. 90일 5m hist → 7일 1m backtracking. top-30 → top-9 선정. 00:00 KST refit 70/30 블렌딩 추가.
- 2026-05-21: WS 실시간 시뮬레이션 main 워크트리에 복원. 포트 5177 구버전 워크트리 정리. 브랜치 main 단일화.
- 2026-05-20: Crypto-General에서 운영 안전장치 포팅. Guideline/Safety paper trading case 결과 저장. blocked signal chart X 마커 추가.
- 2026-05-16: 독립 프로젝트 생성. 특이점 감지(10%/3x, 2h 쿨다운). 4개 전략 구현. UI 확인.
