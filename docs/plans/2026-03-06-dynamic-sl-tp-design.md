# Dynamic SL/TP Design

## Problem

Bot places static SL/TP at entry and never modifies them. When a position reaches +19% ROI but TP is at +20%, a market reversal loses all profit because SL is still at -5%.

## Solution: LLM-Driven ADJUST Action

Each Brain cycle, the LLM evaluates open positions and can return `ADJUST` decisions to move SL/TP. Hard guardrails (ratchet rule) prevent the AI from lowering protection.

## Approach: LLM ADJUST in Brain Cycle

**Why Brain, not Watchdog:** Static SL on Binance protects against flash crashes (1-min reaction). LLM adds strategic optimization every 10+ min with full context (indicators, news, momentum).

## New Action Type

```typescript
{ action: "ADJUST", pair: "ADAUSDT", stop_loss_pct: -3.0, take_profit_pct: 9.0 }
```

- Positive `stop_loss_pct`: SL below entry (normal). E.g. 2.0 = entry - 2%
- Negative `stop_loss_pct`: SL above entry (profit lock). E.g. -3.0 = entry + 3% for LONG

## Ratchet Guardrail (RiskManager)

1. **SL only rises**: New SL price >= current SL price (LONG) or <= (SHORT). Cannot lower protection.
2. **Breakeven lock**: When unrealizedPnlPct >= 5%, SL cannot be below entry price.
3. **TP flexible**: Can move in either direction.

## OrderExecutor.adjustSlTp()

1. Cancel all algo orders for the pair
2. Place new STOP_MARKET with updated price
3. Place new TAKE_PROFIT_MARKET with updated price
4. If new SL fails to place -> restore old SL (safety fallback)

## Prompt Changes

Show in position context:
- Current SL/TP prices (from DB trade_executions)
- Max PnL reached during position lifetime (high water mark from watchdog snapshots)
- Instruction: "For each open position, you may return ADJUST to modify SL/TP levels"

## DB: sl_tp_adjustments Table

```sql
CREATE TABLE sl_tp_adjustments (
  id SERIAL PRIMARY KEY,
  cycle_id INT REFERENCES cycles(id),
  pair TEXT NOT NULL,
  old_sl NUMERIC, new_sl NUMERIC,
  old_tp NUMERIC, new_tp NUMERIC,
  reasoning TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Bug Fixes (included in plan)

1. **trade_closes.execution_id NULL** -- bot doesn't link close records to executions. Fix in `insertTradeClose()`.
2. **Swarm cycle_id NULL** -- some swarm conversations don't get cycle_id. Fix in `insertLlmConversation()`.
3. **get_open_positions() fallback** -- SQL function updated to handle NULL execution_id via pair+time matching.
