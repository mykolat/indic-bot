# Indic Bot — Development History

## Overview

Indic Bot is a production crypto futures trading bot built in 36 hours (2026-03-04 02:27 to 2026-03-05 13:08) by a single developer using Claude Code as the primary AI collaborator. 174 commits. The system runs live on Binance Futures with a 3-layer LLM resilience stack, Grok-powered risk guards, multi-persona swarm consensus, graph RAG episodic memory, and a 19-table PostgreSQL observability backend. It trades multiple pairs with configurable leverage, stops, and take-profits — fully autonomous.

---

## Before LLM: What This Would Have Cost (2021 Estimate)

| Component | Standalone Effort |
|---|---|
| Binance Futures integration (orders, positions, SL/TP) | 2–3 weeks |
| LLM client with SSE streaming + JSON extraction + retry | 1–2 weeks |
| 3-layer resilience (OAuth, fallback API, rule-based) + CircuitBreaker | 1–2 weeks |
| News pipeline (CryptoPanic + RSS + SQLite dedup + analyst agent) | 2–3 weeks |
| Macro fetcher (Yahoo Finance via Apify + analyst LLM) | 1 week |
| Memory system (soul.md, SessionMemory, MemoryReview, EpisodicStore) | 2–3 weeks |
| Swarm consensus (3 personas + Grok narrative expert) | 1–2 weeks |
| Graph RAG (embeddings, cosine search, EpisodicAgent) | 2–3 weeks |
| Risk manager with regime-aware validation | 1–2 weeks |
| Market regime classifier + filter profiles (5 regimes) | 1 week |
| Audit system (live snapshot + markdown report) | 1 week |
| Observability DB (19-table PostgreSQL + pgvector) | 2–3 weeks |
| TradingView webhook server + dynamic loop interval | 1 week |
| DevilsAdvocate + FlashCrashScanner (Grok-powered) | 1 week |
| Config split (config.yaml + .env), deploy scripts, CLAUDE.md | 1 week |
| Test suite (Vitest, 15+ test files) | 1–2 weeks |
| **Total** | **34–47 weeks** |

Claude Code compressed 34–47 weeks of solo engineering into 36 hours. The key acceleration factors were: Claude generating scaffolding, tests, and documentation in parallel with design decisions rather than sequentially; the developer acting as architect and reviewer rather than implementer; bite-sized commits keeping context sharp; and a skill-based workflow (`brainstorm-indic`, `audit-report`) that packaged multi-step workflows into single prompts. At 40-hour work weeks, the 34–47 week pre-LLM estimate represents 1,360–1,880 hours of solo engineering. Compressed into 36 hours with Claude Code as AI collaborator, the acceleration factor is approximately 38–52x.

---

## Phase 0 — Design (2026-03-04 02:27)

Commits `ab5b1dd` and `be6f5a5` laid down the MVP design document and implementation plan before any code existed. This is not ceremonial — design-first with an LLM collaborator is structurally different from design-first alone. The design document becomes the LLM's context anchor for every subsequent session, preventing architectural drift across 174 commits and 36 hours. Without this, each new session would have required re-explaining intent. The implementation plan broke the work into phases that mapped directly to git history as it unfolded.

## Phase 1 — Core Engine (2026-03-04 02:54–15:00)

The scaffold (`6c937be`) set TypeScript ESM with NodeNext module resolution — a deliberate choice that forced `.js` extensions on all imports at the cost of early friction but gave native ESM semantics throughout. Binance client, market data, orders, and LLM client followed in one commit (`8329ee3`), then webhook server, trading loop, and entry point (`6c081ef`).

Two architectural decisions made here shaped everything downstream. First: OpenAI OAuth via pi-ai (`2edf773`) rather than a static API key — this gave the ChatGPT Codex backend (SSE streaming, `5dd8f57`) with its larger context window. Second: the SL failure = cancel trade rule (`4ce0bca`). If stop-loss placement fails after a MARKET entry, the position is immediately closed. This is correct: an open leveraged position without a stop is a risk management failure, not a recoverable state. Leaving it open and retrying later would be worse than the entry/exit spread cost.

