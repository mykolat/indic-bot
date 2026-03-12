# Indic Bot Architecture Audit — Mixture of Experts Review

**Date**: 2026-03-07
**Method**: 4 expert reviewers (zonal MoE + adversarial debate)
**Input**: External technical checklist (15 sections, ~300 items) vs actual codebase (10,675 LOC, 63 tests, 20 DB tables)

---

## Part 1: Executive Verdict Table

| # | Checklist Section | Status | Verdict | Reasoning |
|---|---|---|---|---|
| 1 | LLM Role Placement | ⚠️ Partial | **HIGH VALUE** (contract part) | LLM roles correct, but free-form JSON parsing is the #1 production risk |
| 2 | Decision Schema / LLM Contract | ⚠️ Partial | **HIGH VALUE** | Schema exists but not strict. `abstain_reason`, `data_gaps`, `risk_flags` missing |
| 3 | Exchange / Execution | ⚠️ Partial | **MIXED** | REST+WS hybrid works. Full WS spine = HIGH VALUE. Local order book = PREMATURE |
| 4 | Feature Layer | ✅ Mostly done | **SELECTIVE VALUE** | OI, funding, L/S ratio exist. Taker volume, basis = value. Cross-exchange premium = PREMATURE |
| 5 | News Pipeline | ✅ Mostly done | **SELECTIVE VALUE** | Sources, analyst, grounding exist. Clustering = SLOP. Half-life/expiry = ALREADY DONE |
| 6 | On-chain / Alt Intelligence | ❌ None | **PREMATURE** | Whale watchers, DEX data, stablecoin flows — zero edge proof for a futures bot this size |
| 7 | Memory / RAG | ⚠️ Partial | **SELECTIVE VALUE** | Episodic store works. Counterfactuals = THEATRE. Memory decay = value |
| 8 | LLM Strategy Templates | ❌ None | **R&D ONLY** | Narrative breakout etc. — only in shadow mode. Zero live value without replay engine |
| 9 | Risk / Portfolio | ✅ Mostly done | **HIGH VALUE** (gaps) | Beta exposure, session scaling exist. Daily/weekly limits, spread guard = real gaps |
| 10 | Evaluation / Replay | ❌ None | **HIGH VALUE** | No replay engine, no baselines. This is the biggest blind spot in the project |
| 11 | Observability | ✅ Done | **ALREADY DONE** | 20 tables, cycle_id spine, dual-write. Dashboard exists. Minor gaps only |
| 12 | Security / Ops | ✅ Mostly done | **ALREADY DONE** | IP whitelist, no withdrawal, testnet path, kill-switches. Chaos tests = PREMATURE |
| 13 | Anti-patterns | ⚠️ Some apply | **HIGH VALUE** (diagnostic) | Free-form JSON, no replay, no baselines — these are real anti-patterns present in the bot |
| 14 | Priority Recommendations | — | **PARTIALLY AGREE** | Good priorities but 40% is SLOP for current scale |
| 15 | Architecture Diagram | ✅ Match | **ALREADY DONE** | Current architecture already follows this pattern |

**Summary**: of ~300 checklist items, roughly **60 are HIGH VALUE**, **80 are ALREADY DONE**, **100 are PREMATURE/SLOP**, **60 are R&D-only**.

---

## Part 2: Expert Reviews

---

### Expert 1: Exchange Engineer

**Zone**: Sections 1 (execution), 3 (exchange transport), 4 (market data features)
**Perspective**: What keeps money safe during execution. Latency, fills, order lifecycle.

#### What I See In The Code

The execution layer is better than the checklist assumes:

- **Orders** (`src/binance/orders.ts`): REST MARKET entry with optional LIMIT (3s timeout). SL+TP via `submitNewAlgoOrder()`. SL failure = immediate position close. This is correct defensive engineering.
- **User Stream** (`src/binance/user-stream.ts`): WebSocket listener for `ORDER_TRADE_UPDATE`. Parses SL/TP fills, writes `trade_closes` to DB. Auto-reconnect with 5s backoff. This already exists.
- **Market Data** (`src/binance/market-data.ts`): Full snapshots (1h/4h/15m candles, OI, funding history, L/S ratio, 500-level order book with liquidity profile). Quick snapshots for watchdog.
- **Precision**: per-pair `stepDecimals` and `priceDecimals` cached from exchangeInfo. Issue #10 (price rounding) already fixed.

#### HIGH VALUE Items From Checklist

**1. `workingType=MARK_PRICE` for stop/trigger orders**
Currently not explicitly set. Binance defaults to `CONTRACT_PRICE` which is noisier. One line change, prevents false SL triggers during wicks. This is free money saved.

**2. `priceProtect=true` on SL orders**
Prevents SL execution at absurd prices during extreme volatility. Another one-liner. Should have been there from day one.

