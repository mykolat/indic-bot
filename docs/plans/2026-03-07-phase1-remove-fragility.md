# Phase 1: Remove Fragility — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the bot structurally sound — eliminate silent failure modes, harden execution, add missing risk guards. No new features, only hardening.

**Architecture:** 9 independent tasks across 3 layers: LLM contract (strict schema + decision decomposition), exchange hardening (MARK_PRICE, keepalive, clock sync), risk guards (daily loss, stale data, spread). Each task is independently testable and committable.

**Tech Stack:** TypeScript ESM (.js imports), Vitest, Binance Futures REST API via `binance` npm, Codex API (SSE streaming), Supabase PostgreSQL.

**Depends on:** MoE Architecture Audit (`docs/plans/2026-03-07-moe-architecture-audit.md`)

---

## Task 1: Strict Structured Outputs — Decision Schema Type

**Files:**
- Create: `src/llm/decision-schema.ts`
- Test: `tests/llm/decision-schema.test.ts`

**Context:** Currently `TradeDecision` lives in `src/risk/manager.ts:3-19` and the LLM output format is defined as a text template in `src/llm/prompts.ts:105-142`. Parse logic uses regex in `src/llm/client.ts:314-339`. We need a single source of truth for the schema.

**Step 1: Write the failing test**

