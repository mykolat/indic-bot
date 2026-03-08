# FUTURE: Swarm Replay & TDD Tuning Framework

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TDD framework that replays historical market moments through the full trading pipeline (regime classifier -> swarm debate -> risk manager) to diagnose and tune decisions against known outcomes.

**Architecture:** Fixtures are snapshots of real DB state at interesting moments (market data, indicators, news, macro, fear&greed). A replay harness reconstructs `EnrichedPromptData` from a fixture, runs it through configurable pipeline (any LLM model, any prompt version, any risk config), and compares output to expected decisions. Vitest assertions validate correctness. A scanner script auto-discovers "missed trades" from DB.

**Tech Stack:** Vitest, Supabase (read-only queries), existing `SwarmAgent` / `RiskManager` / `classifyRegime`, Gemini API as alternative model

---

## Data Availability (as of 2026-03-08)

| Source | Records | Retention | Notes |
|--------|---------|-----------|-------|
| `market_snapshots` | 25,705 | 90 days (just changed) | price, OI, funding, L/S, orderbook per pair |
| `indicator_snapshots` | 9,155 | 90 days | RSI, EMA, MACD, ADX, ATR, VWAP, BB, volume_ratio, trend (1h+4h) |
| `cycles` | 532 | permanent | fear_greed, regime, volume_ratio, confluence, balance |
| `trade_decisions` | 60 | permanent | 22 SHORT, 1 LONG, 35 ADJUST, 2 CLOSE. **HOLD not saved** |
| `llm_conversations` | ~200+ | permanent | swarm: 50 with `blackboard_state` JSON |
| `swarm_personas` | 243 | permanent | vote, confidence, reasoning, signals, conflicts |
| `trade_executions` | 10 | permanent | entry price, thesis, regime, was_swarm |
| `trade_closes` | 8 | permanent | P&L, exit reason, held hours |
| `news_analyses` | 104 | permanent | sentiment, signals, risk events |
| `macro_snapshots` | 9 | permanent | WTI, DXY, VIX, S&P500, gold, BTC dom |

**Key gap:** HOLD decisions are NOT saved to `trade_decisions`. ~90% of cycles result in HOLD but we have no record. This is the biggest blind spot for "missed trade" detection.

---

## Architecture Overview

```
tests/replay/
  fixtures/                    # JSON snapshots of market moments
    2026-03-06-ada-short-18pct.json   # manually curated "golden" events
    2026-03-07-btc-dump-hold.json     # missed opportunity
    ...
  replay-harness.ts            # builds EnrichedPromptData from fixture, runs pipeline
  replay.test.ts               # vitest test cases with assertions
  types.ts                     # ReplayFixture interface

scripts/
  export-fixture.ts            # export a cycle's full context from DB to fixture JSON
  find-missed-trades.ts        # scan DB for HOLD cycles where price moved >X%
  score-replay.ts              # batch-run all fixtures, produce comparison report
```

### Fixture Schema

```typescript
interface ReplayFixture {
  // Metadata
  id: string;                          // e.g. "2026-03-06-ada-short-18pct"
  description: string;                 // human description of the event
  cycle_id: number;                    // original cycle for traceability
  timestamp: string;                   // ISO datetime of the moment

  // Market state (from market_snapshots at this moment)
  market_snapshots: DbMarketSnapshot[];

  // Technical indicators (from indicator_snapshots linked to cycle)
  indicators_1h: Record<string, DbIndicatorSnapshot>;
  indicators_4h: Record<string, DbIndicatorSnapshot>;

  // Context
  fear_greed: { value: number; label: string };
  regime: string;
  volume_ratio: number;
  confluence: { score: number; factors: string[] };

  // Portfolio state at the moment
  portfolio: {
    balanceUsd: number;
    positions: Array<{
      pair: string; side: string; sizeUsd: number;
      leverage: number; entryPrice: number; unrealizedPnlPct: number;
    }>;
    sessionPnl: number;
  };

  // Intelligence
  news_analysis?: DbNewsAnalysis;
  macro_snapshot?: DbMacroSnapshot;
  position_contexts?: Array<{
    pair: string; sl_price: number; tp_price: number;
    entry_thesis: string; fill_price: number;
  }>;

  // What actually happened (swarm state if it ran)
  actual_decision: {
    action: string;
    pair: string;
    confidence?: number;
    reasoning?: string;
    was_swarm: boolean;
  };
  swarm_votes?: Array<{
    persona: string; vote: string; confidence: number; reasoning: string;
  }>;

  // Hindsight: what happened to price after this moment
  hindsight: {
    price_1h_pct: number;    // price change after 1 hour
    price_4h_pct: number;    // price change after 4 hours
    price_8h_pct: number;    // price change after 8 hours
    optimal_action: string;  // what SHOULD have been done (manual or auto)
    optimal_confidence: number;
    notes?: string;          // human notes on why
  };
}
```