**3. Exchange clock sync / `recvWindow` guard**
Not implemented. If VM clock drifts >1s, orders can get rejected with `-1021 INVALID_TIMESTAMP`. Simple NTP check at startup + `recvWindow=5000` on critical orders.

**4. `newOrderRespType=RESULT`**
Currently using default (`ACK`). `RESULT` returns fill price immediately, avoids the extra `getOrder()` call. Small latency win, cleaner code.

**5. Keepalive supervisor hardening**
User stream exists but the keepalive is basic. Binance closes listen keys after 60min without ping. Need a dedicated interval (30min) + reconnect-on-stale detection. Current 5s backoff is good but not enough — need to detect "silently dead" connections.

#### SLOP / PREMATURE Items

**1. "Private WS as sole source of truth for positions"**
The checklist says REST should be "repair path only". This is wrong for a bot that trades 2-5 times per day. REST reconciliation every cycle (10-30 min) is perfectly fine as primary. WS gives you faster SL/TP detection (already implemented) but switching fully to WS as source of truth adds complexity with zero benefit at this trade frequency. WS shines at 100+ trades/day.

> **ATTACK**: The checklist author assumes HFT-grade requirements. This bot runs on 10-30 minute cycles. REST is the correct primary path. WS is supplementary.

**2. "Local order book via snapshot + depth stream"**
500-level book snapshot per cycle is already implemented. Maintaining a real-time local book via WebSocket depth stream is ~300 LOC of reconnect/sync/reorder logic for marginal gain. The bot doesn't need sub-second book state.

**3. "Event reorder / dedup logic"**
At 2-5 trades/day, you will never hit event reordering issues. This is a problem at 1000+ events/second.

**4. "Latency monitor per stream"**
Theatre. You're running on a single e2-small VM in Frankfurt. Latency monitoring adds observability cost without actionable response.

**5. "Routing under new WS endpoints /public /market /private"**
Binance migration is for new connections. The `binance` npm package handles this transparently. Zero action needed.

#### My TOP-3

1. Add `workingType: 'MARK_PRICE'` + `priceProtect: true` to all SL/TP orders — **15 minutes work, prevents false triggers**
2. Harden keepalive supervisor with 30min ping interval + stale detection — **1 hour work**
3. Add NTP clock check at startup + `recvWindow=5000` — **30 minutes work**

Total: ~2 hours for all three. Everything else in the execution section is either done or premature.

---

### Expert 2: Quant / Risk PM

**Zone**: Sections 4 (features), 8 (strategies), 9 (risk), fear buckets
**Perspective**: What creates statistical edge. What's risk theatre vs real protection.

#### What I See In The Code

Risk engine is surprisingly mature for a 4-day-old project:

- **RiskManager** (`src/risk/manager.ts`): Validates every entry. Confidence gate (55), leverage bounds, size bounds, SL mandatory, session loss scaling (5%/10% tiers), beta-adjusted exposure, 4h trend confirmation, F&G leverage cap, duplicate rejection. SL tightening with ATR-based tiers.
- **Regime classifier** (`src/market/regime-classifier.ts`): 6 regimes, priority-ordered, deterministic. Capitulation requires volume proof (not just F&G). Hysteresis prevents flapping.
- **Filter profiles** (`src/market/filter-profiles.ts`): Per-regime RSI/volume/confluence/leverage/SL-TP style.
- **Fear policy**: Hardcoded in prompt — aggressive SHORT bias in extreme fear. F&G < 25 or > 85 = leverage cap.

#### HIGH VALUE Items From Checklist

**1. Hard daily loss limit (separate from session)**
Session loss = since bot restart. If you restart mid-day after -4%, the counter resets. Need a DB-backed daily P&L tracker that persists across restarts. This is a real gap.

**2. No-trade on abnormal spread**
Not implemented. If bid-ask spread > 2x normal, entry slippage kills the trade. Simple check: compare current spread to 20-period average. If > 2x, reject.

**3. No-trade on stale data**
If market snapshot is >5 minutes old (API timeout, Binance degradation), the bot trades on stale state. Need a freshness timestamp check.

**4. Taker buy/sell volume from Binance**
Binance has `/futures/data/takerlongshortRatio` endpoint. Currently not fetched. This is the single most valuable missing feature — it directly measures aggression. OI + funding + taker = the positioning trinity.

**5. Funding z-score (derived)**
Currently show raw funding rate. A z-score vs 30-day history would tell "is this funding extreme for THIS pair" rather than absolute thresholds. Different pairs have different funding normals.

**6. Fear bucket policy (from checklist)**
The checklist's fear bucket system (8-20, 20-30, 30-40, etc.) with directional bias + leverage multipliers is actually well-designed. Current implementation is binary (F&G < 25 = cap leverage). Graduated buckets would be more nuanced.