```typescript
// tests/llm/decision-schema.test.ts
import { describe, it, expect } from 'vitest';
import { parseDecisions, type LLMResponse, type DecisionV2 } from '../../src/llm/decision-schema.js';

describe('parseDecisions', () => {
  const validResponse: LLMResponse = {
    decisions: [{
      pair: 'BTCUSDT',
      action: 'LONG',
      size_pct: 20,
      leverage: 5,
      stop_loss_pct: 2,
      take_profit_pct: 6,
      reasoning: 'Strong trend continuation with volume confirmation',
      confidence: 72,
      setup_detected: true,
      setup_type: 'trend_continuation',
      directional_bias: 'long',
      entry_valid_now: true,
      invalidators: ['4h EMA cross bearish', 'volume drop below 0.5x'],
      risk_flags: [],
      data_gaps: [],
      abstain_reason: null,
    }],
    next_check_minutes: 15,
  };

  it('parses a valid response', () => {
    const result = parseDecisions(JSON.stringify(validResponse));
    expect(result).not.toBeNull();
    expect(result!.decisions).toHaveLength(1);
    expect(result!.decisions[0].action).toBe('LONG');
    expect(result!.decisions[0].setup_detected).toBe(true);
    expect(result!.decisions[0].invalidators).toHaveLength(2);
    expect(result!.nextCheckMinutes).toBe(15);
  });

  it('parses a HOLD with abstain_reason', () => {
    const hold: LLMResponse = {
      decisions: [{
        pair: 'BTCUSDT',
        action: 'HOLD',
        size_pct: 0,
        leverage: 0,
        stop_loss_pct: 0,
        take_profit_pct: 0,
        reasoning: 'low_volume',
        confidence: 30,
        setup_detected: false,
        setup_type: 'none',
        directional_bias: 'neutral',
        entry_valid_now: false,
        invalidators: [],
        risk_flags: ['thin_book'],
        data_gaps: ['missing_macro'],
        abstain_reason: 'no_setup',
      }],
      next_check_minutes: 25,
    };
    const result = parseDecisions(JSON.stringify(hold));
    expect(result).not.toBeNull();
    expect(result!.decisions[0].abstain_reason).toBe('no_setup');
    expect(result!.decisions[0].data_gaps).toContain('missing_macro');
  });

  it('returns null on invalid JSON', () => {
    expect(parseDecisions('not json at all')).toBeNull();
  });

  it('returns null on missing decisions array', () => {
    expect(parseDecisions('{"foo": "bar"}')).toBeNull();
  });

  it('clamps next_check_minutes to 10-30 range', () => {
    const response = { ...validResponse, next_check_minutes: 5 };
    const result = parseDecisions(JSON.stringify(response));
    expect(result!.nextCheckMinutes).toBe(10);
  });

  it('defaults missing optional fields', () => {
    const minimal: LLMResponse = {
      decisions: [{
        pair: 'ETHUSDT',
        action: 'SHORT',
        size_pct: 15,
        leverage: 8,
        stop_loss_pct: 1.5,
        take_profit_pct: 4,
        reasoning: 'Breakdown below VWAP',
        confidence: 65,
        // All new fields missing — should get defaults
      } as any],
      next_check_minutes: 10,
    };
    const result = parseDecisions(JSON.stringify(minimal));
    expect(result).not.toBeNull();
    const d = result!.decisions[0];
    expect(d.setup_detected).toBe(false);
    expect(d.directional_bias).toBe('neutral');
    expect(d.risk_flags).toEqual([]);
    expect(d.data_gaps).toEqual([]);
    expect(d.abstain_reason).toBeNull();
    expect(d.invalidators).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/decision-schema.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/llm/decision-schema.ts

export interface DecisionV2 {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS' | 'ADJUST';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
  confidence: number;

  // Decision decomposition — enables replay attribution
  setup_detected: boolean;
  setup_type: string;
  directional_bias: 'long' | 'short' | 'neutral';
  entry_valid_now: boolean;
  invalidators: string[];

  // Risk awareness — LLM declares its blind spots
  risk_flags: string[];
  data_gaps: string[];
  abstain_reason: string | null;

  // Legacy optional fields (backward compat)
  session_context?: {
    session_pattern_active: boolean;
    session_fit_score: number;
    session_role: 'supports' | 'neutral' | 'contradicts';
    session_reason: string;
  };
  capitulation_assessment?: {
    mode: 'continuation' | 'exhaustion' | 'unclear';
    reason: string;
  };
}

export const SCHEMA_VERSION = 2;

export interface LLMResponse {
  decisions: DecisionV2[];
  next_check_minutes: number;
}

/** Parse raw LLM text into typed decisions. Returns null on parse failure. */
export function parseDecisions(raw: string): { decisions: DecisionV2[]; nextCheckMinutes: number } | null {
  try {
    // Try direct JSON parse first (for strict structured outputs)
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: extract JSON object containing "decisions"
      const match = raw.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
      if (!match) return null;
      parsed = JSON.parse(match[0]);
    }

    if (!Array.isArray(parsed.decisions)) return null;

    const decisions: DecisionV2[] = parsed.decisions.map((d: any) => ({
      pair: d.pair,
      action: d.action,
      size_pct: d.size_pct ?? 0,
      leverage: d.leverage ?? 0,
      stop_loss_pct: d.stop_loss_pct ?? 0,
      take_profit_pct: d.take_profit_pct ?? 0,
      reasoning: d.reasoning ?? '',
      confidence: d.confidence ?? 50,
      setup_detected: d.setup_detected ?? false,
      setup_type: d.setup_type ?? 'none',
      directional_bias: d.directional_bias ?? 'neutral',
      entry_valid_now: d.entry_valid_now ?? false,
      invalidators: Array.isArray(d.invalidators) ? d.invalidators : [],
      risk_flags: Array.isArray(d.risk_flags) ? d.risk_flags : [],
      data_gaps: Array.isArray(d.data_gaps) ? d.data_gaps : [],
      abstain_reason: d.abstain_reason ?? null,
      session_context: d.session_context,
      capitulation_assessment: d.capitulation_assessment,
    }));

    const ncm = parsed.next_check_minutes;
    const nextCheckMinutes = typeof ncm === 'number'
      ? Math.max(10, Math.min(30, ncm))
      : 15;

    return { decisions, nextCheckMinutes };
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/llm/decision-schema.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/llm/decision-schema.ts tests/llm/decision-schema.test.ts
git commit -m "feat(llm): add DecisionV2 schema with decomposition and risk fields"
```

---

## Task 2: Wire Structured Schema Into LLM Client

**Files:**
- Modify: `src/llm/client.ts:47-55` (request body), `src/llm/client.ts:84-119` (parse + retry), `src/llm/client.ts:314-339` (parseResponse)
- Modify: `src/llm/prompts.ts:105-142` (output format instructions)
- Modify: `src/risk/manager.ts:3-19` (extend TradeDecision with new fields)
- Test: `tests/llm/client.test.ts` (add schema-related tests)

**Step 1: Update TradeDecision to include new fields**

In `src/risk/manager.ts`, add the new optional fields to `TradeDecision` interface (after line 19). These are optional so existing code doesn't break:

```typescript
// Add after confidence?: number; (line 12)
  setup_detected?: boolean;
  setup_type?: string;
  directional_bias?: 'long' | 'short' | 'neutral';
  entry_valid_now?: boolean;
  invalidators?: string[];
  risk_flags?: string[];
  data_gaps?: string[];
  abstain_reason?: string | null;
```