### Replay Harness

```typescript
// tests/replay/replay-harness.ts

interface ReplayConfig {
  // Which model to use for swarm personas
  model: 'codex' | 'gemini-3-flash' | 'gemini-3.1-pro' | 'grok';
  // Override system prompt (null = use default)
  systemPromptOverride?: string;
  // Override risk config
  riskConfigOverride?: Partial<RiskManagerConfig>;
  // Run swarm or single LLM
  useSwarm: boolean;
  // Dry run (no actual LLM calls, use fixture's actual responses)
  dryRun: boolean;
}

interface ReplayResult {
  decisions: TradeDecision[];
  regime: RegimeResult;
  riskValidations: ValidationResult[];
  swarmState?: BlackboardState;
  diagnostics: {
    regime_correct: boolean;        // did classifier get it right?
    decision_matches_optimal: boolean;
    confidence_delta: number;       // actual - optimal
    risk_blocked: boolean;          // did risk manager reject?
    risk_reason?: string;
    data_gaps: string[];            // missing inputs (no news, no macro, etc.)
    pipeline_stage_that_failed: 'regime' | 'swarm' | 'risk' | 'none';
  };
}

async function replayFixture(
  fixture: ReplayFixture,
  config: ReplayConfig,
): Promise<ReplayResult>;
```

### Diagnostic Output

For each replay, the harness answers:
1. **Regime correct?** — `classifyRegime()` on fixture indicators vs actual regime
2. **Swarm voted correctly?** — compare swarm votes with `hindsight.optimal_action`
3. **Risk blocked good trade?** — did `RiskManager.validate()` reject what would have been profitable?
4. **Data gaps?** — was news/macro missing at this moment?
5. **Which pipeline stage failed?** — regime wrong? swarm wrong? risk too strict?

---

## Tasks

### Task 1: Save HOLD decisions to DB

Currently ~90% of cycles (HOLD) leave no trace in `trade_decisions`. Without this data, we can't find missed opportunities.

**Files:**
- Modify: `src/trading-loop.ts` (where HOLD decisions are skipped)
- Modify: `src/db/repository.ts` (if needed)
- Test: `tests/trading-loop.test.ts`

**Step 1: Find where HOLD decisions are filtered out**

In `trading-loop.ts`, locate the loop that processes LLM decisions. HOLD/FETCH_NEWS are skipped before `insertTradeDecision`. Add insert for HOLD with `confidence` and `reasoning`.

**Step 2: Write failing test**

```typescript
// tests/trading-loop.test.ts - add test
it('saves HOLD decisions to DB with reasoning', async () => {
  // Mock LLM to return HOLD with confidence 40
  // Assert insertTradeDecision called with action='HOLD'
});
```

**Step 3: Implement — insert HOLD decisions**