#### SLOP / THEATRE Items

**1. "Max correlated exposure" (beyond beta)**
Current beta-adjusted exposure model (`BETA_TO_BTC` hardcoded) is crude but functional. Building a proper correlation matrix requires 30+ days of return data, rolling windows, and eigenvalue decomposition. For 3-4 pairs, hardcoded betas are good enough. The checklist's suggestion to build full correlation is overkill.

> **ATTACK**: You don't need portfolio theory for a 4-pair crypto futures book. BTC goes down, everything goes down. Beta approximation captures 90% of the risk.

**2. "Confidence calibration curve"**
Sounds rigorous. In practice: you need 200+ trades with confidence scores to build a calibration curve. The bot has done maybe 30 trades. This is a P1 item that requires months of data collection first.

**3. "Volatility-adjusted sizing"**
ATR-based sizing sounds smart, but introduces another degree of freedom for the LLM to game. Current fixed size_pct with risk manager bounds is simpler and harder to break. Only valuable after confidence calibration exists.

**4. "Cross-exchange premium detector"**
Requires real-time data from 2+ exchanges. Adds API keys, rate limits, normalization. Edge exists but is arbed away in seconds by professionals. Not accessible to a 10-minute cycle bot.

**5. "Strategy templates" (Section 8)**
"Narrative breakout", "Funding squeeze fade", "OI divergence" — these are backtesting ideas, not production features. Without a replay engine to validate them, coding strategy templates is guessing dressed as engineering.

> **ATTACK**: Every item in Section 8 (strategies) is R&D-only. The checklist puts them as R&D but then suggests modules and DB tables for them. That's scope creep through the back door.

**6. "Per-strategy attribution" with strategy_id, playbook_id**
The bot doesn't have named strategies yet. You can't attribute what doesn't exist. Build replay first, discover what works, then name it.

#### Fear Bucket Analysis

The checklist's fear bucket policy is the ONE strategy item worth implementing now. Here's why:

Current state: binary F&G check (< 25 or > 85 = leverage cap). No directional bias from F&G.

Proposed (from checklist, simplified):
```
F&G 8-20:  SHORT bias, leverage 0.8x long / 1.2x short
F&G 20-30: SHORT bias mild, 0.9x / 1.1x
F&G 30-50: Neutral, 1.0x
F&G 50-75: LONG bias, 1.05-1.1x long
F&G 75-90: Reduce aggression, 0.9x long
```

This is deterministic, fits into `filter-profiles.ts`, and aligns with the "fear = fuel" philosophy already in the prompt.

> **DEFEND**: Fear buckets are NOT strategy templates. They're regime filter parameters. They belong in the risk engine, not in R&D.

#### My TOP-3

1. DB-backed daily loss limit that survives restart — **real safety gap**
2. Taker buy/sell volume fetch from Binance + inject into prompt — **best missing feature**
3. Fear bucket graduated policy in `filter-profiles.ts` — **replaces binary F&G check**

---

### Expert 3: ML/LLM Architect

**Zone**: Sections 1 (LLM role), 2 (LLM contract), 7 (memory/RAG), 13 (anti-patterns)
**Perspective**: Where LLM adds real value vs where it's a liability. Schema, evals, prompt engineering.

#### What I See In The Code

The intelligence layer is ambitious but has one critical vulnerability:

- **LLM Client** (`src/llm/client.ts`): Codex API via SSE streaming. Free-form JSON output. Parse strategy: targeted regex → greedy fallback → retry with "respond ONLY with JSON". Parse errors logged to `parse-errors.jsonl`.
- **Swarm** (`src/llm/swarm-agent.ts`): 6-persona Blackboard debate. Reactive DA with Grok search. Judge synthesis. Fingerprint caching. This is sophisticated.
- **Layer 2/3 fallback**: `gpt-4o-mini` minimal prompt → rule-based emergency close. Three layers of resilience.
- **Prompts** (`src/llm/prompts.ts`): Massive system prompt with trading rules, entry criteria, fear policy. `buildUserPrompt()` assembles all data.
- **News analyst** (`src/news/news-analyst.ts`): LLM classifies headlines into structured signals with importance, expires_hours, needs_grounding.

The vulnerability: **everything depends on JSON parsing a free-text LLM response**. One model update, one prompt drift, and the bot either HOLDs forever or parses garbage.

#### HIGH VALUE Items From Checklist

**1. Strict structured outputs / json_schema**
This is the single highest-impact change in the entire checklist. Current state: free-form JSON + regex + retry. The Codex API supports `response_format: { type: "json_schema", json_schema: {...} }`. One schema definition, zero parse failures, zero retries, zero regex.