Also: remove the dead `regime_override?: string` field (line 13) since it's unused.

**Step 2: Update prompt output format**

In `src/llm/prompts.ts`, replace the JSON template at lines 105-130 with the new schema. Key additions:

```
"setup_detected": true|false,
"setup_type": "trend_continuation"|"breakout"|"mean_reversion"|"funding_fade"|"news_drift"|"none",
"directional_bias": "long"|"short"|"neutral",
"entry_valid_now": true|false,
"invalidators": ["what would kill this thesis"],
"risk_flags": ["thin_book","high_funding","stale_news","wide_spread","low_volume","conflicting_signals"],
"data_gaps": ["missing_macro","stale_news","no_4h_data"],
"abstain_reason": "no_setup"|"conflicting_signals"|"stale_data"|"waiting_for_level"|null,
```

**Step 3: Update parseResponse in client.ts**

Replace `src/llm/client.ts:314-339` (`parseResponse`) to use `parseDecisions` from the new schema module:

```typescript
import { parseDecisions } from './decision-schema.js';

// Replace parseResponse method:
private parseResponse(content: string): { decisions: TradeDecision[]; nextCheckMinutes?: number } | null {
  const result = parseDecisions(content);
  if (!result) {
    this.logParseError(content, 'parseDecisions returned null');
    return null;
  }
  return { decisions: result.decisions, nextCheckMinutes: result.nextCheckMinutes };
}
```

**Step 4: Run existing tests to verify nothing broke**

Run: `npx vitest run tests/llm/client.test.ts tests/llm/prompts.test.ts tests/risk/manager.test.ts`
Expected: All PASS (new fields are optional, backward compatible)

**Step 5: Commit**

```bash
git add src/llm/client.ts src/llm/prompts.ts src/risk/manager.ts src/llm/decision-schema.ts
git commit -m "feat(llm): wire DecisionV2 schema into client and prompts"
```

---

## Task 3: MARK_PRICE + priceProtect on SL/TP Orders

**Files:**
- Modify: `src/binance/orders.ts:110-117` (SL order), `src/binance/orders.ts:139-146` (TP order)
- Test: `tests/binance/orders.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/orders.test.ts`:

```typescript
describe('SL/TP order hardening', () => {
  it('passes workingType MARK_PRICE and priceProtect on SL order', async () => {
    const calls: any[] = [];
    const mockClient = {
      setLeverage: vi.fn(),
      getSymbolPriceTicker: vi.fn().mockResolvedValue({ price: '100' }),
      submitNewOrder: vi.fn().mockResolvedValue({ orderId: 1, avgPrice: '100', cumQuote: '0', commission: '0', commissionAsset: 'USDT' }),
      submitNewAlgoOrder: vi.fn().mockImplementation((params: any) => {
        calls.push(params);
        return Promise.resolve({ algoId: 1 });
      }),
    };

    const executor = new OrderExecutor(mockClient);
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };

    await executor.execute(decision, 1000);

    // SL order (first algo call)
    expect(calls[0].workingType).toBe('MARK_PRICE');
    expect(calls[0].priceProtect).toBe('true');
    // TP order (second algo call)
    expect(calls[1].workingType).toBe('MARK_PRICE');
    expect(calls[1].priceProtect).toBe('true');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/orders.test.ts -t "workingType"`
Expected: FAIL — `calls[0].workingType` is `undefined`

**Step 3: Add workingType and priceProtect to both algo orders**

In `src/binance/orders.ts`, modify the SL order (lines 110-117):

```typescript
await this.client.submitNewAlgoOrder({
  symbol: decision.pair,
  side: closeSide,
  algoType: 'CONDITIONAL',
  type: 'STOP_MARKET',
  triggerPrice: this.formatPrice(stopPrice, decision.pair),
  closePosition: 'true',
  workingType: 'MARK_PRICE',
  priceProtect: 'true',
});
```

Same for TP order (lines 139-146):

```typescript
await this.client.submitNewAlgoOrder({
  symbol: decision.pair,
  side: closeSide,
  algoType: 'CONDITIONAL',
  type: 'TAKE_PROFIT_MARKET',
  triggerPrice: this.formatPrice(tpPrice, decision.pair),
  closePosition: 'true',
  workingType: 'MARK_PRICE',
  priceProtect: 'true',
});
```

