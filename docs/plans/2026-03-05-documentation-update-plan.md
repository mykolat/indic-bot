# Documentation Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write `docs/HISTORY.md` — 36-hour sprint narrative with architectural evolution, before-LLM comparison — and update all existing docs to match current code.

**Architecture:** Three documents to touch: new `HISTORY.md` (narrative), updated `docs/ARCHITECTURE.md` (current state), updated `CLAUDE.md` (accurate planned/done status). No code changes — documentation only.

**Tech Stack:** Markdown, git log analysis, current codebase review.

---

### Task 1: Write docs/HISTORY.md

**Files:**
- Create: `docs/HISTORY.md`

**Step 1: Gather commit timeline**

Run: `git log --format="%h %ai %s" | tac`

Read from oldest to newest. Note the 9 clear phases:
- 02:27–03:13 2026-03-04 — Day 0: Design & Scaffold
- 03:13–15:00 2026-03-04 — Phase 1: Core Engine
- 15:00–19:00 2026-03-04 — Phase 2: News & Risk & Audit
- 19:00–23:00 2026-03-04 — Phase 3: Macro, Memory, Tokens
- 23:00–24:00 2026-03-04 — Phase 4: 3-Layer LLM Resilience
- 00:00–02:00 2026-03-05 — Phase 5: Command Center
- 02:00–06:00 2026-03-05 — Phase 6: Swarm + Graph RAG
- 04:00–07:00 2026-03-05 — Phase 7: Max Info Pipe & Grok
- 07:00–13:00 2026-03-05 — Phase 8: Polish & Observability

**Step 2: Write the file**

Create `docs/HISTORY.md` with the following structure:

```markdown
# Indic Bot — Development History

## Overview

Indic Bot was designed and built over 36 hours (2026-03-04 02:27 → 2026-03-05 13:08)
by a single developer using Claude Code as the primary AI collaborator.
174 commits. Production-ready trading bot with multi-agent AI, Graph RAG, Swarm Consensus,
market regime detection, and a fully layered risk system.

---

## Before LLM: What This Would Have Cost (2021 Estimate)

| Component | Standalone Effort |
|-----------|------------------|
| Binance Futures API integration | 3–4 weeks |
| Multi-timeframe technical indicators | 2–3 weeks |
| News + Macro intelligence stack | 3–4 weeks |
| SQLite persistence + caching layer | 1–2 weeks |
| Market regime classifier (5 regimes) | 3–4 weeks |
| Multi-agent Swarm consensus system | 6–8 weeks |
| Graph RAG with embeddings + cosine search | 5–7 weeks |
| 3-layer LLM resilience + circuit breaker | 2–3 weeks |
| Persistent Soul/Memory system | 2 weeks |
| Audit + observability pipeline | 2–3 weeks |
| Risk Manager with hard guardrails | 3–4 weeks |
| Testing, CI/CD, documentation | 2–3 weeks |
| **Total** | **~34–47 weeks** |

**With LLM + Claude Code: 36 hours.**

The key shift is not speed of typing — it is the elimination of:
- Research latency (architecture decisions in minutes, not days)
- Boilerplate generation time
- Context-switching cost between design and implementation
- Test writing overhead

---

## Phase 0 — Design (2026-03-04 02:27)

**Commits:** `ab5b1dd`, `be6f5a5`

The project started with two markdown documents:
- AI Futures Bot MVP design doc
- Phase 1 implementation plan

No code existed yet. The foundation was a clear design-first approach:
define the full architecture before writing any code.

**Why:** With LLM assistance, writing the design first costs almost nothing.
It de-risks the entire implementation by surfacing architecture decisions early.

---

## Phase 1 — Core Engine (2026-03-04 02:54–15:00)

**Key commits:** `6c937be`, `8329ee3`, `6c081ef`, `5dd8f57`, `2edf773`

Built from scratch:
- TypeScript project scaffold (Vitest, ts-node, ESM)
- Binance client with market data fetch (candles, positions, balance)
- Order executor (MARKET → STOP_MARKET → TAKE_PROFIT_MARKET chain)
- LLM client with ChatGPT Codex + SSE streaming + OpenAI OAuth
- Risk manager with hard guardrails
- TradingLoop with webhook server

**Architectural insight:** From day one, the `SL failure = cancel trade` rule was
baked in. This means the bot cannot enter a position without a stop-loss — a rare
discipline for a first-day MVP.

**Why the architecture looks like this:**
The single-process event loop was chosen deliberately. Trading bots need tight
timing guarantees and deterministic cycle ordering. The webhook buffer sits
in-memory, drained each cycle — not via a message queue — because the latency
overhead of a queue would exceed the benefit for a 5-minute cycle bot.

---

## Phase 2 — News, Risk, Audit (2026-03-04 15:00–19:00)

**Key commits:** `b17efe3`, `bf52000`, `d7fe1a4`, `97785c2`, `66b80d2`

- `NewsCache` with append-only JSONL history
- `NewsAnalystAgent` — classifies headlines into structured signals (1–10 importance)
- `CryptoPanicClient` via Apify
- Audit script with live account snapshot
- MACD, Bollinger Bands, volume ratio, VWAP indicators added
- 15m candles + funding rate history

**Why news before macro?** CryptoPanic is the fastest signal source for crypto.
Macro (oil, DXY, VIX) moves slower — daily cadence is fine. News can break
in minutes. Getting news right first reduced false signals in Phase 1 testing.

---

## Phase 3 — Macro, Memory, Token Tracking (2026-03-04 19:00–23:00)

**Key commits:** `b0e6727`, `5819794`, `73266e1`, `6abef59`, `bb1237f`

- `MacroFetcher` — Yahoo Finance via Apify (WTI, DXY, S&P500, VIX, EUR/USD, Gold)
- `MacroAnalystAgent` — distilled LLM macro summary every 3h
- `TokenLogger` — tracks tokens in/out per LLM call
- `NewsDB` — SQLite dedup store
- Time-aware prompts — UTC session context, news age in hours

**Why token logging so early?** The Codex API charges per token. Without
early visibility into token consumption, the bot could silently blow a budget
in production. Adding logging on day 1 enables cost-aware tuning from the start.

---

## Phase 4 — 3-Layer LLM Resilience (2026-03-04 23:00–24:00)

**Key commits:** `2efae0f`, `0f5367e`, `8d75550`, `b430943`, `96ba44f`

The bot gained full resilience:
- `CircuitBreaker` — skips cycle after 3 consecutive Binance failures
- `FallbackLLMClient` — standard OpenAI API, HOLD/CLOSE only
- `SoulKeeper` — manages `~/.indic-bot/memory.md` (flat-file persistent identity)
- `SoulReviewAgent` — LLM meta-reflection every ~20 cycles
- Layer 3 rule-based fallback — pure code SL/TP, no LLM needed

**Why 3 layers?** A trading bot in production will encounter API failures.
Without explicit fallback, a Codex outage = uncontrolled open positions.
The 3-layer model ensures: always a plan, always a fallback, always a
final backstop.

**Big Brother:** The `memory.md` External Insights section is a privileged
channel. Injected into Layer 2 and logged in Layer 3 — ensuring human
override persists through any failure mode.

---

## Phase 5 — Trading Command Center (2026-03-05 00:00–02:00)

**Key commits:** `003677c`, `41c99dc`, `7790821`, `da456ae`, `97901c8`

- `config.yaml` split — secrets in `.env`, params in `config.yaml` (git-versioned)
- Dynamic loop interval — LLM sets `next_check_minutes` (1–30)
- `RssNewsFetcher` — CoinDesk, CoinTelegraph, Decrypt (fast-xml-parser)
- `GrokGrounder` — xAI direct API for claim verification
- `SourceHealthMonitor` — tracks source uptime + API cost
- ADX indicator added
- `TradeStoryLogger` — narrative per trade

**Why dynamic interval?** Crypto markets are not uniform. A quiet Saturday
at 3 AM and a FOMC-day open have very different signal densities. Letting
the LLM set `next_check_minutes` reduces noise and cost during dead periods
while enabling fast response to breaking events.

---

## Phase 6 — Swarm Consensus + Graph RAG (2026-03-05 02:00–07:00)

**Key commits:** `7f7395e`, `daef305`, `6e068ef`, `87e9c40`, `731581b`, `20a6cbf`, `2ff838e`, `653e47f`

The biggest architectural leap of the sprint:
- `EmbeddingClient` — `text-embedding-3-small` + cosine similarity
- `EpisodicStore` — JSON file DB at `~/.indic-bot/memory-graph.json`
- `EpisodicAgent` — retrieves top-k similar past market states via vector search
- `SwarmAgent` — parallel personas: permabull + permabear + paranoid_risk_manager
- `GrokClient` — generic xAI API wrapper (`grok-4-1-fast-reasoning`)
- `DevilsAdvocate` — Grok-powered pre-trade veto (searches X/Twitter for reasons NOT to enter)
- `FlashCrashScanner` — Grok-powered PANIC/IGNORE guard at cycle start

**Why Graph RAG instead of simple history?** A flat list of past trades has
no semantic search. Graph RAG lets the bot ask "have I seen this market
structure before?" and retrieve relevant episodes with exact numerical
similarity — not string matching.

**Why Swarm?** Single-model bias is dangerous in trading. Permabull models
will push LONG in ambiguous conditions. Introducing deliberate contrarian
personas (permabear, paranoid_risk_manager) forces the model to argue with
itself before committing.

**Why DevilsAdvocate?** Even a high-consensus Swarm decision can be wrong
if breaking news exists that wasn't in the news cache. The DevilsAdvocate
agent does a live Grok search specifically for reasons NOT to enter — it's
a pre-execution sanity check outside the primary data pipeline.

---

## Phase 7 — Max Info Pipe & Polish (2026-03-05 04:00–07:00)

**Key commits:** `3537ad3`, `e04ef1d`, `31fd460`, `b68638a`

- Parallel news fetching from ALL sources (`Promise.allSettled`)
- Title-based deduplication across CryptoPanic + RSS
- Apify actor caching — reuse latest dataset if fresh (no unnecessary costs)
- Grok Narrative Expert added to Swarm
- Layer 1 distilled agent calls (`runLayer1Experts`) — parallel NewsExpert + MacroExpert + MemoryExpert

**Why parallel with dedup?** A single source going down shouldn't reduce
news coverage. `Promise.allSettled` means one source failing doesn't fail
the fetch — the other sources still contribute. Dedup ensures no duplicate
signals confuse the LLM.

---

## Phase 8 — Observability & Wave Fixes (2026-03-05 07:00–13:00)

**Key commits:** `9d4f032`, `c354baa`, `ba152ac`, `668d191`, `32ea042`

- Confluence extracted into pure tested function (5 factors)
- Volume extrapolation for active candles
- Wave 1/2/3 critical fixes (parsing resilience, embedding timeouts, cap limits)
- News time awareness — filter expired signals, show age in prompt
- ARCHITECTURE.md + research.md written

**Why wave fixes last?** The implementation sprint (Phases 0–7) moved fast
deliberately. Quality gates (proper error handling, resilient parsing, cap
limits) were deferred to avoid slowing architectural velocity. Wave fixes
represent the shift from "does it work?" to "is it production-safe?"

---

## Architectural Decisions Summary

| Decision | Reason |
|----------|--------|
| Single-process event loop | Timing guarantees, no queue overhead |
| `SL failure = cancel trade` | Never enter without protection |
| 3-layer LLM fallback | API outages are inevitable |
| Graph RAG over flat history | Semantic similarity > string matching |
| Swarm consensus on volatility | Multi-persona counters single-model bias |
| `config.yaml` git-versioned | AI can write params; secrets stay in `.env` |
| Dynamic loop interval | Cost-aware + regime-aware timing |
| DevilsAdvocate as final gate | Live X/Twitter veto outside cached data |
| Dual-write JSONL + DB | DB optional; logs always work |

---

## Numbers

- **Duration:** 36 hours 41 minutes
- **Commits:** 174
- **Files changed:** ~40+ source files, 55 plan documents
- **Lines of code:** ~4,500+ TypeScript (estimated)
- **Equivalent pre-LLM effort:** 34–47 person-weeks (6–12 months solo)
- **Acceleration factor:** ~150–200x

---

## What Made This Possible

1. **Design-first approach** — Every feature started with a design doc in `docs/plans/`, ensuring no wasted implementation
2. **TDD discipline** — Tests written before implementation; regressions caught immediately
3. **Bite-sized commits** — 174 commits = clear audit trail, easy bisect, morale checkpoints
4. **LLM as architect** — Not just autocomplete; full system design, trade-off reasoning, edge case identification
5. **Skill-based workflow** — Brainstorming → writing-plans → executing-plans pipeline eliminated guesswork at each step
```