Cost: ~2 hours to define schema + wire response_format.
Benefit: eliminates an entire failure class. Parse errors become impossible.

> **ATTACK on checklist**: The checklist suggests "function tools instead of all-in-prompt". This is wrong for this architecture. The bot doesn't need tool calling — it needs a single structured output per cycle. Function calling adds roundtrips and complexity. Structured outputs are the right answer.

**2. Schema versioning**
When you change the decision schema (add `fear_bucket`, add `risk_flags`), old prompts break. A `schema_version` field lets you migrate gradually. Cheap insurance.

**3. `abstain_reason` field**
Currently HOLD has 1-word reasoning. If the LLM could say WHY it's holding (stale_news, no_setup, conflicting_signals, waiting_for_level), the bot could make smarter scheduling decisions. `next_check_minutes` already exists but is disconnected from reasoning.

**4. `data_gaps[]` field**
If the LLM knows news is stale or macro is missing, it should declare it. Currently gaps are invisible — the LLM just produces lower confidence without explaining why.

**5. Memory decay**
Episodic store has 500-episode FIFO but no quality weighting. A 3-month-old episode about a different regime shouldn't have the same retrieval weight as yesterday's similar setup. Simple: multiply cosine similarity by `exp(-age_days / 30)`.

#### SLOP / THEATRE Items

**1. "Prompt hash / response hash"**
The checklist suggests hashing every prompt and response for reproducibility. In practice: LLM outputs are non-deterministic. Hashing them proves nothing. You already log full prompts and responses in `llm_conversations` table. Hash adds zero information.

> **ATTACK**: Prompt hashing is a compliance theatre item from enterprise AI playbooks. In a solo trading bot, it's logging what you already log but with extra steps.

**2. "Function tools instead of all-in-prompt"**
Function calling means: LLM decides to call `get_order_book()`, waits for result, calls `get_news()`, waits, then decides. This adds 3-5 roundtrips per cycle. Current approach: assemble all data into one prompt, get one response. This is faster, cheaper, and more predictable.

Function calling is valuable when the LLM needs to explore. This bot knows exactly what data it needs every cycle.

**3. "Separate LLM agent for open positions" (position manager)**
The checklist suggests a dedicated position management agent. Current reality: the main prompt already sees open positions with entry price, SL/TP, P&L, held hours, entry thesis. ADJUST action exists. A separate agent doubles LLM cost with marginal benefit.

> **DEFEND from Quant**: "But the entry prompt and position prompt need different instructions!" — True in theory, but the current prompt handles both via conditional sections. Split when you have evidence of confusion, not preemptively.

**4. "Counterfactual analysis in memory"**
"What if HOLD?", "What if smaller size?", "What if exit earlier?" — You can't compute counterfactuals without a replay engine. And without statistical significance (200+ trades), counterfactuals are noise that the LLM will overfit to.

**5. "Playbook memory" (breakout continuation, sweep reclaim, etc.)**
Named playbooks require named strategies. The bot doesn't have strategies — it has a general-purpose prompt. Playbook memory is premature until you know which patterns actually work.

**6. "News clustering"**
LLM already deduplicates by importance + source_count + conflicting flag. Proper clustering (TF-IDF, entity resolution, temporal grouping) is an NLP research project. The current approach of "rank by importance, show top 5" is 80/20.

**6. Decision decomposition (added in review)**
The current schema collapses market interpretation, trade intent, risk proposal, and execution instruction into a single flat object. This makes it impossible to tell WHERE a bad decision went wrong: was the thesis correct but sizing wrong? Was the setup valid but timing off?

Proposed: add `setup_detected`, `setup_type`, `directional_bias`, `entry_valid_now`, `invalidators[]`, `evidence_strength` to the schema. Not separate agents — separate sections in one response. Cost at execution: zero. Value at replay: enormous.

> **DEFEND**: This is not "more fields for the sake of it". This is the difference between a decision log and a decision audit trail. Without decomposition, replay shows WHAT happened. With it, replay shows WHY.

#### Anti-Pattern Diagnosis (Section 13)

Checking against current code:

| Anti-pattern | Present? | Severity |
|---|---|---|
| Free-form JSON parsing | **YES** | CRITICAL — fix with structured outputs |
| LLM determines leverage | Partially — LLM suggests, risk engine clamps | LOW |
| LLM determines raw quantity | No — code computes from size_pct | OK |
| LLM overrides regime | No — removed in recent commit | OK |
| One prompt for flat + position state | **YES** — same prompt, conditional sections | LOW (working fine) |
| Main prompt reads raw news | No — NewsAnalyst pre-processes | OK |
| News without half-life | No — `expires_hours` exists | OK |
| Memory without outcome labels | Partially — `resultPnl` but no quality score | MEDIUM |
| Risk trusts confidence without calibration | **YES** — confidence directly gates entry | MEDIUM |
| No replay engine | **YES** | HIGH |
| No rules-only baseline | **YES** | HIGH |