The single-process trading loop (no microservices, no queues) was a deliberate simplicity choice. A futures bot at this scale does not need distributed infrastructure — it needs reliability and fast iteration. One process, one loop, `Promise.allSettled` for pair parallelism, circuit breaker for Binance failures.

SessionMemory (`0de0c27`) and performance snapshot logging (`5e92623`) went in during this phase. Logging from day one compounds: by Phase 8, the bot had 36 hours of `decisions.jsonl`, `performance.jsonl`, and `trades.jsonl` to audit against.

## Phase 2 — News, Risk, Audit (2026-03-04 15:00–19:00)

News came before macro because it is more operationally urgent: a CryptoPanic headline about an exchange hack can move a pair 20% in minutes. Macro data (oil, DXY, VIX) moves slower and matters more for trend direction than for immediate entry/exit signals.

The `NewsAnalystAgent` (`b17efe3`) classifying headlines into structured `NewsAnalysis` objects (importance 1–10, direction, catalyst) rather than passing raw headlines to the main LLM was a deliberate separation. The main LLM prompt is already large; structured signals rather than raw text keep it focused on decision-making rather than parsing.

The audit script (`97785c2`) arrived in this phase alongside the first stop-loss fix. Audit from day one is not premature — it is the feedback loop. Without it, the developer cannot distinguish a broken order from a losing trade.

The anti-churn cooldown (`15c205b`) went in here: after closing a position, the bot waits before re-entering the same pair. This prevents the LLM from flip-flopping on ambiguous signals and churning fees.

## Phase 3 — Macro, Memory, Token Tracking (2026-03-04 19:00–23:00)

`MacroFetcher` (`b0e6727`) pulled WTI oil, DXY, S&P500, VIX, EUR/USD, and gold via Yahoo Finance through Apify, plus BTC dominance via CoinGecko. `MacroAnalystAgent` distilled these into a `MacroAnalysis` struct injected into the main prompt. Macro context matters because crypto trades are not isolated — a DXY spike often correlates with BTC selling.

`NewsDB` (`2075dc2`) added SQLite persistence for news, deduplicating by `(title, date)`. The in-memory `NewsCache` was fast but lost history on restart. SQLite gave a persistent news accumulation layer without the operational complexity of a full database at this stage.

`TokenLogger` (`5819794`) logged tokens in/out per LLM call from day one of macro integration. Token tracking is not vanity — it is the only way to know whether a prompt architecture change is making the LLM cheaper or more expensive. By the end of the sprint, the TOKEN USAGE section in the audit (`ba8035c`) showed real per-cycle costs.

The `soul.md` concept emerged here (`3de7f81`): a persistent identity document injected into the LLM prompt to give the bot continuity across restarts. The "Big Brother" pattern — injecting external insights into `soul.md` via `npm run soul:insight` — lets the developer guide the bot's behavior without changing code.

## Phase 4 — 3-Layer LLM Resilience (2026-03-04 23:00–24:00)

A live trading bot cannot stop because the primary LLM API is down. The 3-layer architecture addresses this:

- Layer 1: ChatGPT Codex via OAuth (`LLMClient`) — full prompt, swarm if needed
- Layer 2: `FallbackLLMClient` (`0f5367e`) — standard OpenAI API via `OPENAI_API_KEY_FALLBACK`, minimal prompt, HOLD/CLOSE only, `gpt-4o-mini`
- Layer 3: Rule-based (`b430943`) — no LLM at all; enforce SL/TP on Binance; if `sessionPnlPct < -5%`, close all

`CircuitBreaker` (`2efae0f`) covers the Binance side: 3 consecutive all-fail market snapshot cycles trigger a skip cycle. This prevents the bot from acting on stale or partial market data.