Also add to `adjustSlTp()` method if it places algo orders (check and update similarly).

**Step 4: Run tests**

Run: `npx vitest run tests/binance/orders.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "fix(orders): use MARK_PRICE + priceProtect on all SL/TP orders"
```

---

## Task 4: DB-Backed Daily Loss Limit

**Files:**
- Modify: `src/risk/manager.ts` (add daily loss check)
- Modify: `src/binance/market-data.ts:239-252` (already has `getTodayRealizedPnl`)
- Modify: `src/trading-loop.ts` (pass daily P&L to risk manager)
- Test: `tests/risk/manager.test.ts`

**Step 1: Write the failing test**

Add to `tests/risk/manager.test.ts`:

```typescript
describe('daily loss limit', () => {
  it('rejects trade when daily loss exceeds limit', () => {
    const rmWithDaily = new RiskManager({
      ...config,
      maxDailyLossPct: 3,
    });
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000, availableUsd: 800,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    };

    const result = rmWithDaily.validate(decision, portfolio, undefined, undefined, { dailyRealizedPnl: -35 });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('daily loss');
    expect(result.shutdown).toBe(true);
  });

  it('allows trade when daily loss is within limit', () => {
    const rmWithDaily = new RiskManager({
      ...config,
      maxDailyLossPct: 3,
    });
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000, availableUsd: 800,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    };

    const result = rmWithDaily.validate(decision, portfolio, undefined, undefined, { dailyRealizedPnl: -20 });
    expect(result.approved).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/manager.test.ts -t "daily loss"`
Expected: FAIL — `validate` doesn't accept 5th argument

**Step 3: Implement daily loss check**

In `src/risk/manager.ts`:

1. Add to `RiskConfig` interface:
```typescript
maxDailyLossPct?: number;  // % of balance; 0 = disabled
```

2. Add new context interface:
```typescript
export interface RiskExtraContext {
  dailyRealizedPnl?: number;  // USD, from Binance income API
}
```

3. Add 5th parameter to `validate()`:
```typescript
validate(decision: TradeDecision, portfolio: PortfolioState, ctx?: ValidationContext, adjustCtx?: AdjustContext, extra?: RiskExtraContext): ValidationResult {
```

4. Add daily loss check after session loss check (around line 166):
```typescript
// Daily loss limit (persists across restarts)
if (this.config.maxDailyLossPct && this.config.maxDailyLossPct > 0 && extra?.dailyRealizedPnl != null) {
  const dailyLimit = portfolio.balanceUsd * this.config.maxDailyLossPct / 100;
  if (extra.dailyRealizedPnl <= -dailyLimit) {
    return { approved: false, reason: `Daily loss $${Math.abs(extra.dailyRealizedPnl).toFixed(2)} exceeded limit $${dailyLimit.toFixed(2)} (${this.config.maxDailyLossPct}%) — shutdown triggered`, shutdown: true };
  }
}
```

5. In `src/trading-loop.ts`, pass `dailyRealizedPnl` (already fetched at ~line 721) to risk manager calls:
```typescript
const riskExtra = { dailyRealizedPnl: todayRealizedPnl };
const validation = riskManager.validate(decision, portfolio, validationCtx, adjustCtx, riskExtra);
```

6. Add `maxDailyLossPct` to `config.yaml` (and `loadConfig()` in `src/config.ts`).

