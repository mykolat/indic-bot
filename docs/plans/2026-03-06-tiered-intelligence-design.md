# Tiered Intelligence Architecture v2

**Date:** 2026-03-06
**Status:** Approved
**Goal:** Increase trade conversion from 0.8% to 10%+, wire Grok, fix dead features

## Current State (Problems)

- 124 cycles -> 16 decisions -> 2 executed -> 1 closed trade (0.8% conversion)
- 5.8M tokens/day for 1 trade ($0.43 profit)
- Grok not used ($0 of $10 xAI credit spent) -- FlashCrash, GrokGrounder, Swarm narrative all dead
- Swarm: 86% HOLD votes, 28% rounds fail completely
- 100% trades on ADAUSDT out of 8 pairs
- 11 ORDER_FAIL (price rounding), Circuit Breaker hangs forever
- Episodic Memory (RAG) never written, FilterProfile SL/TP unused, regime_override ignored
- Watchdog anomalies logged but Brain never wakes

## Architecture: 3-Tier Sessions

### Tier 1: Strategic Session (3x/day + on-demand + after restart)

Schedule: 3 times/day (e.g. 00:00, 08:00, 16:00 UTC) + immediately after every bot restart + on-demand escalation.

Full expert panel: GPT Strategist + Grok Sentinel + Macro Expert + Grok Challenger.

Output: `DailyDirective` stored in DB:
- `allowed_pairs`: pairs cleared for trading in this window
- `pair_bias`: directional bias per pair (long/short/both/neutral)
- `max_exposure_pct`: total margin cap
- `risk_appetite`: conservative/moderate/aggressive
- `banned_pairs`: with reasoning
- `key_levels`: support/resistance per major pair

Hard constraints: lower tiers MUST follow. Can be triggered early by any expert detecting regime shift. After bot restart, first action is always a fresh Strategic Session before any trading.

### Tier 2: Tactical Session (1x/hour)

Medium panel: GPT Analyst + Grok Challenger. Works WITHIN DailyDirective.

Output: `HourlyPlan` stored in DB:
- `watchlist`: ranked pairs for next hour
- `entry_zones`: specific price levels for entries
- `position_notes`: adjust/hold/close guidance for open positions
- `escalate_daily`: bool flag to request early strategic session

### Tier 3: Execution Session (every ~10 min, current Brain)

Minimal: 1 GPT call with Daily + Hourly context injected. Fast decision: LONG/SHORT/CLOSE/HOLD/ADJUST.

Can escalate to Tier 2 if anomaly detected. Watchdog anomaly auto-triggers Tier 2.

### Escalation Flow

```
Watchdog anomaly (price >2%/min) --> auto Tier 2
Tier 3 sees regime shift           --> escalate to Tier 2
Tier 2 sees macro regime change    --> escalate to Tier 1
Any expert can request             --> escalate_daily: true
```

## Dynamic Expert System

### Expert Pool

| Expert | LLM | Role | Default Tiers |
|--------|-----|------|---------------|
| `strategist` | GPT | General analysis, plan | T1 always, T2 on request |
| `risk_manager` | GPT | SL/TP, sizing, exposure | T1-T2 always |
| `market_structure` | GPT | Levels, liquidity, order flow | T1-T2 on request |
| `grok_sentinel` | Grok | Real-time X/Twitter + web search | T1 always, others on request |
| `grok_challenger` | Grok | Contrarian: GPT says no -> find positives, GPT says yes -> find risks | T1-T2 always |
| `grok_news` | Grok | News stream via web search | T1 always, T2 on request |
| `bull_thesis` | GPT | Arguments for long | On request from Judge |
| `bear_thesis` | GPT | Arguments for short | On request from Judge |

### Grok Prompts (maximally concise)

