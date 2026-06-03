# Active Context

## Latest 2026-05-28

- Pool 누적 로직 복원 완료: Union 누적 + 45일 미발생 시 제거 (candidateMarketLastEvents 필드로 영속성 보장)
- 7일 1m 백트래킹 기반 종목 선정으로 전환 (90일 5m hist → 7일 1m backtracking)
- Pool 초기 시드: KRW 전체 거래량 상위 30개 → top 9 선정 → 나머지 monitoring 유지
- WS 실시간 시뮬레이션 main 워크트리에 복원 (`ws:live` 스크립트)
- Live Trade UI 추가 (`live-trade` 화면, dry-run / 실매매 모드)
- `anomaly-live-trade-status.json` 10초 폴링으로 UI 반영
- 일일 rollover: 00:00 KST 종목 재선정 + 70/30 파라미터 블렌딩
- `liveEventCount=0` 미해결 — 1m live 특이점 감지 미동작, 파라미터 적응 base값 고정 상태

## Current Focus

- ✅ 4개 전략 (A/B/C/D) 구현 및 동일 종목 공통 모니터링
- ✅ Pool 누적 로직: Union 추가 + 45일 제거 (PROGRESS.md 2026-05-28 기준)
- ✅ WebSocket 실시간 시뮬레이션 (`ws:live`) 복원
- ✅ Live Trade UI (dry-run/실매매)
- ✅ 일일 rollover 및 70/30 파라미터 블렌딩
- ✅ Guideline/Safety case 4가지 paper trading 결과 저장
- ✅ B/C 전략 roc48 → preRoc5 수정 (진입 차단 버그 수정)
- ⏳ `liveEventCount=0` 원인 분석 (1m 기준 24h 특이점 감지 미동작)
- ⏳ `sim:anomaly:loop` 루프 모드 장시간 안정성 확인
- 🔲 B/C 전략 실제 거래 발생 여부 확인 (시장 조건 의존)

<!-- 규칙: 최근 작업 10개만 유지 -->
