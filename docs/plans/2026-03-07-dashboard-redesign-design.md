# Dashboard Redesign — Design Doc

**Date:** 2026-03-07
**Goal:** Transform raw dashboard into a polished decision-analytics platform for testing the bot's decision-making system.

## Core Purpose

The dashboard is primarily a **decision pipeline analysis tool**, not just a PnL tracker. The main question it answers: *"Why isn't the bot trading, and where does the decision pipeline break down?"*

---

## Pages

### 1. Overview

**PnL Header (Binance-style)**
- Today / 7D / 30D / All-time PnL (% + USD) — from `trade_closes.realized_pnl` aggregated
- Total Profit | Total Loss | Net P/L for selected period
- Time range tabs: 7D / 1M / 3M / All

**Charts row**
- Daily PnL bar chart — green/red bars, one per day, from `trade_closes` grouped by `closed_at::date`
- Cumulative equity curve — running sum of `realized_pnl` + BTC price % change as benchmark (from `market_snapshots`)
- Balance area chart — `cycles.balance` over time

**Bot Status strip (realtime, 30s poll)**
- Wallet Balance | Session PnL | Regime | F&G | Layer | Watchdog | Last cycle age

---

### 2. Analytics / Decisions (new page)

**Decision Funnel (aggregate, filterable by date range)**
```
N decisions from LLM
  → N passed preflight    (rejected: volume low / regime mismatch)
    → N passed Risk        (rejected: confidence / SL / exposure / duplicate)
      → N executed          (failed: ORDER_FAIL)
        → N closed TP
        → N closed SL
        → N closed manual
```
Visual: horizontal funnel bars with counts and conversion %.

**Rejection Breakdown (bar chart)**
- Grouped by rejection reason: `volume_low`, `regime_mismatch`, `confidence_below_min`, `duplicate_position`, `leverage_cap`, `order_fail`
- Source: `errors.code` + `risk_validations.rejection_reason`

**Confidence Distribution (histogram)**
- Two overlapping histograms: accepted decisions vs rejected decisions
- Shows where the confidence threshold cuts off

**Volume Filter Trend (line chart over time)**
- Count of `LLM_PREFLIGHT_WARNING` per hour/day
- Reveals "dead hours" when market volume is too low for the bot to trade

**Regime Performance Table**
- Columns: Regime | Decisions | Conversion % | Win Rate | Avg PnL | Total PnL
- Rows: BearTrend / BullTrend / Range / Breakout / Capitulation

**Pair Performance Table**
- Columns: Pair | Trades | Win Rate | Avg Hold Time | Total PnL | Avg Confidence
- Sortable by any column

**LLM Layer Usage (donut + timeline)**
- Layer 1 / Layer 2 / Layer 3 — frequency and outcomes per layer

**Swarm vs Single Analysis**
- Win rate, avg PnL when swarm activated vs single LLM
- Swarm triggers: cycles where `volume_ratio > 1.5`

---

### 3. Trades (enhanced existing page)

**Left column filters**
- Filter by: pair / action (LONG/SHORT/CLOSE) / date range / outcome (TP/SL/rejected/open)

**Decision cards with status badges**
- `PREFLIGHT_FAIL` (orange) / `RISK_REJECTED` (red) / `ORDER_FAIL` (red) / `OPEN` (blue) / `TP` (green) / `SL` (red) / `MANUAL` (gray)

**Right panel — detailed funnel timeline (per selected decision)**
```
[✓] 13:19  LLM Decision    → SHORT ADAUSDT conf:61% regime:BearTrend
[✓] 13:19  Preflight       → passed (vol:1.13x, regime ok)
[✓] 13:20  Risk Validation → passed
[✓] 13:20  Execution       → entry $0.8234, SL:-2.2%, TP:+6.5%
[✓] 18:40  Close           → +$2.14 (+6.5% TP hit), held 5h20m
```
Failed stages shown in red with reason.

**SL vs TP vs Manual hit rate (donut)**

**Hold time distribution (histogram)**
- How long positions stay open before close

---

### 4. Swarm (enhanced existing page)

- Persona vote visualization — horizontal bars per expert (bull/bear/neutral + confidence)
- Judge consensus shown as parsed structured output, not raw text
- Swarm history trend — confidence and outcome per historical swarm cycle

---

## Data Sources

| UI Element | Table | Query |
|---|---|---|
| Daily PnL bars | `trade_closes` | GROUP BY `closed_at::date`, SUM `realized_pnl` |
| Cumulative equity | `trade_closes` | running SUM ordered by `closed_at` |
| BTC benchmark | `market_snapshots` | BTC price at session start vs now |
| Balance area | `cycles` | `balance`, `created_at` ORDER BY time |
| Decision funnel | `trade_decisions` + `errors` + `risk_validations` + `trade_executions` + `trade_closes` | LEFT JOINs on `decision_id` |
| Rejection reasons | `errors` + `risk_validations` | GROUP BY `code` / `rejection_reason` |
| Regime perf | `trade_decisions` + `trade_closes` | GROUP BY `regime` |
| Pair perf | `trade_decisions` + `trade_closes` | GROUP BY `pair` |

---

## Tech Stack

- **Charts:** `recharts` (install in dashboard/)
- **Existing:** React + Vite + Tailwind + Supabase JS client
- **New Supabase queries:** aggregate RPCs or client-side aggregation for funnel data
- **Realtime:** keep existing Supabase realtime for errors + positions; poll cycles every 30s

---

## Out of Scope

- Asset allocation donut (USDT/BNB) — not useful for futures trading
- Mobile layout — desktop-first
- Historical news correlation — future work