```
// grok_sentinel
"Crypto market right now. Search X and web. Output ONLY:
MOOD: <1 word>
FEAR_EVENT: <yes/no + 5 words if yes>
NARRATIVE: <1 sentence max>
UNUSUAL: <any black swan signal, 5 words max, or NONE>"

// grok_challenger (contrarian)
"GPT decided: {decision}. Find reasons this is WRONG.
Search X/web for counter-evidence.
Output ONLY:
COUNTER: <1 sentence>
EVIDENCE: <source + 5 words>
RISK_MISSED: <1 sentence>
VETO: <YES/NO>"

// grok_news
"Crypto news last {hours}h. Search web.
Output ONLY as list, max 5 items:
- [IMPACT 1-10] [PAIR or ALL] <headline 10 words max>
Skip noise. Only market-moving events."
```

### Dynamic Calling

Experts can include in their response:
```json
{
  "analysis": "...",
  "consult": ["grok_sentinel", "market_structure"],
  "escalate": "daily"
}
```

Judge can add experts after Phase 1:
```json
{
  "additional_experts": ["bull_thesis"],
  "reason": "all experts bearish but funding suggests squeeze"
}
```

Max 2 recursions (A -> B -> C -> stop).

### Budget Caps per Tier

- Tier 1 (daily): up to 15 LLM calls
- Tier 2 (hourly): up to 8 LLM calls
- Tier 3 (execution): up to 4 LLM calls

## Critical Fixes (Phase 1)

### Execution Bugs

1. **Price rounding**: `roundPrice()` hardcoded 2dp -> fetch `tickSize` from `exchangeInfo`, round per-pair
2. **Circuit breaker**: no recovery -> add half-open state, retry after 60s
3. **Grok wiring**: verify `XAI_API_KEY` flows to FlashCrash + GrokGrounder + Swarm narrative_expert

### Dead Features to Activate

4. **Episodic Memory**: add `addEpisode()` call after every CLOSE in trading loop
5. **FilterProfile SL/TP**: wire `slStyle`/`tpStyle` in `orders.ts` (trailing for BullTrend, ATR for Breakout)
6. **regime_override**: if LLM outputs override -> change `marketRegime` for that cycle
7. **Watchdog -> Brain wake**: anomaly callback triggers `brain.runOnce()` via EventEmitter
8. **Rich watchdog summary**: include anomalies, funding changes, L/S ratio shifts
9. **MemoryReview decisions**: pass last 20 decisions from DB instead of `[]`
10. **Per-pair confluence**: compute confluence per pair, not BTC-only

## Conversion Strategy

How to go from 0.8% to 10%+:

1. DailyDirective focuses search -- bot knows WHAT to look for
2. Per-pair confluence -- SOL can breakout while BTC ranges
3. Grok challenger gives second chance -- reduces false negatives
4. Price rounding fix -- 11 ORDER_FAIL = 11 lost trades
5. HourlyPlan entry zones -- Tier 3 only checks "are we at the level?"
6. Watchdog anomaly wake -- spike >2% = immediate Brain cycle

## DB Schema (New Tables)