In the decision processing loop, before the `if (action === 'HOLD') continue` check, call:
```typescript
if (action === 'HOLD' && this.deps.db) {
  this.deps.db.insertTradeDecision({
    cycle_id: cycleId,
    conversation_id: conversationId,
    pair: d.pair,
    action: 'HOLD',
    confidence: d.confidence,
    reasoning: d.reasoning,
    regime: regime,
    volume_ratio: volumeRatio,
    confluence_score: confluence?.score,
    confluence_factors: confluence?.factors,
  }).catch(() => {});
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**
```bash
git commit -m "feat: save HOLD decisions to trade_decisions for replay analysis"
```

---

### Task 2: ReplayFixture type + export script

**Files:**
- Create: `tests/replay/types.ts`
- Create: `scripts/export-fixture.ts`

**Step 1: Create fixture type**

```typescript
// tests/replay/types.ts
export interface ReplayFixture {
  id: string;
  description: string;
  cycle_id: number;
  timestamp: string;
  market_snapshots: Array<{
    pair: string; mark_price: number; open_interest?: number;
    funding_rate?: number; long_short_ratio?: number;
    order_book_bid_pct?: number; order_book_ask_pct?: number;
    imbalance_pct?: number;
  }>;
  indicators_1h: Record<string, {
    rsi?: number; ema_short?: number; ema_long?: number;
    macd?: number; macd_signal?: number; macd_histogram?: number;
    adx?: number; atr?: number; atr_pct?: number;
    vwap?: number; vwap_diff_pct?: number;
    bb_upper?: number; bb_lower?: number; bb_width?: number;
    volume_ratio?: number; trend?: string;
  }>;
  indicators_4h: Record<string, {
    rsi?: number; ema_short?: number; ema_long?: number;
    macd?: number; macd_signal?: number; adx?: number;
    atr?: number; vwap?: number; vwap_diff_pct?: number;
    volume_ratio?: number; trend?: string;
  }>;
  fear_greed: { value: number; label: string };
  regime: string;
  volume_ratio: number;
  confluence: { score: number; factors: string[] };
  portfolio: {
    balanceUsd: number;
    positions: Array<{
      pair: string; side: string; sizeUsd: number;
      leverage: number; entryPrice: number; unrealizedPnlPct: number;
    }>;
    sessionPnl: number;
  };
  news_analysis?: {
    overall_sentiment?: string; signals?: unknown[];
    risk_events?: string[]; article_count?: number;
  };
  macro_snapshot?: {
    wti?: number; dxy?: number; sp500?: number;
    vix?: number; eurusd?: number; gold?: number;
    btc_dominance?: number;
  };
  actual_decision: {
    action: string; pair: string;
    confidence?: number; reasoning?: string;
    was_swarm: boolean;
  };
  swarm_votes?: Array<{
    persona: string; vote: string;
    confidence: number; reasoning: string;
  }>;
  hindsight: {
    price_1h_pct: number;
    price_4h_pct: number;
    price_8h_pct: number;
    optimal_action: string;
    optimal_confidence: number;
    notes?: string;
  };
}
```

**Step 2: Create export script**

```typescript
// scripts/export-fixture.ts
// Usage: npx tsx scripts/export-fixture.ts <cycle_id> [description]
//
// Queries DB for all context at that cycle, computes hindsight from
// subsequent market_snapshots, outputs JSON fixture to stdout.
//
// Key queries:
// 1. cycles WHERE id = cycle_id → regime, fear_greed, volume_ratio
// 2. market_snapshots closest to cycle.created_at (±2 min window)
// 3. indicator_snapshots WHERE cycle_id = cycle_id
// 4. news_analyses closest to cycle.created_at
// 5. macro_snapshots closest to cycle.created_at
// 6. trade_decisions WHERE cycle_id = cycle_id
// 7. swarm_personas via llm_conversations WHERE cycle_id = cycle_id
// 8. hindsight: market_snapshots at +1h, +4h, +8h for price delta
```

The script connects to DB via `DATABASE_URL`, runs queries, assembles `ReplayFixture`, and writes to `tests/replay/fixtures/<id>.json`.

**Step 3: Run export for known interesting cycle**

```bash
npx tsx scripts/export-fixture.ts 42 "ADA SHORT +18.5% — best trade"
```

**Step 4: Commit**
```bash
git commit -m "feat: add ReplayFixture type and DB export script"
```

---

### Task 3: Replay harness — regime + risk (no LLM)

The "dry run" mode: takes a fixture, runs `classifyRegime()` and `RiskManager.validate()` without LLM calls. Tests the algorithmic parts of the pipeline.

**Files:**
- Create: `tests/replay/replay-harness.ts`
- Create: `tests/replay/replay.test.ts`

**Step 1: Write failing test**

```typescript
// tests/replay/replay.test.ts
import { describe, it, expect } from 'vitest';
import { replayFixture } from './replay-harness.js';
import fixture from './fixtures/2026-03-06-ada-short-18pct.json';

