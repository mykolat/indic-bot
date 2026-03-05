# Research & Documentation Update — Design

**Date:** 2026-03-05
**Goal:** Create comprehensive research.md for Gemini Deep Research + code audit + update all documentation to match current codebase state.

---

## Deliverables

### 1. `docs/research.md` — Deep Research Document (~5000+ words)

Target: Gemini Deep Research (large context, thorough analysis).

**Structure:**

```
# Indic Bot — Research Document for Deep Analysis

## 1. Project Overview
   - Purpose, tech stack, deployment setup

## 2. Architecture AS-IS
   - Component diagram (32 .ts files, 19 tests)
   - Data flow per cycle (10 steps)
   - File structure with descriptions
   - Dependencies (12 prod deps)

## 3. Trading Strategy
   - Decision-making: LLM proposes → Code enforces → Execute
   - Multi-timeframe analysis (1h timing, 4h direction)
   - Confluence scoring (3/5 factors)
   - 3-layer LLM resilience (Codex → Fallback → Rules)
   - Dynamic loop intervals (LLM sets next_check_minutes)

## 4. Risk Management Framework
   - Hard guardrails table (8 checks)
   - Soft rules in prompts
   - Session loss scaling (5% halve, 10% cap)
   - Circuit breaker pattern (3 failures)
   - Max loss shutdown trigger

## 5. Soul System & Memory
   - Persistent identity (soul.md)
   - Self-reflection agent (every ~20 cycles)
   - External insights ("Big Brother")
   - Session memory (memory.json)
   - News DB (SQLite dedup)

## 6. Code Audit Findings
   - Bugs found
   - Illogical patterns
   - Tech debt
   - Unused dependencies (@mariozechner/pi-ai, fast-xml-parser)
   - Missing error handling
   - Security concerns

## 7. Current & Planned Development
   - Shark Mode (IN PROGRESS) — regime-adaptive trading, 5 regimes
   - Trading Command Center (PLANNED) — multi-agent, multi-source
   - Config Split (DONE) — config.yaml implemented
   - Command Center Phase 1 (PLANNED) — RSS + Grok grounding

## 8. Questions for Deep Research
   - How does this compare to industry best practices for algo trading bots?
   - Current trends in LLM-driven trading systems?
   - Risk framework improvements — what are we missing?
   - Architecture recommendations — microservices vs monolith for trading?
   - How do professional quant firms handle regime detection?
   - Best practices for backtesting LLM-based strategies?
   - Roadmap priority: what should come next?
   - Cost optimization for multi-LLM agent architecture?
```

### 2. `docs/ARCHITECTURE.md` — Updated

- Add: config.yaml split, dynamic loop interval, NewsFetcher interface
- Add: Shark Mode (in progress) section
- Update: file counts, dependencies
- Update: component diagram with new components

### 3. `CLAUDE.md` — Synchronized

- Add: new commands/scripts if any
- Update: stale descriptions
- Mark config.yaml as implemented (remove from Planned)
- Add Shark Mode as in-progress

### 4. Code Audit (parallel agents)

5 agents audit independently:
- **Agent 1:** LLM layer (client.ts, fallback-client.ts, prompts.ts, oauth.ts, token-logger.ts)
- **Agent 2:** Risk management + orders (manager.ts, orders.ts)
- **Agent 3:** News system (cryptopanic.ts, news-analyst.ts, news-cache.ts, news-db.ts, macro-fetcher.ts, macro-analyst.ts, fear-greed.ts)
- **Agent 4:** Soul/memory system (soul-keeper.ts, soul-review.ts, soul-stats.ts, session.ts)
- **Agent 5:** Trading loop + config + utils (trading-loop.ts, config.ts, index.ts, circuit-breaker.ts, fetch-timeout.ts)

Each agent reports: bugs, illogical patterns, tech debt, missing error handling, suggestions.

---

## Approach

1. Launch 5 code audit agents in parallel
2. Collect results
3. Write research.md incorporating audit findings
4. Update ARCHITECTURE.md
5. Update CLAUDE.md

## Key Decisions

- **Monolithic research.md** — Gemini works best with single context
- **Shark Mode = IN PROGRESS** — not planned, actively being developed
- **Config Split = DONE** — config.yaml already implemented
- **No performance data** — bot performance metrics not included (would need production log access)
