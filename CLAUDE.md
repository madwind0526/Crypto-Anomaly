# CLAUDE.md

## Session Start Protocol

새 세션 시작 시 아래 순서로 읽어 컨텍스트를 파악한다.

1. `memory-bank/active-context.md` → 현재 포커스 확인
2. `memory-bank/STATE.md` → Wave 상태 및 Cache 상태 확인
3. Cache Status = `DIRTY`이면 `memory-bank/CACHE.md` → `knowledge/` flush 제안
4. 사용자에게 현재 포커스 + pending flush 여부 보고

> PROGRESS.md는 전체 이력 참고용으로 유지. 세션 작업 상태는 memory-bank가 우선.

---

## npm Scripts

```bash
npm run dev                           # UI 개발 서버 (포트 5173)
npm run fetch:hist5m                  # 90일치 5m 역사 데이터 갱신
npm run fetch:anomaly:1m              # 선택 종목 1m 데이터 fetch
npm run fetch:anomaly:1m:backtracking # 7일 1m 백트래킹 데이터 fetch
npm run sim:anomaly                   # 시뮬레이션 1회 실행
npm run sim:anomaly:loop              # 60초 간격 연속 실행
npm run sim:anomaly:watchdog          # watchdog으로 루프 감시
npm run rollover                      # 일일 종목 롤오버 (00:00 KST)
npm run ws:live                       # WebSocket 실시간 시뮬레이션
npm run live:dry                      # 모의 매매 (dry-run)
npm run live                          # 실매매
```

## 데이터 파이프라인 순서

```
fetch:anomaly:1m:backtracking → sim:anomaly → (ws:live) → (live:dry / live)
```