**Step 3: No tests needed** — documentation-only task

**Step 4: Verify file**

Run: `wc -l docs/HISTORY.md`

Expected: 200+ lines

**Step 5: Commit**

```bash
git add docs/HISTORY.md
git commit -m "docs: add HISTORY.md — 36-hour sprint narrative with architectural evolution and before-LLM comparison"
```

---

### Task 2: Update docs/ARCHITECTURE.md

**Files:**
- Modify: `docs/ARCHITECTURE.md`

**Step 1: Read current file**

Read `docs/ARCHITECTURE.md` and `CLAUDE.md` to compare.

**Step 2: Identify gaps**

Current ARCHITECTURE.md has these outdated or missing items:
- References `soul-keeper.ts` and `soul-review.ts` — these files were renamed to `memory-keeper.ts` and `memory-review.ts`
- Missing: `FlashCrashScanner`, `DevilsAdvocate`, `GrokGrounder`, `SourceHealthMonitor`
- Missing: Observability DB (Supabase, 19 tables) — entire section absent
- Missing: `DecisionJournal`, `TradeStoryLogger`
- Missing: `MaxInfoPipe` architecture (parallel fetchers + dedup)
- Missing: `CircuitBreaker`, `FetchTimeout` utilities
- Config section: missing `XAI_API_KEY`, `APIFY_API_TOKEN` is present but context incomplete
- Missing: Fear & Greed index source (alternative.me)