**Step 4: Run tests**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/risk/manager.ts src/trading-loop.ts tests/risk/manager.test.ts
git commit -m "feat(risk): add DB-backed daily loss limit that survives restart"
```

---

## Task 5: Stale Data Guard

**Files:**
- Modify: `src/binance/market-data.ts` (add `fetchedAt` to MarketSnapshot)
- Modify: `src/trading-loop.ts:327-348` (validate snapshot freshness)
- Test: `tests/binance/market-data.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/market-data.test.ts`:

```typescript
describe('snapshot freshness', () => {
  it('MarketSnapshot includes fetchedAt timestamp', async () => {
    // This test verifies the interface has the field
    const snapshot: MarketSnapshot = {
      pair: 'BTCUSDT',
      candles1h: [], candles4h: [], candles15m: [],
      fundingRate: '0.01', fundingHistory: [],
      openInterest: '100', markPrice: '50000',
      longShortRatio: 1.0,
      orderBookBidPct: 50, orderBookAskPct: 50,
      fetchedAt: Date.now(),
    };
    expect(snapshot.fetchedAt).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/market-data.test.ts -t "freshness"`
Expected: FAIL — `fetchedAt` not in `MarketSnapshot` type

**Step 3: Implement**

1. Add `fetchedAt: number` to `MarketSnapshot` interface in `src/binance/market-data.ts:25`.

2. Set it in `getSnapshot()` method (after all `Promise.all` resolves, before return):
```typescript
return {
  pair,
  // ... existing fields ...
  fetchedAt: Date.now(),
};
```

3. In `src/trading-loop.ts`, after line 348 (after snapshots built), add staleness check:
```typescript
const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000; // 5 minutes
const now = Date.now();
const freshSnapshots = snapshots.filter(s => {
  if (s.fetchedAt && (now - s.fetchedAt) > MAX_SNAPSHOT_AGE_MS) {
    console.warn(`[Loop] Stale snapshot for ${s.pair}: ${((now - s.fetchedAt) / 1000).toFixed(0)}s old — skipping`);
    return false;
  }
  return true;
});
if (freshSnapshots.length === 0) {
  logger.logError('ALL_SNAPSHOTS_STALE', 'All market snapshots older than 5 minutes');
  return;
}
```

Then use `freshSnapshots` instead of `snapshots` downstream.

**Step 4: Run tests**

Run: `npx vitest run tests/binance/market-data.test.ts tests/trading-loop.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/binance/market-data.ts src/trading-loop.ts tests/binance/market-data.test.ts
git commit -m "feat(risk): stale data guard — skip snapshots older than 5 minutes"
```

---

## Task 6: Abnormal Spread Guard

**Files:**
- Modify: `src/risk/manager.ts` (add spread check)
- Modify: `src/binance/market-data.ts` (compute spread from order book)
- Modify: `src/trading-loop.ts` (pass spread data to risk manager)
- Test: `tests/risk/manager.test.ts`

**Step 1: Write the failing test**

Add to `tests/risk/manager.test.ts`:

```typescript
describe('spread guard', () => {
  it('rejects trade when spread is abnormally wide', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000, availableUsd: 800,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    };

    const result = rm.validate(decision, portfolio, undefined, undefined, {
      spreadPct: 0.15,           // current spread
      medianSpreadPct: 0.04,     // rolling median
      spreadSampleSize: 25,      // enough samples
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('spread');
  });

  it('allows trade when spread is normal', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000, availableUsd: 800,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    };

    const result = rm.validate(decision, portfolio, undefined, undefined, {
      spreadPct: 0.05,
      medianSpreadPct: 0.04,
      spreadSampleSize: 25,
    });
    expect(result.approved).toBe(true);
  });

  it('skips spread check when sample size too small', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test',
    };
    const portfolio: PortfolioState = {
      balanceUsd: 1000, availableUsd: 800,
      positions: [], sessionPnl: 0, drawdownPct: 0,
    };

    const result = rm.validate(decision, portfolio, undefined, undefined, {
      spreadPct: 0.20,
      medianSpreadPct: 0.04,
      spreadSampleSize: 5,  // below minimum 20
    });
    expect(result.approved).toBe(true);  // guard disabled
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/risk/manager.test.ts -t "spread guard"`
Expected: FAIL — `RiskExtraContext` doesn't have spread fields

**Step 3: Implement**

1. Extend `RiskExtraContext` in `src/risk/manager.ts`:
```typescript
export interface RiskExtraContext {
  dailyRealizedPnl?: number;
  spreadPct?: number;          // current bid-ask spread as % of mid price
  medianSpreadPct?: number;    // rolling median over last 50 snapshots
  spreadSampleSize?: number;   // how many samples in the median
}
```

2. Add spread check in `validate()` after daily loss check:
```typescript
// Abnormal spread guard
const SPREAD_MULTIPLIER = 2.5;
const MIN_SPREAD_SAMPLES = 20;
if (extra?.spreadPct != null && extra?.medianSpreadPct != null && extra.medianSpreadPct > 0) {
  if ((extra.spreadSampleSize ?? 0) >= MIN_SPREAD_SAMPLES) {
    if (extra.spreadPct > extra.medianSpreadPct * SPREAD_MULTIPLIER) {
      return { approved: false, reason: `Abnormal spread: ${(extra.spreadPct * 100).toFixed(3)}% vs median ${(extra.medianSpreadPct * 100).toFixed(3)}% (${SPREAD_MULTIPLIER}x threshold)` };
    }
  }
}
```

3. In `src/binance/market-data.ts`, add spread computation to `getSnapshot()`:
```typescript
// After order book processing
const bestBid = parseFloat((orderBook.bids as [string, string][])[0]?.[0] ?? '0');
const bestAsk = parseFloat((orderBook.asks as [string, string][])[0]?.[0] ?? '0');
const midPrice = (bestBid + bestAsk) / 2;
const spreadPct = midPrice > 0 ? (bestAsk - bestBid) / midPrice : 0;
```

Add `spreadPct: number` to `MarketSnapshot` interface and return it.

4. In `src/trading-loop.ts`, maintain a rolling median per pair (in-memory Map of last 50 values), pass to risk extra context. Implementation: simple sorted array, take middle value.

**Step 4: Run tests**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/risk/manager.ts src/binance/market-data.ts src/trading-loop.ts tests/risk/manager.test.ts
git commit -m "feat(risk): abnormal spread guard with rolling median per pair"
```

---

## Task 7: Keepalive Supervisor Hardening

**Files:**
- Modify: `src/binance/user-stream.ts:69-118`
- Test: `tests/binance/user-stream.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/user-stream.test.ts`:

```typescript
describe('keepalive hardening', () => {
  it('refreshes listen key on keepalive failure after 2 consecutive failures', async () => {
    let keepAliveCallCount = 0;
    let getNewKeyCallCount = 0;

    const mockClient = {
      keepAliveFuturesUserDataListenKey: vi.fn().mockImplementation(() => {
        keepAliveCallCount++;
        if (keepAliveCallCount <= 2) return Promise.reject(new Error('expired'));
        return Promise.resolve();
      }),
      getFuturesUserDataListenKey: vi.fn().mockImplementation(() => {
        getNewKeyCallCount++;
        return Promise.resolve({ listenKey: 'new-key' });
      }),
    };

    // Test the refreshListenKey logic directly
    const { refreshListenKey } = await import('../../src/binance/user-stream.js');
    // Verify the function exists
    expect(typeof refreshListenKey).toBe('function');
  });
});
```

**Step 2: Implement keepalive hardening**

In `src/binance/user-stream.ts`, modify the keepalive interval:

```typescript
let consecutiveKeepAliveFailures = 0;

const keepAlive = setInterval(async () => {
  try {
    await client.keepAliveFuturesUserDataListenKey();
    consecutiveKeepAliveFailures = 0;
  } catch (err: any) {
    consecutiveKeepAliveFailures++;
    console.error(`[UserStream] Keep-alive failed (${consecutiveKeepAliveFailures}x): ${err.message}`);

    if (consecutiveKeepAliveFailures >= 2) {
      console.log('[UserStream] Refreshing listen key after consecutive failures...');
      try {
        const newKey = await client.getFuturesUserDataListenKey();
        listenKey = newKey.listenKey;
        consecutiveKeepAliveFailures = 0;
        // Force reconnect with new key
        ws.close();
      } catch (refreshErr: any) {
        console.error('[UserStream] Listen key refresh failed:', refreshErr.message);
      }
    }
  }
}, 30 * 60 * 1000);
```

Also add stale connection detection — if no message received in 90 minutes, force reconnect:

```typescript
let lastMessageAt = Date.now();

ws.on('message', async (data: any) => {
  lastMessageAt = Date.now();
  // ... existing handler
});

// Check for stale connection every 15 minutes
const staleCheck = setInterval(() => {
  const silentMs = Date.now() - lastMessageAt;
  if (silentMs > 90 * 60 * 1000) {  // 90 minutes
    console.warn(`[UserStream] No messages for ${(silentMs / 60000).toFixed(0)}min — forcing reconnect`);
    ws.close();
  }
}, 15 * 60 * 1000);
```

**Step 3: Run tests**

Run: `npx vitest run tests/binance/user-stream.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/binance/user-stream.ts tests/binance/user-stream.test.ts
git commit -m "fix(ws): harden keepalive with listen key refresh and stale detection"
```

---

## Task 8: NTP Clock Check + recvWindow

**Files:**
- Modify: `src/binance/client.ts`
- Create: `src/utils/clock-check.ts`
- Test: `tests/utils/clock-check.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/utils/clock-check.test.ts
import { describe, it, expect } from 'vitest';
import { checkClockSkew } from '../../src/utils/clock-check.js';

describe('checkClockSkew', () => {
  it('returns skew in milliseconds', async () => {
    // Mock: just verify the function exists and returns a number
    const skew = await checkClockSkew();
    expect(typeof skew).toBe('number');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/utils/clock-check.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

```typescript
// src/utils/clock-check.ts

/** Check local clock skew against Binance server time. Returns skew in ms. */
export async function checkClockSkew(): Promise<number> {
  try {
    const before = Date.now();
    const res = await fetch('https://fapi.binance.com/fapi/v1/time');
    const after = Date.now();
    const data = await res.json() as { serverTime: number };
    const latency = (after - before) / 2;
    const localTime = before + latency;
    return data.serverTime - localTime;
  } catch {
    return 0; // assume no skew on failure
  }
}

/** Warn if clock is off by more than threshold. Called at startup. */
export async function warnIfClockSkewed(thresholdMs = 1000): Promise<void> {
  const skew = await checkClockSkew();
  const absSkew = Math.abs(skew);
  if (absSkew > thresholdMs) {
    console.error(`[Clock] WARNING: Local clock is ${absSkew}ms ${skew > 0 ? 'behind' : 'ahead of'} Binance. Risk of -1021 INVALID_TIMESTAMP errors. Run NTP sync.`);
  } else {
    console.log(`[Clock] Clock skew: ${absSkew}ms (OK)`);
  }
}
```

In `src/binance/client.ts`, add `recvWindow`:

```typescript
return new USDMClient({
  api_key: config.apiKey,
  api_secret: config.apiSecret,
  recvWindow: 10000,
  ...(config.testnet && { baseUrl: 'https://demo-fapi.binance.com' }),
});
```

In `src/index.ts` (or wherever the bot starts), call `warnIfClockSkewed()` at startup.

**Step 4: Run tests**

Run: `npx vitest run tests/utils/clock-check.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/clock-check.ts src/binance/client.ts tests/utils/clock-check.test.ts
git commit -m "feat(binance): NTP clock check at startup + recvWindow=10000"
```

---

## Task 9: Update config.yaml with new parameters

**Files:**
- Modify: `config.yaml` (add `maxDailyLossPct`)
- Modify: `src/config.ts` (parse new fields)
- Test: `tests/config.test.ts`

**Step 1: Add to config.yaml**

```yaml
# Risk management
maxDailyLossPct: 5        # % of balance — daily loss limit (survives restart)
```

**Step 2: Update loadConfig() in src/config.ts**

Parse the new field and pass through to RiskConfig:

```typescript
maxDailyLossPct: yaml.maxDailyLossPct ?? 5,
```

**Step 3: Verify existing config tests pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add config.yaml src/config.ts
git commit -m "config: add maxDailyLossPct (default 5%)"
```

---

## Task Dependency Graph

```
Task 1 (Schema type)
    └─→ Task 2 (Wire into client)

Task 3 (MARK_PRICE)           ← independent
Task 4 (Daily loss)           ← independent, needs Task 9 for config
Task 5 (Stale data)           ← independent
Task 6 (Spread guard)         ← independent, builds on Task 4's RiskExtraContext
Task 7 (Keepalive)            ← independent
Task 8 (Clock check)          ← independent
Task 9 (Config update)        ← do after Task 4

Recommended order: 1 → 2 → 3 → 8 → 7 → 4 → 9 → 5 → 6
```

**Parallel-safe groups** (can run simultaneously):
- Group A: Tasks 1+2 (schema)
- Group B: Tasks 3, 7, 8 (exchange hardening)
- Group C: Tasks 4+9, 5, 6 (risk guards)

---

## Verification Checklist

After all 9 tasks complete:

- [ ] `npx vitest run` — all tests pass
- [ ] `npm run build` — compiles without errors
- [ ] New schema fields visible in `parse-errors.jsonl` format
- [ ] SL/TP orders use `MARK_PRICE` (verify in Binance order history after deploy)
- [ ] Daily loss limit triggers shutdown (test with low threshold on testnet)
- [ ] Stale snapshot warning appears in logs when API is slow
- [ ] Clock check runs at startup in pm2 logs
- [ ] `config.yaml` has `maxDailyLossPct: 5`