describe('Replay: ADA SHORT +18.5%', () => {
  it('regime classifier detects correct regime', async () => {
    const result = await replayFixture(fixture, { dryRun: true, useSwarm: false });
    expect(result.regime.regime).toBe('Capitulation');
  });

  it('risk manager approves SHORT with correct leverage', async () => {
    const result = await replayFixture(fixture, { dryRun: true, useSwarm: false });
    const shortDecision = result.riskValidations.find(v => v.approved);
    expect(shortDecision).toBeDefined();
  });

  it('diagnoses pipeline stage correctly', async () => {
    const result = await replayFixture(fixture, { dryRun: true, useSwarm: false });
    expect(result.diagnostics.pipeline_stage_that_failed).toBe('none');
  });
});
```

**Step 2: Implement replay harness (dry run mode)**

```typescript
// tests/replay/replay-harness.ts
//
// replayFixture(fixture, config):
// 1. Convert fixture.indicators_1h → Map<string, Indicators>
// 2. Convert fixture.indicators_4h → Map<string, Indicators>
// 3. Run classifyRegime(indicators1h['BTCUSDT'], price, fearGreed)
// 4. Build mock TradeDecision from fixture.actual_decision (or hindsight.optimal)
// 5. Build mock PortfolioState from fixture.portfolio
// 6. Run RiskManager.validate(decision, portfolio, { indicators4h, fearGreed })
// 7. Compute diagnostics: regime_correct, risk_blocked, data_gaps, etc.
// 8. Return ReplayResult
```

**Step 3: Run tests**
```bash
npx vitest run tests/replay/replay.test.ts
```

**Step 4: Commit**
```bash
git commit -m "feat: replay harness with dry-run mode (regime + risk)"
```

---

### Task 4: Replay harness — live LLM mode (Gemini integration)

Add real LLM calls to the harness: send fixture data to Gemini/Codex and compare decisions.

**Files:**
- Create: `src/llm/gemini-client.ts`
- Modify: `tests/replay/replay-harness.ts`
- Test: `tests/replay/replay-gemini.test.ts`

**Step 1: Create GeminiClient**

```typescript
// src/llm/gemini-client.ts
// Minimal client matching the pattern of GrokClient:
// - constructor(apiKey: string)
// - call(systemPrompt, userPrompt, model?, options?): Promise<string>
// - Models: 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite-preview'
// - REST API: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}
// - Request: { contents: [{role:'user', parts:[{text}]}], systemInstruction: {parts:[{text}]}, generationConfig }
// - Response: data.candidates[0].content.parts[0].text
```

**Step 2: Write failing test**

```typescript
// tests/replay/replay-gemini.test.ts
describe('Replay with Gemini', () => {
  it('gemini-3-flash produces valid TradeDecision JSON', async () => {
    const result = await replayFixture(fixture, {
      model: 'gemini-3-flash',
      useSwarm: false,
      dryRun: false,
    });
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(['LONG','SHORT','HOLD','CLOSE']).toContain(result.decisions[0].action);
  });
});
```

**Step 3: Implement live mode in harness**

In `replayFixture`, when `dryRun: false`:
1. Build `EnrichedPromptData` from fixture
2. Call `buildSystemPrompt()` + `buildEnrichedPrompt()`
3. Send to selected model (GeminiClient / LLMClient / GrokClient)
4. Parse JSON response into `TradeDecision[]`
5. Run through `RiskManager.validate()`
6. Compare with `hindsight.optimal_action`

**Step 4: Run test (requires GEMINI_API_KEY)**
```bash
GEMINI_API_KEY=... npx vitest run tests/replay/replay-gemini.test.ts
```

**Step 5: Commit**
```bash
git commit -m "feat: GeminiClient + live LLM replay mode"
```

---

### Task 5: Fixture scanner — find missed trades

**Files:**
- Create: `scripts/find-missed-trades.ts`

**Step 1: Write the scanner**

```typescript
// scripts/find-missed-trades.ts
// Usage: npx tsx scripts/find-missed-trades.ts [--threshold 3] [--window 4h]
//
// Algorithm:
// 1. Query all cycles with their created_at + regime + fear_greed
// 2. For each cycle, get trade_decisions — if only HOLD/no action decisions:
// 3. Query market_snapshots for each pair at cycle time and at +1h, +4h, +8h
// 4. Compute max price move in window
// 5. If |move| > threshold% → flag as "missed trade"
// 6. Output: cycle_id, timestamp, pair, price_at, price_after, move%, regime, FG
//
// Also flags: trades that lost money where opposite direction would have profited
```

**Step 2: Run it**
```bash
npx tsx scripts/find-missed-trades.ts --threshold 3
```

**Step 3: For each interesting result, export fixture**
```bash
npx tsx scripts/export-fixture.ts <cycle_id> "description"
```

**Step 4: Commit**
```bash
git commit -m "feat: scanner to find missed trades from DB history"
```

---

### Task 6: Scoring & comparison report

**Files:**
- Create: `scripts/score-replay.ts`

**Step 1: Write batch scorer**

```typescript
// scripts/score-replay.ts
// Usage: npx tsx scripts/score-replay.ts [--model gemini-3-flash] [--dry-run]
//
// 1. Load all fixtures from tests/replay/fixtures/*.json
// 2. Run each through replayFixture with given config
// 3. Score each: correct_action (bool), confidence_delta, risk_blocked_wrongly
// 4. Aggregate: accuracy%, avg confidence delta, false rejections
// 5. Output markdown table:
//
// | Fixture | Optimal | Model Said | Correct? | Confidence | Risk | Stage Failed |
// |---------|---------|------------|----------|------------|------|-------------|
// | ada-18  | SHORT   | SHORT      | YES      | 75 vs 80   | OK   | none        |
// | btc-dump| SHORT   | HOLD       | NO       | 40 vs 70   | n/a  | swarm       |
//
// Compare multiple models side by side:
// npx tsx scripts/score-replay.ts --model codex --model gemini-3-flash --model gemini-3.1-pro
```

**Step 2: Commit**
```bash
git commit -m "feat: batch replay scorer with model comparison"
```

---

### Task 7: Swarm replay mode

**Files:**
- Modify: `tests/replay/replay-harness.ts`
- Test: `tests/replay/replay-swarm.test.ts`

**Step 1: Add swarm replay**

When `config.useSwarm: true`:
1. Build full `EnrichedPromptData` from fixture
2. Create `SwarmAgent` with selected model's client
3. Run `swarmAgent.getConsensus(data)`
4. Capture blackboard state + all persona votes
5. Compare judge decision with `hindsight.optimal_action`
6. Diagnostics: which persona(s) voted wrong? Did DA activate? Did judge override majority?

**Step 2: Write test**
```typescript
describe('Swarm Replay', () => {
  it('swarm with gemini-3.1-pro catches the SHORT on ADA dump', async () => {
    const result = await replayFixture(fixture, {
      model: 'gemini-3.1-pro',
      useSwarm: true,
      dryRun: false,
    });
    expect(result.decisions[0].action).toBe('SHORT');
    // Check which personas got it right
    const correctVotes = result.swarmState!.votes;
    console.log('Persona votes:', JSON.stringify(correctVotes, null, 2));
  });
});
```

**Step 3: Commit**
```bash
git commit -m "feat: swarm replay mode with persona diagnostics"
```

---

## Execution Order & Dependencies

```
Task 1 (save HOLDs)  ──→  Task 5 (find missed) ──→ Task 6 (scoring)
                                                        ↑
Task 2 (types+export) ──→ Task 3 (dry harness) ──→ Task 4 (live LLM) ──→ Task 7 (swarm)
```

Tasks 1 and 2 are independent and can run in parallel.
Tasks 3-7 are sequential.

## Future Extensions (not in this plan)

- Dashboard page showing replay results
- Auto-run replays in CI on prompt changes
- A/B test: run 2 prompt versions on same fixtures, compare
- "Replay tournament": multiple models compete on same fixtures
- Export fixtures from external data sources (not just our DB)