#### My TOP-3

1. Strict structured outputs with `json_schema` response format — **eliminates parse failures entirely**
2. Decision decomposition: `setup_detected`, `directional_bias`, `invalidators[]`, `evidence_strength` — **enables replay attribution**
3. Add `abstain_reason` + `data_gaps[]` + `risk_flags[]` to decision schema — **makes HOLD decisions actionable**

---

### Expert 4: Production SRE

**Zone**: Sections 10 (replay/evals), 11 (observability), 12 (security), 14-15 (priorities)
**Perspective**: What keeps the bot alive at 3 AM. What's overkill for a solo-dev operation.

#### What I See In The Code

Observability is the strongest layer in the project:

- **20 DB tables** with `cycle_id` spine. Full decision lifecycle: `prompt -> decision -> risk_check -> execution -> close`.
- **Dual-write**: JSONL files + Supabase. Bot runs without DB (graceful fallback).
- **Fire-and-forget DB writes**: `.catch(() => {})` — never crashes on DB failure.
- **Token logging**: every LLM call tracked (tokens_in/out, model, cost).
- **2-day retention** on snapshots via pg_cron. Prevents table bloat.
- **63 test files** covering risk manager, regime classifier, swarm, news analyst, indicators, orders.
- **Circuit breaker**: 3 consecutive all-fail cycles = skip.
- **User stream**: auto-reconnect with backoff.
- **Emergency alert**: macOS audio on auth/rate-limit failures.

This is solid ops for a solo project.

#### HIGH VALUE Items From Checklist

**1. Replay engine from cycle_id**
This is the single most valuable missing capability in the entire project. Every cycle already saves: market snapshot, indicators, news, portfolio state, LLM conversation, decision, risk check, execution. You have ALL the data to replay any historical cycle.

What's missing: a script that takes a `cycle_id`, reconstructs the input state, re-runs the LLM (or a rules-only engine), and compares the outcome.

This enables EVERYTHING: A/B tests, regression detection, baseline comparison, confidence calibration.

> **CONSENSUS**: All 4 experts agree this is the highest-leverage missing piece.

**2. Rules-only baseline**
Without a "dumb" baseline, you can't know if the LLM adds value. Build a deterministic strategy: regime + filter profiles + simple rules (trend-follow in BullTrend, mean-revert in Range, SHORT in Capitulation). Run it on historical cycles. Compare P&L.

If rules-only beats LLM: the LLM is destroying value.
If LLM beats rules-only: you know how much alpha the LLM adds.

**3. Paper trading mode**
A `--paper` flag that runs the full pipeline but uses simulated fills (last price) instead of Binance API. This lets you test prompt changes, schema changes, and new features without risking capital.

Currently: changes go directly to live trading after `npm run deploy`. There's no staging environment.

#### SLOP / THEATRE Items

**1. "Chaos tests" (WS disconnect, malformed JSON, stale-news)**
Chaos engineering is for teams with on-call rotations and 99.9% SLA. You're a solo dev. The bot already handles failures gracefully (fire-and-forget DB, 3-layer LLM fallback, circuit breaker). Writing chaos tests for an e2-small VM is resume-driven engineering.

> **ATTACK**: The checklist's Section 12 P1 (chaos tests, ADL/liquidation path tests, partial fill tests, out-of-order event tests) is an entire QA team's roadmap. For a bot that trades 2-5 times/day, this is 40+ hours of test writing for scenarios that may never occur.

**2. "Config checksum"**
Verifying config.yaml hasn't been tampered with. By whom? You're the only one with SSH access. The VM has no web-facing services except the webhook. This is enterprise paranoia.

**3. "Feature flags"**
Feature flags are for teams deploying to thousands of users. You deploy with `npm run deploy` and watch pm2 logs. A git branch IS your feature flag.

**4. "Out-of-band emergency kill switch"**
The checklist suggests a separate kill-switch mechanism. Current kill-switches: `pm2 stop indic-bot` (SSH), session loss shutdown (automatic), Layer 3 emergency close (automatic). Three kill paths is enough.

**5. "One-click replay from a cycle" dashboard**
Cool feature, but building a replay UI before building the replay engine is premature. CLI replay first. Dashboard later (maybe never).

**6. "Alerting on abnormal HOLD streak"**
The bot already has `next_check_minutes` scheduling and emergency alerts on failures. A HOLD streak means the market is quiet — that's correct behavior, not an alert condition.