`SoulKeeper` and `SoulReviewAgent` (`8d75550`, `cf841ae`) completed the memory architecture: the bot reads its own soul, reflects on it every ~20 cycles, and can update the narrative sections based on recent performance. The "Big Brother" section of `soul.md` is injected into the Layer 2 prompt and logged in Layer 3 emergency closes — making the developer's guidance visible even in degraded operating modes.

The design choice to make `LLMClient.analyze()` throw on API errors (not parse errors) (`4beb7dd`) was precise: parse errors return `[]` (HOLD all), which is safe. API errors are infrastructure failures that should trigger layer switching.

## Phase 5 — Trading Command Center (2026-03-05 00:00–02:00)

The `config.yaml` / `.env` split (`41c99dc`) separated concerns that belong apart: `.env` holds secrets (never logged, never read directly, never committed), `config.yaml` holds trading parameters (git-versioned, human-readable, hot-reloadable via `pm2 restart`). Before this split, config was scattered across hardcoded defaults in TypeScript.

Dynamic loop interval (`003677c`) was significant: instead of a fixed polling cadence, the LLM sets `next_check_minutes` (1–30) in each response. During high-volatility moments the bot checks every minute; during quiet periods it backs off to 20–30 minutes. This reduces API costs and lets the LLM's own confidence modulate the cycle frequency.

RSS multi-source news (`da456ae`) added CoinDesk, CoinTelegraph, and Decrypt as parallel sources to CryptoPanic. `RssNewsFetcher` used `fast-xml-parser` — no Apify dependency, which meant no cost and no rate limiting. `SourceHealthMonitor` (`537b319`) tracked per-source success/failure rates so degraded sources were deprioritized automatically.

`GrokGrounder` (`97901c8`) introduced xAI's API for claim verification: high-importance news items flagged with `needs_grounding: true` by `NewsAnalystAgent` were fact-checked against X/Twitter before entering the main prompt.

Market regime classifier (`b41f9ca`) defined 5 regimes (BullTrend, BearTrend, Range, Breakout, Capitulation) with associated filter profiles — different RSI ranges, volume minimums, confluence thresholds, leverage multipliers, and SL/TP styles per regime. The `DecisionJournal` (`2d80020`) logged which filters were applied for every decision, making the regime system auditable.

## Phase 6 — Swarm Consensus + Graph RAG (2026-03-05 02:00–07:00)

The Mandatory CoT Checklist schema (`f79e7ac`) enforced structured reasoning fields in LLM responses: `macro_risk_score`, `liquidation_sweep`, `order_book_imbalance`, `confluence_score`, and others. This was a quality gate — responses without these fields were rejected or flagged — ensuring the LLM reasoned about specific risk dimensions rather than producing generic analysis.

`EmbeddingClient` (`7f7395e`) and `EpisodicStore` (`daef305`) implemented graph RAG: the current market state is embedded with `text-embedding-3-small`, and cosine similarity search (threshold 0.7) retrieves similar past episodes from `memory-graph.json`. `EpisodicAgent` (`96d937a`) formats the retrieved episodes as context injected into the main prompt. The reasoning: pattern recognition in market data is exactly the kind of task where retrieval-augmented generation outperforms a fresh LLM call — past episodes contain labeled outcomes (what happened after similar setups).

`SwarmAgent` (`6e068ef`) ran 3 personas in parallel (permabull, permabear, paranoid_risk_manager) plus an optional 4th Grok `narrative_expert`. Weighted consensus replaced single-model opinion when BTC `volumeRatio > 1.5` — high volatility is exactly when a single model's bias is most dangerous. Three opposing personas with explicit role prompts surface disagreements that a single call would average away.

