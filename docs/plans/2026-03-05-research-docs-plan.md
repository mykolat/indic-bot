# Research, Code Audit & Documentation Update — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create comprehensive `docs/research.md` for Gemini Deep Research (AS-IS architecture + code audit findings + planned features + questions), and update CLAUDE.md + ARCHITECTURE.md to match current codebase.

**Architecture:** 5 parallel code audit agents scan each module for bugs/illogical patterns/tech debt. Results collected into research.md. Documentation files updated to reflect current state.

**Tech Stack:** No code changes — documentation and research only.

---

### Task 1: Run parallel code audit (5 agents)

Launch 5 agents in parallel. Each agent reads all files in its module and reports:
- **Bugs** — actual errors or incorrect behavior
- **Illogical patterns** — code that works but doesn't make sense
- **Tech debt** — things that should be refactored
- **Missing error handling** — unprotected API calls, uncaught exceptions
- **Security concerns** — potential vulnerabilities
- **Unused code** — dead code, unused imports/dependencies

**Agent 1: LLM Layer**
Files: `src/llm/client.ts`, `src/llm/fallback-client.ts`, `src/llm/prompts.ts`, `src/llm/oauth.ts`, `src/llm/token-logger.ts`
Focus: JSON parsing reliability, SSE streaming error handling, OAuth token lifecycle, prompt construction correctness, token estimation accuracy.

**Agent 2: Risk Management + Order Execution**
Files: `src/risk/manager.ts`, `src/binance/orders.ts`, `src/binance/market-data.ts`, `src/binance/client.ts`
Focus: Validation logic completeness, edge cases in order execution (partial fills, network errors), SL/TP placement, margin calculation correctness, API error mapping.

**Agent 3: News System**
Files: `src/news/cryptopanic.ts`, `src/news/news-analyst.ts`, `src/news/news-cache.ts`, `src/news/news-db.ts`, `src/news/macro-fetcher.ts`, `src/news/macro-analyst.ts`, `src/news/fear-greed.ts`, `src/news/news-fetcher.ts`, `src/news/types.ts`
Focus: API failure handling, cache staleness logic, SQLite connection lifecycle, data transformation correctness, deduplication reliability.

**Agent 4: Soul/Memory System**
Files: `src/memory/soul-keeper.ts`, `src/memory/soul-review.ts`, `src/memory/soul-stats.ts`, `src/memory/session.ts`, `src/utils/soul-utils.ts`
Focus: File I/O error handling, soul.md section parsing edge cases, stats computation correctness, memory.json schema validation, concurrent access safety.

**Agent 5: Trading Loop + Config + Utils**
Files: `src/trading-loop.ts`, `src/config.ts`, `src/index.ts`, `src/utils/circuit-breaker.ts`, `src/utils/fetch-timeout.ts`, `src/indicators/technical.ts`, `src/webhook/server.ts`, `src/webhook/signal-buffer.ts`, `src/logger/index.ts`
Focus: Cycle error handling completeness, config loading edge cases, circuit breaker state management, indicator math correctness, webhook security, signal buffer TTL logic.

**Step 1: Launch all 5 agents**

Each agent receives this prompt template:
```
You are a code auditor. Read every file listed below and produce a structured report.

FILES TO AUDIT:
[list of files with full paths]

For each file, report:
1. BUGS — actual errors that would cause incorrect behavior
2. ILLOGICAL PATTERNS — code that works but is confusing, redundant, or semantically wrong
3. TECH DEBT — things that should be refactored for maintainability
4. MISSING ERROR HANDLING — unprotected calls, swallowed errors
5. SECURITY CONCERNS — injection risks, credential exposure, unsafe operations
6. UNUSED CODE — dead code paths, unused imports

Format your report as:
### [filename]
#### Bugs
- [description + line number]
#### Illogical Patterns
- [description + line number]
(etc.)

If a category has no findings, write "None found."

Be thorough but precise. Only report real issues, not style preferences.
```

**Step 2: Collect all 5 reports**

Combine findings into a single audit document organized by severity:
1. Critical bugs
2. Important issues
3. Minor tech debt
4. Observations

---

### Task 2: Write `docs/research.md`

**Step 1: Create the file with all sections**

Write `docs/research.md` with the following structure, incorporating audit findings from Task 1:

```markdown
# Indic Bot — Deep Research Document

> This document describes the complete AS-IS state of the Indic crypto futures trading bot.
> Purpose: feed to Gemini Deep Research for industry comparison, trend analysis, and strategic recommendations.

## 1. Project Overview
[What the bot does, tech stack, deployment]

## 2. Architecture AS-IS
[Component diagram, all 32 source files, data flow per cycle, dependencies]

## 3. Trading Strategy
[Decision-making flow, multi-timeframe analysis, confluence scoring, 3-layer resilience, dynamic intervals]

## 4. Risk Management Framework
[Hard guardrails table, soft rules, session loss scaling, circuit breaker, shutdown trigger]

## 5. Soul System & Memory
[Persistent identity, self-reflection, external insights, session memory, news DB]

## 6. Code Audit Findings
[All findings from 5 audit agents, organized by severity]

## 7. Current & Planned Development
- Shark Mode (IN PROGRESS): regime-adaptive trading, 5 market regimes, adaptive filter profiles
- Config Split (DONE): config.yaml for trading params, .env for secrets
- Trading Command Center (PLANNED): multi-agent multi-source with Grok grounding
- Command Center Phase 1 (PLANNED): RSS news + xAI grounding

## 8. Questions for Deep Research
[Specific questions for Gemini]
```

Content for each section:

**Section 1 (Project Overview):** ~200 words
- Crypto futures trading bot on Binance Futures (live account)
- TypeScript ESM, Node.js, pm2 on GCP VM (Frankfurt)
- LLM-driven decisions (OpenAI Codex API) + hard-coded risk guardrails
- 8 trading pairs, 24/7 operation
- 32 source files, 19 test files, ~3655 LOC

**Section 2 (Architecture):** ~800 words
- Full component diagram (from ARCHITECTURE.md, updated)
- All source files listed with descriptions (from exploration data)
- Data flow per cycle (10 steps)
- Dependencies table
- File structure tree

**Section 3 (Trading Strategy):** ~600 words
- LLM proposes → Risk validates → Code executes
- System prompt rules: multi-timeframe, confluence 3/5, RSI zones, volume threshold
- 3-layer resilience: Codex (full) → Fallback (HOLD/CLOSE) → Rules (emergency)
- Dynamic loop intervals (LLM sets next_check_minutes 1-30)
- Enriched prompt: soul.md + technicals + news + macro + trade performance

**Section 4 (Risk Management):** ~400 words
- Copy the 8-row guardrails table from ARCHITECTURE.md
- Session loss scaling rules (5% halve, 10% cap)
- F&G leverage cap
- 4h trend confirmation
- Circuit breaker (3 consecutive Binance failures)
- Churn cooldown (15min after close)

**Section 5 (Soul System):** ~300 words
- soul.md structure (8 sections, who writes what)
- SoulReview agent (every ~20 cycles or after 3 losses)
- External insights injection (CLI)
- Session memory (memory.json: notes, 20 trades, start_balance)
- News DB (SQLite, dedup by title+date)

**Section 6 (Code Audit):** ~800 words
- All findings from 5 agents, organized:
  - Critical bugs (if any)
  - Important issues
  - Minor tech debt
  - Observations
- Include file:line references

**Section 7 (Current & Planned):** ~600 words
- Shark Mode (IN PROGRESS): 5 regimes, adaptive filters, LLM override, decision journal, trade stories
- Config Split (DONE): secrets in .env, params in config.yaml
- Command Center (PLANNED): multi-agent (5 analysts + 1 trader), multi-source (RSS, Twitter, Reddit, Arkham, Grok), SQLite briefings
- Phase 1 plan: RSS + Grok grounding (partially started: fast-xml-parser installed, NewsFetcher interface created)