**7. 24 DB tables from checklist**
The checklist suggests: cycles, market_snapshots, feature_snapshots, fear_snapshots, news_items, news_clusters, macro_snapshots, llm_calls, agent_votes, agent_conflicts, decisions, risk_checks, orders, fills, positions, position_events, trade_closures, replays, episodes, episode_embeddings, source_health, cost_tracking, eval_runs, eval_failures.

Current bot has 20+ tables that cover all of this except: `fear_snapshots` (in market_snapshots), `news_clusters` (not needed), `agent_conflicts` (in swarm_personas), `replays`, `eval_runs`, `eval_failures` (need replay engine first).

> **DEFEND**: The replay/eval tables ARE needed — but only after the replay engine exists. Don't create empty tables "for the future".

#### Eval Coverage Analysis

Current tests (63 files) cover:
- Risk manager validation: ✅ comprehensive
- Regime classifier: ✅ all 6 regimes
- Swarm blackboard: ✅ state merging, votes
- Technical indicators: ✅ RSI, EMA, ATR, MACD, BB, ADX
- News analyst: ✅ parsing, importance scoring
- Orders: ✅ precision, SL failure handling

Missing:
- **LLM output schema stability** — no test that sends a real prompt and validates the response parses correctly
- **Layer 2/3 fallback** — no integration test for cascade
- **End-to-end cycle** — no test that simulates a full `runOnce()` with mocked Binance

The checklist suggests "eval on every regression fix". This is good practice but currently there's no eval framework — just unit tests. The gap is a lightweight eval harness, not a full eval platform.

#### My TOP-3

1. Replay engine: script that takes `cycle_id`, reconstructs state, re-runs decision — **unlocks all evaluation**
2. Paper trading mode (`--paper` flag) — **safe staging for changes**
3. Rules-only baseline comparison — **proves or disproves LLM value**

---

## Part 3: Judge Synthesis

### Consensus: Where All 4 Experts Agree

These items appeared in multiple experts' TOP-3 lists:

| Item | Expert Support | Effort | Impact |
|---|---|---|---|
| **Strict structured outputs** | ML Architect (PRIMARY), Exchange Eng (supports) | 2-3h | Eliminates parse failure class |
| **Replay engine from cycle_id** | SRE (PRIMARY), Quant (supports), ML Arch (supports) | 8-12h | Unlocks eval, baselines, A/B |
| **Daily loss limit (DB-backed)** | Quant (PRIMARY), SRE (supports) | 2h | Real safety gap |
| **Taker buy/sell volume** | Quant (PRIMARY), Exchange Eng (supports) | 2h | Best missing market feature |
| **Paper trading mode** | SRE (PRIMARY), Quant (supports) | 4-6h | Safe staging |

### Conflicts: Where Experts Disagree

**Conflict 1: WS as source of truth vs REST-primary**

- Exchange Eng: "REST is fine for 2-5 trades/day. WS is supplementary."
- Checklist: "Private WS must be source of truth."
- **Resolution**: Exchange Eng wins. The bot's trade frequency doesn't justify WS-primary architecture. Current hybrid (REST orders + WS fill detection) is correct.

**Conflict 2: Position manager agent vs single prompt**

- ML Architect: "Current prompt handles both entry and position management. Split when there's evidence of confusion."
- Quant: "Entry and management have different objectives. Separate agents prevent cross-contamination."
- **Resolution**: Defer. Monitor parse-errors.jsonl for ADJUST failures. If >10% ADJUST decisions are rejected or malformed, split the prompt.

**Conflict 3: Fear bucket policy location**

- Quant: "Fear buckets are regime filter parameters, belong in risk engine / filter-profiles."
- ML Architect: "Fear context should be in the prompt, LLM should understand the bias."
- **Resolution**: Both. Deterministic fear buckets in `filter-profiles.ts` (leverage multipliers, direction bias). Fear context narrative in prompt (so LLM understands WHY the bias exists).

**Conflict 4: Confidence calibration**

- Quant: "PREMATURE — need 200+ trades for statistical significance."
- ML Architect: "Risk trusts confidence without calibration is a real anti-pattern."
- **Resolution**: Quant wins on timing. Log confidence + outcome now. Build calibration curve after 200 trades. Don't trust confidence for sizing until then.

**Conflict 5: News clustering**

- Checklist: "Event clustering, entity linker, cross-source confirmation."
- ML Architect: "Current importance + source_count is 80/20."
- SRE: "Don't build NLP infrastructure for 20 headlines per cycle."
- **Resolution**: Skip clustering. Current approach works. Revisit only if grounding failures (Grok fact-checks) become frequent.

### The Graveyard: Conscious NOT-DO List

These items from the checklist should be explicitly parked:

1. **Local order book via depth stream** — overkill for 10-min cycles
2. **Cross-exchange premium detector** — arbed away by HFTs before our cycle runs
3. **On-chain whale watchers** — zero proven edge for futures, high complexity
4. **Stablecoin mint/burn watchers** — leading indicator on 24h+ horizon, not actionable for intraday
5. **Token unlock / vesting calendar** — relevant for spot, not leveraged futures
6. **Chaos tests** — enterprise QA for a solo dev project
7. **Config checksum** — security theatre
8. **Feature flags** — git branches are feature flags
9. **Playbook memory** — requires strategies that don't exist yet
10. **Counterfactual analysis** — requires replay engine that doesn't exist yet
11. **News clustering** — importance + source_count is enough
12. **Queue position estimate for passive logic** — HFT feature, irrelevant here
13. **Spoofing heuristics** — detecting spoofing on 500-level snapshot is unreliable
14. **Per-agent attribution** — need more agents first
15. **Capital ramp automation** — manual is correct at current scale

### Owner Review Corrections

After external review, the following corrections were applied to the original expert verdicts:

**1. Paper trading mode demoted from Tier 1 to Phase 3**
Reasoning: paper mode without a baseline creates an illusion of verification but no comparative signal. Replay answers "was this historically better?" — paper mode only answers "does it run end-to-end?" Replay first.

**2. Fear buckets demoted from Tier 2 to Phase 3**
Reasoning: fear buckets are policy tuning. Without replay, you can't prove they help — risk of cementing narrative bias. Control plane before alpha tuning.

**3. Memory decay demoted from Tier 1 to Phase 3**
Reasoning: without replay, you don't know if memory adds value at all. Fixing retrieval quality is pointless if the feature itself is unproven.

**4. Spread guard spec tightened**
Original: "spread > 2x avg = reject". Problem: kills breakout entries where wide spread is normal. Fix: rolling median spread per symbol per regime, minimum sample size, rejected trades logged.