`GrokClient` (`20a6cbf`) was a generic xAI API wrapper. `DevilsAdvocate` (`2ff838e`) used it to search X/Twitter for reasons NOT to enter a proposed trade before execution. The pre-trade veto pattern is asymmetric in value: a veto costs one skipped opportunity; a missed veto on a bad trade costs real capital.

`FlashCrashScanner` (`653e47f`) ran at the start of every cycle — Grok-powered, checking for market panic signals. PANIC state aborts the cycle entirely, which is the correct response: during a flash crash, all analysis is based on stale prices and the spread between bid/ask is unreliable.

## Phase 7 — Max Info Pipe (2026-03-05 04:00–07:00) *(concurrent with Phase 6)*

`feat/max-info-fetch` was developed as a concurrent branch while Phase 6 (Swarm + RAG) was ongoing on main. It was merged into main at commit `e4d85f4` (2026-03-05 04:53).

Parallel news fetching with deduplication (`3537ad3`) fetched CryptoPanic and all RSS sources simultaneously via `Promise.allSettled`, merged results, and deduplicated by `(title, date)`. The reason for deduplication at fetch time rather than storage time: the LLM context window is finite; duplicate headlines waste tokens and dilute signal.

Apify caching (`31fd460`) checked dataset age before triggering new actor runs. Apify charges per run; checking whether the latest dataset is recent enough (within the refresh window) avoids redundant runs at no cost in freshness.

Layer 1 distilled agents (`a565e46`) ran NewsExpert, MacroExpert, and MemoryExpert as parallel LLM calls each cycle, injecting their summaries as `layer1Reports` into the main prompt. This is the "sandwich architecture": specialized agents pre-digest domain-specific data so the main LLM receives distilled signals rather than raw data dumps. Context compression at the cost of 3 additional LLM calls per cycle — justified because it improves main-prompt quality and keeps the primary context within the 33k token window.

## Phase 8 — Polish & Observability (2026-03-05 07:00–13:08)

Wave fixes (commits `c354baa`, `ba152ac`, `668d191`) addressed issues found after integration: SwarmAgent resilient parsing (malformed JSON from one persona should not fail the whole consensus), EpisodicStore cap (unbounded growth of `memory-graph.json` would eventually slow cosine search), leverage ordering (lower leverage should be tried before higher in the execution path), and Layer 1 expert resilience (one expert failing should not block the other two).

Confluence calculation extracted into a pure tested function (`9d4f032`) — 5 factors (trend alignment, RSI confirmation, volume confirmation, VWAP position, ADX strength), each worth 1 point. Pure function with Vitest tests means the scoring logic is deterministic and auditable. The `performance.jsonl` entries include `confluence` (0–5) and `confluenceFactors`, so every cycle's entry quality is traceable.

News time awareness (`32ea042`) filtered expired signals and showed signal age in the prompt. A news signal from 6 hours ago is not the same as one from 10 minutes ago — the market has had time to price it in. Time-aware filtering prevents the bot from acting on stale catalysts.

The Observability DB (`src/db/`) with 19 Supabase PostgreSQL tables provided the `cycle_id` spine linking every prompt, decision, execution, and close into a traceable chain. `pgvector` stored episodic memory embeddings in the database alongside the local JSON fallback. The DB is optional — all writes are fire-and-forget with `.catch(() => {})`, so the bot runs without `DATABASE_URL` and loses no functionality except the dashboard.

---

## Phase 9 — Blackboard Swarm + Aggressive Fear Trading (2026-03-07)

The swarm system was rebuilt around a **blackboard architecture**: a shared `BlackboardState` (market context, signals, votes, risks, conflicts) that all personas read and write to. Six personas replaced the original three: `risk_manager` (RM), `bull_thesis` (BT), `bear_thesis` (BA), `market_structure` (MS), `devils_advocate` (DA), `narrative_expert` (NE). Each writes structured JSON updates — signals, vote (`HOLD|LONG|SHORT|CLOSE` with confidence and probability), risks, and explicit `conflicts_with` referencing other persona codes. A judge reads the aggregated board and decides whether to continue debate or produce a final verdict.