**Section 8 (Questions):** ~400 words
```
### Architecture & Design
1. How does our monolithic trading loop compare to event-driven architectures used by professional algo trading firms?
2. Is our 3-layer LLM resilience pattern (primary → fallback → rules) a best practice, or are there better patterns for LLM-critical systems?
3. Should the bot be split into microservices (data collection, analysis, execution) or is the current monolith appropriate for this scale?

### Trading Strategy
4. How do professional quant funds handle market regime detection? Compare our planned 5-regime classifier with industry approaches.
5. Is LLM-based trading decision-making a viable approach? What are the current trends and academic research in this area?
6. Our confluence scoring (3/5 factors) is hardcoded — are there better approaches like dynamic factor weighting or ML-based confluence?

### Risk Management
7. How does our risk framework compare to industry standards? What guardrails are we missing?
8. Is our session-based P&L tracking (resetting on restart) appropriate, or should we use rolling-window or daily P&L limits?
9. What are best practices for position sizing in crypto futures? Compare our fixed-percentage approach with Kelly criterion, volatility-targeting, or risk-parity.

### Operations & Infrastructure
10. What are the best practices for backtesting LLM-based trading strategies? How do you avoid overfitting when the "model" is an LLM?
11. How should we monitor bot health and performance in production? What metrics matter most?
12. What are current trends in cost optimization for multi-LLM agent architectures?

### Market Data & Intelligence
13. What data sources do professional crypto trading firms use beyond what we have (technicals, funding, OI, F&G, news)?
14. How effective is social sentiment (Twitter/Reddit) for crypto trading signal generation? What's the research say?
15. What's the state of on-chain analytics for trading? Is whale tracking (Arkham) actionable for short-term futures trading?

### Roadmap
16. Given our current architecture and planned features (Shark Mode, Command Center), what should be our development priorities?
17. What's the ROI of adding more data sources vs improving the existing decision-making quality?
18. Should we invest in backtesting infrastructure before adding more features?
```

**Step 2: Review and verify**

Read the written file to verify completeness and accuracy.

---

### Task 3: Update `docs/ARCHITECTURE.md`

**Step 1: Read current ARCHITECTURE.md**

File: `docs/ARCHITECTURE.md` (167 lines, last updated when soul system was added)

**Step 2: Update the following sections**

Changes needed:
1. **Component Diagram** — add: `config.yaml` as config source, `NewsFetcher` interface, dynamic loop interval flow
2. **Data Flow Per Cycle** — add step for dynamic interval decision (`next_check_minutes`)
3. **Configuration** section — update to show config.yaml as primary source, note config split is implemented
4. **Soul System** — already documented, verify accuracy
5. **Add new section: "LLM Resilience"** — document the 3-layer fallback in dedicated section (currently mentioned in CLAUDE.md but not ARCHITECTURE.md)
6. **Add "In Development" section** — Shark Mode (regime-adaptive trading) briefly described

**Step 3: Verify changes**

Read the file again to ensure consistency.

**Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: update ARCHITECTURE.md — config split, dynamic intervals, resilience layers"
```

---

### Task 4: Update `CLAUDE.md`

**Step 1: Read current CLAUDE.md**

File: `CLAUDE.md` (root of project, ~160 lines)

**Step 2: Apply these specific changes**

1. **Architecture section** — update `src/config.ts` description: remove "Currently all params read from `process.env` with hardcoded defaults". Replace with: "`loadConfig()` reads `config.yaml` for trading params, `.env` for secrets only. Fallback to hardcoded defaults if `config.yaml` missing."

2. **Config split** — update description:
   - `.env` description: keep as is (secrets only)
   - Add `config.yaml` description: "All trading parameters, LLM model config, webhook port. Git-versioned. Read by `loadConfig()` via `js-yaml`."

3. **News system** — add `news-fetcher.ts` to the list: "Common `NewsFetcher` interface for all news sources"

4. **Planned (not yet implemented)** section — update:
   - Remove or update `config.yaml` migration line (it's done)
   - Add: Shark Mode (regime-adaptive trading) — IN PROGRESS
   - Add: Command Center Phase 1 (RSS + Grok grounding) — PLANNED

5. **Key Gotchas** — add:
   - `config.yaml` is read at startup. Changes require `pm2 restart`.
   - `NewsFetcher` interface allows swapping news sources without changing TradingLoop.

**Step 3: Verify changes**

Read the updated file.

**Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md — config split done, add Shark Mode & Command Center status"
```

---

### Task 5: Final commit of research.md

**Step 1: Commit research.md**

```bash
git add docs/research.md docs/plans/2026-03-05-research-docs-design.md docs/plans/2026-03-05-research-docs-plan.md
git commit -m "docs: add research.md — comprehensive AS-IS analysis for deep research"
```

---

### Summary

| Task | Deliverable | Depends On |
|------|------------|------------|
| 1 | Code audit (5 parallel agents) | — |
| 2 | `docs/research.md` | Task 1 (audit findings) |
| 3 | Updated `docs/ARCHITECTURE.md` | — |
| 4 | Updated `CLAUDE.md` | — |
| 5 | Final commit | Tasks 2-4 |

Tasks 1, 3, 4 can run in parallel. Task 2 depends on Task 1. Task 5 depends on all.