```sql
CREATE TABLE daily_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  allowed_pairs TEXT[],
  pair_bias JSONB,
  max_exposure_pct NUMERIC,
  risk_appetite TEXT,
  banned_pairs TEXT[],
  key_levels JSONB,
  reasoning TEXT,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE hourly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  directive_id UUID REFERENCES daily_directives(id),
  cycle_id UUID REFERENCES cycles(id),
  watchlist TEXT[],
  entry_zones JSONB,
  position_notes JSONB,
  escalate_daily BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE expert_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id UUID REFERENCES cycles(id),
  tier TEXT,
  expert_name TEXT,
  llm_provider TEXT,
  input_tokens INT,
  output_tokens INT,
  result JSONB,
  consulted_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Phased Delivery

### Phase 1: Unlock Trades (1-2 days)
- Price rounding fix
- Circuit breaker auto-recovery
- Wire Grok (FlashCrash, GrokGrounder, Swarm narrative)
- Activate episodic memory writes
- Rich watchdog summary
- Per-pair confluence

### Phase 2: Tiered Sessions (3-5 days)
- DB tables: `daily_directives`, `hourly_plans`
- `StrategicSession` class -- daily Grok+GPT full analysis
- `TacticalSession` class -- hourly within directive
- Refactor `TradingLoop.runOnce()` to consume directive+plan
- Watchdog anomaly -> Tier 2 escalation
- Scheduler (cron-like in-process)

### Phase 3: Dynamic Experts (3-5 days)
- Expert pool registry
- `consult_expert()` tool-call parsing in expert responses
- Judge routing logic (gap detection)
- Grok challenger integration at all tiers
- Grok news stream (periodic web search)
- Budget caps per tier
- Escalation logic (expert -> higher tier)

### Phase 4: Polish (1-2 days)
- FilterProfile SL/TP styles wiring
- regime_override application
- MemoryReview with real decision log
- GH issues for remaining items

## Issue Tracker

All issues can be worked on **in parallel** -- no blocking dependencies within a phase.

### Dashboard / Balance (independent)
| Issue | Title | Plan |
|-------|-------|------|
| [#2](https://github.com/mykolat/indic-bot/issues/2) | Dashboard: Margin Balance + Unrealized PnL | `issue-02-margin-balance.md` |
| [#3](https://github.com/mykolat/indic-bot/issues/3) | Dashboard: BNB balance | `issue-03-bnb-balance.md` |
| [#4](https://github.com/mykolat/indic-bot/issues/4) | Dashboard: ROI % and margin per position | `issue-04-roi-margin.md` |
| [#5](https://github.com/mykolat/indic-bot/issues/5) | Clarify Session PnL | `issue-05-session-pnl.md` |
| [#6](https://github.com/mykolat/indic-bot/issues/6) | LLM total balance (BNB + earn) | `issue-06-total-balance.md` |

### Phase 1: Unlock Trades (independent, parallelizable)
| Issue | Title | Plan |
|-------|-------|------|
| [#10](https://github.com/mykolat/indic-bot/issues/10) | Price rounding 2dp -- 11 ORDER_FAIL | `issue-10-price-rounding.md` |
| [#12](https://github.com/mykolat/indic-bot/issues/12) | Circuit breaker no recovery | `issue-12-circuit-breaker.md` |
| [#11](https://github.com/mykolat/indic-bot/issues/11) | Grok not used ($0 spent) | `issue-11-grok-wiring.md` |
| [#7](https://github.com/mykolat/indic-bot/issues/7) | Episodic Memory never written | `issue-07-episodic-write.md` |
| [#13](https://github.com/mykolat/indic-bot/issues/13) | Watchdog anomalies don't wake Brain | `issue-13-watchdog-wake.md` |
| [#14](https://github.com/mykolat/indic-bot/issues/14) | Watchdog summary thin | `issue-14-rich-watchdog-summary.md` |
| [#15](https://github.com/mykolat/indic-bot/issues/15) | Confluence BTC-only | `issue-15-per-pair-confluence.md` |

### Phase 2-3: Intelligence Reform
| Issue | Title | Plan |
|-------|-------|------|
| [#16](https://github.com/mykolat/indic-bot/issues/16) | Swarm ineffective | `issue-16-swarm-reform.md` |
| [#19](https://github.com/mykolat/indic-bot/issues/19) | LLM pair fixation | `issue-19-pair-fixation.md` |
| [#18](https://github.com/mykolat/indic-bot/issues/18) | FlashCrash no confirmation | `issue-18-flashcrash-confirm.md` |

### Phase 4: Polish
| Issue | Title | Plan |
|-------|-------|------|
| [#8](https://github.com/mykolat/indic-bot/issues/8) | FilterProfile SL/TP unused | `issue-08-sl-tp-styles.md` |
| [#9](https://github.com/mykolat/indic-bot/issues/9) | regime_override not applied | `issue-09-regime-override.md` |
| [#17](https://github.com/mykolat/indic-bot/issues/17) | MemoryReview empty decisions | `issue-17-memory-decisions.md` |

### EPIC
| Issue | Title |
|-------|-------|
| [#20](https://github.com/mykolat/indic-bot/issues/20) | Tiered Intelligence Architecture v2 |

## Parallelization Notes

All issues within the same phase are **independent** and can be worked on simultaneously in separate worktrees or sessions. Cross-phase dependencies:
- Phase 2-3 issues (#16, #19) benefit from Phase 1 (#15 per-pair confluence) but are not blocked
- Phase 4 issues are polish and can start anytime after Phase 1