**5. Decision decomposition added to schema**
Missing from original audit. A flat `action + confidence + reasoning` collapses 4 distinct concerns:
- Market interpretation (what's happening)
- Trade intent (what I want to do)
- Risk-adjusted proposal (how to do it safely)
- Execution instruction (the final order)

Separating these in the schema enables better debugging, replay comparison, and error attribution. Not separate agents — separate schema sections.

Proposed schema additions:
```
setup_detected: boolean
setup_type: string            // "trend_continuation" | "breakout" | "mean_reversion" | "none"
directional_bias: string      // "long" | "short" | "neutral"
entry_valid_now: boolean
invalidators: string[]        // what would kill the thesis
evidence_strength: number     // 1-10, for future eval (not for execution)
```

This costs nothing at execution time but gives the replay engine something to decompose.

### Final Prioritized Backlog: HIGH VALUE Only

> **Core thesis**: you don't need a smarter bot — you need a bot that's impossible to silently break and honest to verify.

#### Phase 1: Remove Fragility (~12h)

Goal: make the bot structurally sound. No new features, only hardening.

| # | Item | Owner | Hours | Why |
|---|---|---|---|---|
| 1 | Strict structured outputs (`json_schema`) | ML Arch | 3 | Eliminates parse failure class entirely |
| 2 | Decision decomposition in schema (`setup_detected`, `directional_bias`, `invalidators[]`, `evidence_strength`) | ML Arch | 2 | Enables future replay decomposition |
| 3 | `abstain_reason` + `data_gaps[]` + `risk_flags[]` in schema | ML Arch | 1 | Makes HOLD actionable, declares blind spots |
| 4 | `workingType=MARK_PRICE` + `priceProtect=true` on SL/TP | Exchange | 0.5 | Prevents false SL triggers during wicks |
| 5 | DB-backed daily loss limit (survives restart) | Quant | 2 | Real safety gap — session counter resets |
| 6 | No-trade on stale data (snapshot age > 5min) | Quant | 1 | Prevents decisions on stale market state |
| 7 | No-trade on abnormal spread | Quant | 1.5 | Rolling median per symbol per regime, min sample size, log rejections |
| 8 | Keepalive supervisor hardening (30min ping + stale detection) | Exchange | 1 | Prevents silent WS death |
| 9 | NTP clock check + `recvWindow=5000` | Exchange | 0.5 | Prevents `-1021 INVALID_TIMESTAMP` rejections |

**Spread guard spec (item 7)**:
- Compute rolling median spread over last 50 snapshots per symbol
- Separate medians per regime (Breakout naturally has wider spread)
- Reject if current spread > 2.5x regime-adjusted median AND sample size >= 20
- Log all rejections to `risk_validations` table with `reason: 'abnormal_spread'`
- Do NOT reject if regime = Breakout and spread < 3.5x median (allow wider spreads in breakouts)

#### Phase 2: Make The System Measurable (~25h)

Goal: build the evaluation infrastructure. After this phase, every future change can be measured.

| # | Item | Owner | Hours | Why |
|---|---|---|---|---|
| 10 | Replay engine from cycle_id | SRE | 10 | Reconstructs historical state, re-runs decision, compares outcome |
| 11 | Rules-only baseline | Quant + SRE | 6 | Deterministic strategy on same data — proves/disproves LLM value |
| 12 | LLM output eval harness | ML Arch + SRE | 5 | Schema stability, HOLD reasoning quality, parse regression detection |
| 13 | Schema versioning | ML Arch | 2 | Safe schema evolution for future changes |
| 14 | Confidence + outcome logging for calibration | Quant | 2 | Collect data now, build calibration curve after 200 trades |

#### Phase 3: Add Edge Features (~20h)

Goal: only AFTER control plane and eval infrastructure exist. Every item here should be validated via replay.

| # | Item | Owner | Hours | Prerequisite |
|---|---|---|---|---|
| 15 | Taker buy/sell volume from Binance | Quant | 2 | Can validate impact via replay |
| 16 | Funding z-score (vs 30-day pair history) | Quant | 3 | Can validate impact via replay |
| 17 | Fear bucket graduated policy | Quant | 4 | Can validate vs binary F&G via replay |
| 18 | Memory decay: `similarity * exp(-age/30)` | ML Arch | 0.5 | Can validate memory utility via no-memory baseline |
| 19 | Paper trading mode (`--paper` flag) | SRE | 5 | Replay exists, now add forward-testing |
| 20 | No-news / no-memory baselines | SRE | 4 | Replay engine + baselines infrastructure |

#### Phase 4: After 200+ Trades (R&D)

| # | Item | Owner | Prerequisite |
|---|---|---|---|
| 21 | Confidence calibration curve | Quant | 200+ trades with confidence logged |
| 22 | Strategy naming + attribution | Quant | Replay data showing repeating patterns |
| 23 | Position manager agent (split) | ML Arch | Evidence of >10% ADJUST failures |
| 24 | Volatility-adjusted sizing | Quant | Confidence calibration complete |

---

## Appendix: Checklist Items Mapped to Verdicts

For reference, mapping the original 15 sections to final verdicts:

**Section 1 (LLM Role)**: ALREADY CORRECT — LLM gives thesis, risk engine permits, execution engine places orders.

**Section 2 (LLM Contract)**: HIGH VALUE — structured outputs + enriched schema fields. Skip function calling.

**Section 3 (Exchange)**: 3 quick wins (MARK_PRICE, priceProtect, clock sync). Rest is PREMATURE.

**Section 4 (Features)**: Taker volume = HIGH VALUE. Basis, ratios = NICE-TO-HAVE. Cross-exchange = PREMATURE.

**Section 5 (News)**: MOSTLY DONE. Trust/novelty/half-life exist. Clustering = SKIP.

**Section 6 (On-chain)**: ENTIRE SECTION IS PREMATURE for current scale.

**Section 7 (Memory)**: Memory decay = VALUE. Counterfactuals = PREMATURE (needs replay). Playbooks = PREMATURE (needs strategies).

**Section 8 (Strategies)**: ENTIRE SECTION IS R&D-ONLY. Do not code strategies without replay validation.

**Section 9 (Risk)**: Daily limit + spread guard + stale check = HIGH VALUE. Correlation matrix = OVERKILL.

**Section 10 (Replay/Eval)**: HIGHEST PRIORITY MISSING CAPABILITY. Replay engine + baselines before anything else.

**Section 11 (Observability)**: ALREADY DONE. 20 tables, cycle_id spine. Minor additions only.

**Section 12 (Security)**: ALREADY DONE. IP whitelist, no withdrawal, testnet. Chaos tests = SKIP.

**Section 13 (Anti-patterns)**: DIAGNOSTIC VALUE — free-form JSON and no replay are real problems. Fix them.

**Section 14 (Priorities)**: 60% agree, 40% premature for current scale.

**Section 15 (Architecture)**: ALREADY MATCHES current design.

---

## Appendix B: Core Thesis (one sentence)

> You don't need a smarter bot — you need a bot that's impossible to silently break and honest to verify.

**Implementation order reflects this**:
1. Phase 1 removes fragility (structured outputs, execution hardening, risk guards)
2. Phase 2 makes the system measurable (replay, baselines, evals)
3. Phase 3 adds edge features (taker volume, fear buckets, funding z-score)
4. Phase 4 requires data accumulation (confidence calibration, strategy attribution)

Every Phase 3 item should be validated via Phase 2 infrastructure before going live. Any "improvement" without replay evidence is narrative, not alpha.
