# Execution Status — Indic Bot

> **For Claude:** Read this file first in any new session for full context.

## Current State

**Branch:** `main` (feat/max-info-fetch merged)
**Tests:** 324/324 pass (45 files)
**Last deploy:** 2026-03-07 — GCP VM live, bot trading real capital
**Open issues:** #21 (EPIC v3 — future work, not blocking)

---

## All Completed Work

### Phase 1 — Unlock Trades
| Issue | Title | Status |
|-------|-------|--------|
| #10 | Price rounding per-pair tickSize | ✓ `a16dc1c`, `af6d416`, `789b471` |
| #12 | Circuit breaker half-open recovery | ✓ `2f2cd2d` |
| #11 | Grok wiring (flash crash, swarm narrative) | ✓ |
| #7  | Episodic memory write in production | ✓ |
| #13 | Watchdog wake Brain on anomaly | ✓ |
| #14 | Rich watchdog summary | ✓ |
| #15 | Per-pair confluence (all 8 pairs) | ✓ |

### Phase 2-3 — Intelligence Reform
| Issue | Title | Status |
|-------|-------|--------|
| #16 | Swarm reform (86% HOLD, 28% fail) | ✓ multi-level judge + DA contrarian + dedup |
| #19 | LLM pair fixation | ✓ pair diversity tracker |
| #18 | FlashCrash 2-of-3 confirmation | ✓ Grok + price + volume |

### Phase 4 — Polish
| Issue | Title | Status |
|-------|-------|--------|
| #8  | FilterProfile SL/TP styles | ✓ regime-aware SL/TP |
| #9  | regime_override applied from DB | ✓ |
| #17 | MemoryReview receives decision log | ✓ |

### Dashboard
| Issue | Title | Status |
|-------|-------|--------|
| #2  | Margin balance | ✓ |
| #3  | BNB balance | ✓ |
| #4  | ROI % + margin per position | ✓ |
| #5  | Session PnL clarification | ✓ |
| #6  | Total balance (BNB + earn) | ✓ |

---

## Shipped Without Issues

Significant work done outside the issue tracker:

| Feature | Commits | Description |
|---------|---------|-------------|
| Blackboard SwarmAgent | `ec88177`, `547f0e4` | Shared state, conflict detection, parallel reads, conflict-only reruns |
| Swarm Chat UI | `bb158b8` | Messenger-style debate viewer, superuser injection, LevelDivider |
| Dashboard full redesign | `de8e305`, `8c0ff1a`, `87a1160` | 7 pages, Recharts, Framer Motion, ConflictCard, BlackboardStateCard |
| DA contrarian prompt | `3e0f28b` | Devil's Advocate forced OPPOSITE — must never agree with majority |
| Fingerprint dedup + TTL | `a445a02`, `c7471d0` | Skip swarm if market state unchanged; 30-min TTL cache |
| Watchdog dual-loop | `e368557` | Watchdog (1min algo) + Brain (10min AI) separation |
| DB observability | `d806481` | 20 Supabase tables, pg dual-write across all modules |
| audit:db script | `907facf` | Full DB audit: conversations, personas, token usage |
| README pitch deck | `e86a8cf` | Live results, algorithms breakdown, OSS community framing |

---

## Live Results (as of 2026-03-07)

| Metric | Value |
|--------|-------|
| Win rate | 100% (2/2 trades) |
| Best trade | +20% |
| Avg return | +10.3% |
| Avg hold | ~3 hours |

---

## Next — EPIC #21

**3-tier sessions + dynamic expert pool** (not blocking, future work):
- `StrategicSession` — 3x/day, DailyDirective (allowed pairs, bias, exposure caps)
- `TacticalSession` — hourly, HourlyPlan (entry zones, watchlist)
- `consult_expert()` tool-call pattern for judge
- Token budget caps per tier

Design doc: `docs/plans/2026-03-06-tiered-intelligence-design.md`

---

## Key Technical Notes

- TypeScript ESM — all imports use `.js` extension
- Vitest: `import { describe, it, expect, vi } from 'vitest'`
- Binance Futures: `submitNewAlgoOrder` with `triggerPrice` (NOT `stopPrice`)
- Never read `.env` — use `loadConfig()`
- DB writes are fire-and-forget with `.catch(() => {})`
- `pm2 restart indic-bot` picks up `config.yaml` changes; `--update-env` for `.env` changes

## Deploy

```bash
npm run deploy   # rsync to GCP + pm2 restart
npm run test     # 324 tests before deploying
```
