# Execution Status — Tiered Intelligence v2

> **For Claude:** Read this file first in any new session. It contains full context for continuing work.
> Use `superpowers:executing-plans` skill to implement remaining issues.

## Current State

**Branch:** `feat/max-info-fetch`
**Tests:** 269/269 pass (40 files)
**Last deploy:** 2026-03-06 — GCP VM online with #10 + #12 fixes

## Completed

| Issue | Title | Commit |
|-------|-------|--------|
| #10 | Price rounding per-pair tickSize | `a16da1c`, `af6d416`, `789b471` |
| #12 | Circuit breaker half-open recovery | `2f2cd2d` |

## Remaining — 16 Issues

All plans are in `docs/plans/2026-03-06-issue-NN-*.md` with full TDD steps.

### Phase 1: Unlock Trades (highest priority)

| Issue | Plan file | Tasks | Key files |
|-------|-----------|-------|-----------|
| #11 | `issue-11-grok-wiring.md` | 5 | grok-client.ts, flash-crash.ts, swarm-agent.ts, index.ts |
| #7 | `issue-07-episodic-write.md` | 3 | episodic-store.ts, trading-loop.ts |
| #13 | `issue-13-watchdog-wake.md` | 4 | watchdog.ts, index.ts |
| #14 | `issue-14-rich-watchdog-summary.md` | 6 | watchdog-summary.ts |
| #15 | `issue-15-per-pair-confluence.md` | 8 | trading-loop.ts, prompts.ts, regime-classifier.ts |

### Phase 2-3: Intelligence Reform

| Issue | Plan file | Tasks | Key files |
|-------|-----------|-------|-----------|
| #16 | `issue-16-swarm-reform.md` | 10 | swarm-agent.ts |
| #19 | `issue-19-pair-fixation.md` | 11 | prompts.ts, pair-diversity.ts (new) |
| #18 | `issue-18-flashcrash-confirm.md` | 6 | flash-crash.ts, market-data.ts |

### Phase 4: Polish

| Issue | Plan file | Tasks | Key files |
|-------|-----------|-------|-----------|
| #8 | `issue-08-sl-tp-styles.md` | ? | sl-tp-styles.ts (new), orders.ts |
| #9 | `issue-09-regime-override.md` | ? | trading-loop.ts |
| #17 | `issue-17-memory-decisions.md` | ? | trading-loop.ts, memory-review.ts |

### Dashboard (independent, any time)

| Issue | Plan file | Tasks | Key files |
|-------|-----------|-------|-----------|
| #2 | `issue-02-margin-balance.md` | 4 | market-data.ts, webhook/server.ts |
| #3 | `issue-03-bnb-balance.md` | 3 | market-data.ts, webhook/server.ts |
| #4 | `issue-04-roi-margin.md` | 4 | market-data.ts, webhook/server.ts |
| #5 | `issue-05-session-pnl.md` | 4 | market-data.ts, webhook/server.ts |
| #6 | `issue-06-total-balance.md` | 5 | market-data.ts, webhook/server.ts, config.ts |

## Parallel Execution Workflow

**Batching by file overlap** — issues in same batch touch different files:

| Batch | Issues | No conflicts because |
|-------|--------|---------------------|
| A | #11, #7 | grok-client vs episodic-store |
| B | #13, #14 | watchdog.ts vs watchdog-summary.ts |
| C | #15, #17, #9 | regime-classifier vs memory-review vs trading-loop (different sections) |
| D | #16, #18 | swarm-agent.ts vs flash-crash.ts |
| E | #19 | standalone (pair-diversity.ts new file + prompts.ts) |
| F | #8 | standalone (sl-tp-styles.ts new + orders.ts) — AFTER #10 merged |
| G | #2, #3, #4, #5, #6 | all touch webhook/server.ts — run sequentially or carefully |

**Execution per issue:**
1. Read plan file: `docs/plans/2026-03-06-issue-NN-*.md`
2. Read source files referenced in plan
3. Follow TDD steps exactly: failing test -> verify fail -> implement -> verify pass -> commit
4. Run `npx vitest run` after each issue
5. Commit with `Closes #NN` in message

**Key rules:**
- TypeScript ESM — all imports use `.js` extension
- Use vitest (`import { describe, it, expect, vi } from 'vitest'`)
- Binance Futures API uses `submitNewAlgoOrder` with `triggerPrice` (NOT `submitNewOrder` with `stopPrice`)
- `OrderExecutor` constructor: `(client, stepDecimals?, priceDecimals?)` — 3rd param added by #10
- `CircuitBreaker` constructor: `(threshold?, cooldownMs?)` — 2nd param added by #12
- Never read `.env` files

## Design Document

Full architecture: `docs/plans/2026-03-06-tiered-intelligence-design.md`

Key concepts:
- **3-tier sessions**: Strategic (3x/day + restart), Tactical (hourly), Execution (10min)
- **Dynamic experts**: GPT strategist + risk_manager + Grok sentinel/challenger/news
- **Grok prompts**: maximally concise (MOOD/FEAR_EVENT/NARRATIVE/UNUSUAL format)
- **Escalation**: Tier 3 -> Tier 2 on anomaly, Tier 2 -> Tier 1 on regime shift
- **DailyDirective**: allowed_pairs, pair_bias, max_exposure, risk_appetite

## Deploy

```bash
npm run deploy  # rsync to GCP + pm2 restart
# Or manual:
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'pm2 logs indic-bot --lines 20'
```