**Reactive Devil's Advocate** (`da-activation.ts`): DA was moved from parallel execution to a reactive post-round-1 role. After `Promise.allSettled([RM, MS, NE])` completes, `shouldActivateDA(votes)` checks whether DA adds value: exactly 1 action vote (DA amplifies), or a CLOSE vote exists (DA argues against closing). If 2+ experts already agree on direction or all vote HOLD, DA is skipped — saving a Grok API call. When activated, DA uses Grok with `web_search` + `x_search` to find real arguments backing the minority action position. The DA prompt (`buildDAPrompt`) is aggressive: "You NEVER vote HOLD. Find opportunity where others see risk."

**Leverage floor fix**: `leverageMultiplier` in filter profiles (e.g., Capitulation = 0.75x) was applied using `Math.max(1, ...)`, which meant a configured `minLeverage: 5` was reduced to 1x after multiplication. Fixed to `Math.max(minLev, ...)`. Same fix applied to weekend leverage reduction. Root cause was visible in DB (`leverage=5` in risk validation) vs `trades.jsonl` (`leverage=1` after multiplier override).

**Capitulation regime fix**: F&G < 15 alone triggered Capitulation, making the bot overly cautious during extended fear periods with low volume. Fixed: Capitulation now requires volume > 3x (real sell-off) OR (F&G < 15 AND volume > 1.5x). F&G=12 with volume=0.45x correctly classifies as Range.

**`regime_override` removed**: The LLM had a `regime_override` field that could change the algorithmic regime classification. In practice, the LLM saw F&G=12 and overrode Range → Capitulation every cycle, undoing the classifier fix. Removed entirely — the classifier is the single source of truth for regime. The LLM controls actions, confidence, and sizing; the classifier controls system filters, leverage multipliers, and SL/TP styles.

**Aggressive fear trading philosophy**: The Capitulation prompt was rewritten from "extreme caution mode, prioritize capital preservation" to "Blood in the streets. Aggressive SHORT trader. Press shorts on breakdowns, fade dead-cat bounces." The Extreme Fear policy changed from "require stronger confirmation for SHORTs" to "Fear is fuel. DEFAULT bias: SHORT." The core insight: F&G=12 with low volume means everyone is scared but nobody is selling — ideal conditions for aggressive shorts, not capital preservation.

**Token cost reduction**: Two changes to reduce ~20 LLM calls/hour to ~3-6. First, `next_check_minutes` floors enforced algorithmically: 10 min with open positions, 30 min without (quiet market). Second, HOLD reasoning changed from 2-3 sentences per pair to a single slug (`"4h_conflict"`, `"low_volume"`) — saving ~60-70% of output tokens on HOLD decisions which are the majority.

**DB retention**: `pg_cron` jobs added for `market_snapshots` and `indicator_snapshots` — both auto-delete rows older than 2 days at 04:00 UTC daily. These tables grow at ~20k rows/day but are only read for the last 10-15 minutes. Without retention, they'd reach 600k rows/month.

---

## Architectural Decisions Summary

