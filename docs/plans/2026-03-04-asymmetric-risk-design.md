# Asymmetric Risk Budget Design

**Date:** 2026-03-04
**Goal:** Aggressive on gains, conservative on losses — fixed risk budget that scales with milestones but never risks profits already made.

---

## Core Principle

> Risk $10 on a $100 balance. If we grow to $200, protect $190 (floor). Risk budget grows only at milestones. Daily reset if we lost since yesterday.

---

## Config (`.env`)

```env
RISK_BUDGET_PCT=10          # % of balance for risk budget
RISK_BUDGET_MAX_USD=100     # cap on risk budget in USD
MILESTONE_MULTIPLIER=2      # at each Nx growth → new floor + new budget
FLOOR_PROTECTION_PCT=95     # floor = highWaterMark * 0.95
```

**Examples:**
| Balance | Budget | Cap | Effective Budget |
|---------|--------|-----|-----------------|
| $10     | $1     | $100 | $1             |
| $100    | $10    | $100 | $10            |
| $1000   | $100   | $100 | $100           |
| $5000   | $500   | $100 | $100 (capped)  |

---

## Risk State

File: `~/.indic-bot/risk-state.json`

```json
{
  "highWaterMark": 100.0,
  "currentFloor": 0,
  "riskBudget": 10.0,
  "dailyStartBalance": 100.0,
  "lastResetDate": "2026-03-04",
  "milestoneReached": 1
}
```

### State Transitions

**Every cycle:**
- If `balance > highWaterMark` → update `highWaterMark`, recompute `currentFloor = highWaterMark * (FLOOR_PROTECTION_PCT / 100)`

**At milestone** (`balance >= highWaterMark * MILESTONE_MULTIPLIER`):
- Recalculate `riskBudget = min(balance * RISK_BUDGET_PCT/100, RISK_BUDGET_MAX_USD)`
- Increment `milestoneReached`
- Log the achievement

**Daily reset** (date changed):
- If `balance < dailyStartBalance` → reset `riskBudget = min(balance * pct, max)`
- Always update `dailyStartBalance = balance`, `lastResetDate = today`

---

## RiskManager Logic

New `RiskState` is passed into `validate()`. Two new checks **before** all existing checks:

```typescript
// 1. Floor protection — block new trades if below floor
if (riskState.currentFloor > 0 && portfolio.balanceUsd < riskState.currentFloor) {
  return {
    approved: false,
    reason: `balance $${balance.toFixed(2)} below floor $${floor.toFixed(2)} — protecting profits`,
    shutdown: false,  // NOT shutdown — bot continues, only CLOSE/HOLD allowed
  };
}

// 2. Risk budget exhausted — pause new trades until daily reset
if (portfolio.sessionPnl <= -riskState.riskBudget) {
  return {
    approved: false,
    reason: `risk budget $${riskState.riskBudget.toFixed(2)} exhausted — waiting for daily reset`,
    shutdown: false,  // NOT shutdown — resumes next day
  };
}
```

Key difference from current `maxLossUsd` behavior: **no shutdown** — bot keeps running but only CLOSE/HOLD until reset.

---

## New Module: `src/risk/budget.ts`

```typescript
export interface RiskState {
  highWaterMark: number;
  currentFloor: number;
  riskBudget: number;
  dailyStartBalance: number;
  lastResetDate: string;       // YYYY-MM-DD
  milestoneReached: number;
}

export class RiskBudgetManager {
  // load() — read ~/.indic-bot/risk-state.json, return defaults if missing
  // save(state) — persist to disk
  // update(balance, config) — apply all state transitions, return updated state
  // getRiskState() — convenience method
}
```

`update(balance, config)` encapsulates all logic:
1. High-water mark tracking
2. Floor recomputation
3. Milestone detection + budget recalculation
4. Daily reset on date change

---

## Integration Points

- `src/config.ts` — add `RISK_BUDGET_PCT`, `RISK_BUDGET_MAX_USD`, `MILESTONE_MULTIPLIER`, `FLOOR_PROTECTION_PCT`
- `src/risk/budget.ts` — NEW: `RiskBudgetManager` + `RiskState`
- `src/risk/manager.ts` — `validate()` accepts optional `RiskState`, two new checks
- `src/trading-loop.ts` — call `riskBudget.update(balance)` each cycle, pass `riskState` to `riskManager.validate()`
- `src/index.ts` — create `RiskBudgetManager`, pass to trading loop
- `src/llm/prompts.ts` — show `riskBudget`, `floor`, `milestoneReached` in portfolio section

---

## Testing

- `tests/risk/budget.test.ts` — unit tests for all state transitions (milestone, daily reset, floor, budget cap)
- `tests/risk/manager.test.ts` — add tests for floor-blocked and budget-exhausted cases
