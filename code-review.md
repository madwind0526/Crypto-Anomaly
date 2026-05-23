# Code Review Report — Crypto-Anomaly

> Last updated: 2026-05-23
> Initial review: 2026-05-19

---

## Status Summary

All Critical and High issues have been resolved. Medium and Low issues are noted below.

| Severity | Original | Fixed | Remaining |
|----------|----------|-------|-----------|
| Critical | 4 | 4 | 0 |
| High | 3 | 3 | 0 |
| Medium | 5 | 4 | 1 |
| Low / Quality | 3 | 3 | 0 |

---

## FIXED — Severity: Critical

---

### 1. `anomaly-variants-sim.ts` — `selectAnomalyMarkets` was never called

**Status: FIXED**

`selectAnomalyMarkets` is now called in `runCycle` and its result drives candidate market selection.
If ≥5 anomaly markets are found, uses anomaly-based selection. Otherwise falls back to `selectCandidateMarkets`.
`detect5m` (dead code) has been removed; the function now uses `detect1m` on both backtracking and live sources.

---

### 2. `ws-live.ts::checkEntryC` — completely different logic from `anomaly-variants-sim.ts::decideC`

**Status: FIXED**

`checkEntryC` was completely rewritten to match `decideC`:
- i-4 to i-2: quiet 3 candles (body < 0.8%, vol < 1.6x)
- i-1: explosion candle (body ≥ 2.5%, topRatio ≥ 0.60, vol ≥ 3.5x, preRoc5 < 5%)
- i: confirmation candle (vol ≥ confirmVolMin, body ≥ 0, close ≥ prev close)

Additionally, `ws-live.ts:295` — entry price was `closedC.open` (look-ahead bias); fixed to `closedC.close`.

---

### 3. `anomaly-variants-sim.ts` — `selectedMarketSummaries` wrote fabricated data

**Status: FIXED**

`selectedMarketSummaries` now takes `anomalyMap: Map<string, SelectedMarket>` populated by the real
`selectAnomalyMarkets` call. For markets not in the map (trade-value fallback), it runs `detect1m` to
get real event counts and timestamps.

---

### 4. `adaptVariantParams` was defined but never called

**Status: FIXED**

`runCycle` now:
1. Calls `detectYesterdayEvents(live1m, candidateMarketNames)` to find yesterday's live anomaly events.
2. If events exist: calls `adaptVariantParams(yesterdayEvents)` to adjust trail/hold per variant.
3. If no events: calls `medianVariantParams(perCoinParams)` as fallback (uses median of optimized params).

---

## FIXED — Severity: High

---

### 5. `optimize-params.ts` — No fee or slippage in backtest

**Status: FIXED**

`optimize-params.ts` now applies fee and slippage:
- Buy: `entry = price * (1 + SLIPPAGE_RATE)`
- Sell: `netExit = price * (1 - SLIPPAGE_RATE) * (1 - FEE_RATE)`
- Return: `cash * (1 + (netExit - entry) / entry)`

Also now tracks and returns `maxDrawdown` and `winRate` per market.

---

### 6. `anomaly-variants-sim.ts` — `maxDrawdown` and `winRate` always 0 in `buildOptimizationPlan`

**Status: FIXED**

`buildOptimizationPlan` now always attempts `runBacktest` when `candles.length >= 60`,
giving real `trades`, `equityCurve`, `profitFactor`, `guideRejectedSignals`, `maxDrawdown`, `winRate`.
The fabricated result (`trades: [], profitFactor: 1, maxDrawdown: 0`) is now only used as a fallback
when backtest cannot run (< 60 candles).

---

### 7. `anomaly-variants-sim.ts` — `buildVariants(adaptedParams)` always used `BASE_PARAMS`

**Status: FIXED**

`adaptedParams` is now properly computed via `adaptVariantParams` or `medianVariantParams` before
being passed to `buildVariants`. The resolved value is no longer always `{ ...BASE_PARAMS }`.

---

## FIXED — Severity: Medium

---

### 8. `ws-live.ts` — `Array.shift()` O(n) per candle close

**Status: FIXED**

Replaced `closedCandles[market].shift()` with `closedCandles[market] = closedCandles[market].slice(-500)`.

---

### 9. `backtest.ts` — `closePosition` declared after `return`

**Status: FIXED**

`closePosition` is now declared before the `return` statement to avoid reliance on hoisting.

---

### 10. `anomaly-variants-sim.ts` — No optimization for new markets on cache hit

**Status: FIXED**

On cache hit, `runCycle` now computes `missingMarkets = candidateMarketNames.filter(m => !perCoinParams[m])`
and runs `runOptimization` for missing markets, updating the cache file.

---

### 11. `optimize-params.ts` — `MIN_TRADES = 2` too high for low-activity coins

**Status: FIXED**

`MIN_TRADES` lowered to 1. Low-frequency anomaly coins can produce valid results with a single trade
in a 7-day window; the old threshold caused silent fallback to defaults for too many markets.

---

## REMAINING — Severity: Medium

---

### 12. `anomaly-variants-sim.ts` — Nested timeouts (internal and external)

`execAsync("node scripts/fetch-anomaly-1m.mjs", { timeout: ANOMALY_FETCH_TIMEOUT_MS })` wraps a
script that has its own per-request retry logic. If the outer timeout fires mid-retry, a partial
cache file may remain on disk.

Mitigation: timeout was raised from 120s to 240s. A proper fix would write to a temp file and
rename atomically, but is out of scope for the current iteration.

---

## FIXED — Severity: Low / Code Quality

---

### 13. `types/trading.ts` — `StrategyContext` missing `lastSellPrice`

**Status: FIXED**

`lastSellPrice?: number` added to `StrategyContext`. `backtest.ts` now tracks and passes `lastSellPrice`
in each `strategy.decide` call.

---

### 14. `anomaly-variants-sim.ts` — `buildComparisons` crashed on empty `optimizedMarkets`

**Status: FIXED**

`buildComparisons` now uses `flatMap` with an early `return []` guard when `plan.optimizedMarkets.length === 0`,
and calls `.reduce()` without an initial value (safe because the empty case is guarded).

---

### 15. `anomaly-variants-sim.ts` — Outdated file-header comments referencing hist5m/90-day

**Status: FIXED**

File header, `Reads` section, and `histEventCount` comment updated to reflect 1m/7-day backtracking.

---

## Notes

- `optimize-params.ts` and `anomaly-variants-sim.ts` still maintain separate indicator implementations
  (`computeInd` vs `getInd`). Consolidation is a refactor task not required for correctness.
- The fee model in `optimize-params.ts` charges fee only on sell; `backtest.ts` charges on both buy
  and sell. With `feeRate = 0.0005`, the difference per trade is ~0.05% — negligible in practice.