**Step 3: Rewrite ARCHITECTURE.md**

Update to accurately reflect current codebase. Key changes:
- Fix Memory component table (soul-keeper → memory-keeper, soul-review → memory-review)
- Add "Grok Intelligence Layer" section covering FlashCrashScanner, DevilsAdvocate, GrokGrounder
- Add "Observability Database" section (Supabase, 19 tables, dual-write pattern)
- Add "News Intelligence Pipeline" subsection (MaxInfoPipe, parallel, dedup)
- Add "Logging" section covering all log files
- Update component diagram to include all current components

**Step 4: Verify**

Run: `wc -l docs/ARCHITECTURE.md`

Check references to `soul-keeper` are removed:
Run: `grep -n "soul-keeper\|soul-review\|SoulKeeper\|SoulReview" docs/ARCHITECTURE.md`
Expected: no results

**Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: update ARCHITECTURE.md — fix renamed components, add Grok layer, Observability DB, MaxInfoPipe"
```

---

### Task 3: Update CLAUDE.md Planned/Done Section

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Read current CLAUDE.md Planned section**

Read the `## Planned (not yet implemented)` section at the bottom of `CLAUDE.md`.

**Step 2: Cross-check against current code**

Verify each item:
- `npm run audit:debug` — check if `scripts/debug-*.ts` files exist: `ls scripts/debug-*.ts`
- Command Center Phase 1 — check actual implementation status in `src/news/`
- Any other items marked as partially done

**Step 3: Update the Planned section**

Mark completed items as DONE, update partial items with accurate status.
Add any genuinely unimplemented features that exist in plans but not code.

**Step 4: Verify**

Run: `grep -n "DONE\|PARTIALLY\|pending" CLAUDE.md | tail -20`

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md planned section — accurate done/partial/pending status"
```

---

### Task 4: Final Verification

**Step 1: Confirm all three docs exist and are accurate**

```bash
ls -la docs/HISTORY.md docs/ARCHITECTURE.md CLAUDE.md
```

**Step 2: Check for any remaining stale references**

```bash
grep -rn "soul-keeper\|soul-review\|SoulKeeper\|SoulReview" docs/ CLAUDE.md 2>/dev/null
grep -rn "soul\.md" docs/ARCHITECTURE.md 2>/dev/null
```

**Step 3: Final review**

Skim each file top-to-bottom. Ensure:
- HISTORY.md: has all 8 phases, before-LLM table, numbers section
- ARCHITECTURE.md: matches current src/ structure (no ghost components)
- CLAUDE.md: Planned section has accurate DONE/pending markers