| Decision | Reason |
|---|---|
| Single-process loop, no microservices | Reliability over scalability at this scale; fast iteration; no distributed failure modes |
| SL failure = cancel trade | An open leveraged position without a stop is an unacceptable risk state; spread cost is cheaper than liquidation |
| `config.yaml` + `.env` split | Secrets never in git; trading parameters are git-versioned and human-readable; hot-reload via pm2 restart |
| 3-layer LLM resilience | Primary API downtime must not stop the bot; each layer degrades gracefully (full → minimal → rule-based) |
| `LLMClient.analyze()` throws on API errors, returns `[]` on parse errors | API errors are infrastructure failures (trigger layer switch); parse errors are recoverable (HOLD is safe) |
| SwarmAgent triggered at volumeRatio > 1.5 | High volatility is when single-model bias is most dangerous; multi-persona consensus surfaces disagreements |
| Graph RAG episodic memory (cosine > 0.7) | Similar past setups have labeled outcomes; retrieval outperforms asking the LLM to remember |
| Reactive DA (post-round-1, conditional) | Saves Grok API calls when not needed; real search-backed arguments when activated; aggressive bias balances conservative RM |
| regime_override removed | LLM consistently overrode classifier during fear, undoing algorithmic fixes; single source of truth prevents feedback loops |
| Aggressive fear trading | F&G < 15 + low volume = scared market without sellers = SHORT opportunity, not capital preservation scenario |
| FlashCrashScanner at cycle start | All analysis is based on stale prices during a crash; aborting early is cheaper than acting on bad data |
| Dynamic loop interval (LLM sets next_check_minutes) | LLM's own confidence modulates frequency; reduces API costs in quiet periods; increases responsiveness in volatile periods |
| Layer 1 distilled agents (NewsExpert, MacroExpert, MemoryExpert) | Specialized pre-digestion keeps main prompt within 33k token context window; improves signal quality |
| Apify dataset age check before new runs | Apify charges per run; freshness check at no cost avoids redundant API spend |
| `Promise.allSettled` for market snapshots | One pair failing must not kill the whole cycle; all-fail triggers circuit breaker instead |
| Confluence as pure tested function (5 factors) | Deterministic scoring; testable without LLM; auditable via performance.jsonl per cycle |

---

## Numbers

| Metric | Value |
|---|---|
| Total duration | 36 hours (2026-03-04 02:27 to 2026-03-05 13:08) |
| Total commits | 174 |
| Files changed / created | 178 |
| Pre-LLM estimate (2021 solo) | 34–47 weeks |
| Acceleration factor | ~38–52x |
| LLM layers | 3 (Codex OAuth, OpenAI fallback, rule-based) |
| Observability tables | 19 (PostgreSQL + pgvector) |
| Market regimes | 6 (BullTrend, BearTrend, Range, Breakout, Capitulation, Scalping) |
| Confluence factors | 5 (trend, RSI, volume, VWAP, ADX) |
| Swarm personas | 6 (RM, BT, BA, MS, DA reactive, NE via Grok) |
| Observability tables | 20 (added `indicator_snapshots`) |
| News sources | CryptoPanic (Apify) + CoinDesk, CoinTelegraph, Decrypt (RSS) |
| Macro data points | WTI, DXY, S&P500, VIX, EUR/USD, Gold, BTC dominance |

---

## What Made This Possible

- **Design-first with an LLM collaborator**: The MVP design document and implementation plan (Phase 0) became the context anchor for every session. Without them, 174 commits across 36 hours would have drifted architecturally. With them, each session could resume exactly where the last ended.

- **TDD from the start**: Tests were written alongside features, not after. This meant every refactor — and there were many in the wave fixes — had a safety net. The Vitest suite caught SwarmAgent parsing regressions, EpisodicStore growth issues, and confluence scoring bugs before they reached production.

- **Bite-sized commits**: 174 commits over 36 hours is one commit every 12 minutes on average. Small, focused commits kept the LLM's context sharp (each commit message was a precise description of intent) and made `git bisect` viable if a regression appeared.

- **LLM as architect, not just coder**: Claude Code was used for architectural reasoning — choosing 3-layer resilience over 2-layer, choosing pure functions for confluence scoring, choosing `Promise.allSettled` over `Promise.all` — not just for generating boilerplate. The developer's role was to question architectural decisions, define constraints, and review outputs.

- **Skill-based workflow**: Packaging multi-step workflows into named skills (`brainstorm-indic`, `audit-report`) reduced the cognitive overhead of each session. A skill invocation replaced a complex multi-prompt sequence, letting the developer focus on what to build next rather than how to prompt for it.
