# Smart Bot Intelligence Upgrade — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform trading bot from blind executor to adaptive decision-maker with confidence scoring, hard guardrails, enriched prompts, and feedback loops.

**Architecture:** Hybrid approach — soft rules in LLM prompts (override with high confidence) + hard guardrails in code (Risk Manager enforces limits regardless of LLM). TDD throughout: write failing test → implement → verify → commit.

**Tech Stack:** TypeScript ESM, Vitest, Binance Futures API, OpenAI Codex SSE.

---

### Task 1: Fix sessionPnL — use real Binance balance

**Files:**
- Modify: `src/memory/session.ts`
- Modify: `src/trading-loop.ts`
- Modify: `tests/trading-loop.test.ts`

**Context:** `sessionPnl` is currently self-tracked in TradingLoop and only updated on successful CLOSE. If position closes externally (liquidation), sessionPnl stays wrong. Risk manager's max-loss check is effectively broken.

**Step 1: Add startBalance to SessionMemory**

In `src/memory/session.ts`, add `start_balance` field to `MemoryState` interface (line 12):

```typescript
export interface MemoryState {
  session_notes: string;
  recent_trades: TradeRecord[];
  last_updated: string;
  start_balance?: number;        // NEW — set on first cycle
  last_order_result?: string;    // NEW — for Task 10
}
```

Add two methods to `SessionMemory`:

```typescript
getStartBalance(): number | undefined {
  return this.load().start_balance;
}

setStartBalance(balance: number): void {
  const state = this.load();
  if (state.start_balance === undefined) {
    state.start_balance = balance;
    state.last_updated = new Date().toISOString();
    this.save(state);
  }
}
```

**Step 2: Update TradingLoop to use real sessionPnl**

In `src/trading-loop.ts`:

Remove `private sessionPnl = 0;` (line 49).

Add to `runOnce()`, right after `const portfolio = await marketData.getPortfolioState();` (line 85):

```typescript
// Real sessionPnl from Binance balance
this.deps.memory.setStartBalance(portfolio.balanceUsd);
const startBalance = this.deps.memory.getStartBalance()!;
const sessionPnl = portfolio.balanceUsd - startBalance;
portfolio.sessionPnl = sessionPnl;
```

Remove the line `portfolio.sessionPnl = this.sessionPnl;` (line 86).

Remove the `this.sessionPnl += pnlUsd;` line inside the CLOSE handler (line 209).

In the `logger.logPerformance` call (line 244), replace `sessionPnl: this.sessionPnl` with `sessionPnl`.

**Step 3: Update test mock**

In `tests/trading-loop.test.ts`, update memory mock to include:

```typescript
getStartBalance: vi.fn().mockReturnValue(100),
setStartBalance: vi.fn(),
```

Update the "accumulates sessionPnl" test to verify that `portfolio.sessionPnl` is computed from balance delta (not manual tracking).

**Step 4: Run tests**

```bash
npx vitest run tests/trading-loop.test.ts
npx vitest run tests/
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/memory/session.ts src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "fix: use real Binance balance for sessionPnl — no more self-tracking"
```

---

### Task 2: SL/TP failure → cancel trade

**Files:**
- Modify: `src/binance/orders.ts`
- Create: `tests/binance/orders.test.ts`

**Context:** Currently if SL placement fails after entry, the position is left UNPROTECTED. Bot logs "success." This is catastrophic risk.

**Step 1: Write failing test**

Create `tests/binance/orders.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { OrderExecutor } from '../../src/binance/orders.js';

function makeMockClient(overrides: Record<string, any> = {}) {
  return {
    setLeverage: vi.fn().mockResolvedValue({}),
    getSymbolPriceTicker: vi.fn().mockResolvedValue({ price: '50000' }),
    submitNewOrder: vi.fn().mockResolvedValue({ orderId: 1 }),
    getPositions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('OrderExecutor', () => {
  it('closes position if SL placement fails', async () => {
    let callCount = 0;
    const client = makeMockClient({
      submitNewOrder: vi.fn().mockImplementation(async (params: any) => {
        callCount++;
        if (callCount === 1) return { orderId: 1 }; // entry OK
        if (callCount === 2) throw new Error('SL rejected'); // SL fails
        return { orderId: 3 }; // close position
      }),
      getPositions: vi.fn().mockResolvedValue([
        { symbol: 'BTCUSDT', positionAmt: '0.001' },
      ]),
    });

    const executor = new OrderExecutor(client as any);
    const result = await executor.execute(
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test' },
      10000,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('SL');
    // Should have called submitNewOrder 3 times: entry, SL (fail), close
    expect(client.submitNewOrder).toHaveBeenCalledTimes(3);
  });

  it('succeeds if only TP fails (SL is set)', async () => {
    let callCount = 0;
    const client = makeMockClient({
      submitNewOrder: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { orderId: 1 }; // entry
        if (callCount === 2) return { orderId: 2 }; // SL OK
        throw new Error('TP rejected'); // TP fails
      }),
    });

    const executor = new OrderExecutor(client as any);
    const result = await executor.execute(
      { pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test' },
      10000,
    );

    expect(result.success).toBe(true); // TP failure is non-fatal
  });
});
```

**Step 2: Run test, verify fail**

```bash
npx vitest run tests/binance/orders.test.ts
```

Expected: FAIL (current code returns success even when SL fails).

**Step 3: Fix `execute()` in `src/binance/orders.ts`**

Replace the SL placement block (lines 31-50) with:

```typescript
// Stop-Loss (MANDATORY — fail = cancel trade)
try {
  const stopPrice = side === 'BUY'
    ? price * (1 - decision.stop_loss_pct / 100)
    : price * (1 + decision.stop_loss_pct / 100);
  await this.client.submitNewOrder({
    symbol: decision.pair,
    side: side === 'BUY' ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: this.roundPrice(stopPrice),
    closePosition: 'true',
    timeInForce: 'GTE_GTC',
  });
} catch (slErr: any) {
  console.error(`[Orders] SL placement FAILED for ${decision.pair} — closing position!`, slErr.message);
  // Close the entry position immediately
  try {
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    await this.client.submitNewOrder({
      symbol: decision.pair,
      side: closeSide,
      type: 'MARKET',
      quantity: String(quantity),
      reduceOnly: 'true',
    });
  } catch (closeErr: any) {
    console.error(`[Orders] CRITICAL: Failed to close unprotected position ${decision.pair}!`, closeErr.message);
  }
  return { success: false, error: `SL failed: ${slErr.message} — position closed` };
}
```

Keep TP block as-is (non-fatal warning).

**Step 4: Run tests**

```bash
npx vitest run tests/binance/orders.test.ts
npx vitest run tests/
```

**Step 5: Commit**

```bash
git add src/binance/orders.ts tests/binance/orders.test.ts
git commit -m "fix: cancel trade if SL placement fails — no unprotected positions"
```

---

### Task 3: JSON regex fix + retry + parse-errors log

**Files:**
- Modify: `src/llm/client.ts`
- Modify: `tests/llm/client.test.ts`

**Context:** Current regex `/\{[\s\S]*\}/` is too greedy. If LLM writes explanation before JSON, entire response matches. Also no retry on parse failure.

**Step 1: Write failing test**

Add to `tests/llm/client.test.ts`:

```typescript
it('parses JSON even with explanation text around it', async () => {
  const jsonWithExplanation = `Here's my analysis of the market conditions.

{"decisions":[{"pair":"BTCUSDT","action":"HOLD","size_pct":0,"leverage":0,"stop_loss_pct":0,"take_profit_pct":0,"reasoning":"test","confidence":75}]}

I hope this helps.`;

  mockSSEResponse(jsonWithExplanation);
  const data = makePromptData();
  const result = await client.analyze(data);
  expect(result).toHaveLength(1);
  expect(result[0].action).toBe('HOLD');
});

it('handles confidence field in decisions', async () => {
  const json = JSON.stringify({
    decisions: [{ pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5, stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'strong', confidence: 85 }],
  });
  mockSSEResponse(json);
  const result = await client.analyze(makePromptData());
  expect(result[0].confidence).toBe(85);
});
```

**Step 2: Fix `parseResponse()` in `src/llm/client.ts`**

Replace the `parseResponse` method (lines 241-254):

```typescript
private parseResponse(content: string): TradeDecision[] {
  try {
    // Try targeted regex first: look for object containing "decisions" array
    let jsonMatch = content.match(/\{[^{}]*"decisions"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/);
    if (!jsonMatch) {
      // Fallback: greedy match (handles nested objects in reasoning)
      jsonMatch = content.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
    }
    if (!jsonMatch) {
      this.logParseError(content, 'No JSON with "decisions" key found');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.decisions)) {
      this.logParseError(content, 'decisions is not an array');
      return [];
    }
    return parsed.decisions;
  } catch (err: any) {
    this.logParseError(content, err.message);
    return [];
  }
}

private logParseError(content: string, reason: string): void {
  console.error(`[LLM] Parse failed: ${reason} — response: ${content.slice(0, 200)}`);
  try {
    const { appendFileSync, mkdirSync } = require('fs');
    mkdirSync('logs', { recursive: true });
    appendFileSync('logs/parse-errors.jsonl', JSON.stringify({
      ts: new Date().toISOString(),
      reason,
      response: content.slice(0, 2000),
    }) + '\n', 'utf-8');
  } catch { /* non-critical */ }
}
```

**Step 3: Add retry on parse failure in `analyze()`**

In the `analyze()` method, after `const result = this.parseResponse(...)` returns empty:

```typescript
let decisions = this.parseResponse(sseResult.content);

// Retry once if parse failed
if (decisions.length === 0 && sseResult.content.length > 10) {
  console.log('[LLM] Parse failed, retrying with clarification prompt...');
  const retryBody = { ...body, input: [{ role: 'user', content: 'Your last response was not valid JSON. Respond ONLY with the JSON object containing "decisions" array. No explanation.' }] };
  const retryResponse = await fetch(CODEX_BASE_URL, { method: 'POST', headers, body: JSON.stringify(retryBody) });
  if (retryResponse.ok) {
    const retryResult = await this.streamSSE(retryResponse);
    this.tokenLogger.log({ method: 'analyze', label: 'retry', tokensIn: retryResult.usageIn, tokensOut: retryResult.usageOut, model: this.model });
    decisions = this.parseResponse(retryResult.content);
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/llm/client.test.ts
npx vitest run tests/
```

**Step 5: Commit**

```bash
git add src/llm/client.ts tests/llm/client.test.ts
git commit -m "fix: smarter JSON extraction + retry on parse failure + parse-errors log"
```

---

### Task 4: Add config options for new features

**Files:**
- Modify: `src/config.ts`

**Step 1: Add new config fields**

In `src/config.ts`, add to the trading section of the Config interface and loadConfig():

```typescript
// In Config interface, trading section:
minConfidence: number;          // min LLM confidence to execute (default 55)
stalePositionHours: number;     // auto-close stale positions (default 8)
maxHoldHours: number;           // force close after N hours (default 24)
fearGreedLeverageCap: number;   // max leverage in extreme F&G (default 10)
```

In `loadConfig()`, add to trading object:

```typescript
minConfidence: parseInt(process.env.MIN_CONFIDENCE || '55'),
stalePositionHours: parseFloat(process.env.STALE_POSITION_HOURS || '8'),
maxHoldHours: parseFloat(process.env.MAX_HOLD_HOURS || '24'),
fearGreedLeverageCap: parseInt(process.env.FEAR_GREED_LEVERAGE_CAP || '10'),
```

**Step 2: Run tests**

```bash
npx vitest run tests/
```

**Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config for minConfidence, stalePositionHours, maxHoldHours, fearGreedLeverageCap"
```

---

### Task 5: Add confidence field to TradeDecision + parsing

**Files:**
- Modify: `src/risk/manager.ts`
- Modify: `src/llm/client.ts` (parseResponse)
- Modify: `tests/risk/manager.test.ts`

**Context:** LLM decisions currently have no confidence score. Bot treats weak and strong signals equally.

**Step 1: Add confidence to TradeDecision interface**

In `src/risk/manager.ts`, update `TradeDecision` (line 1-9):

```typescript
export interface TradeDecision {
  pair: string;
  action: 'LONG' | 'SHORT' | 'CLOSE' | 'HOLD' | 'FETCH_NEWS';
  size_pct: number;
  leverage: number;
  stop_loss_pct: number;
  take_profit_pct: number;
  reasoning: string;
  confidence?: number;  // 1-100, default 50
}
```

**Step 2: Ensure `parseResponse` preserves confidence**

In `src/llm/client.ts`, the existing `parseResponse` already returns `parsed.decisions` directly which includes any extra fields. No change needed — confidence flows through automatically.

**Step 3: Add confidence-based rejection to RiskManager**

In `src/risk/manager.ts`, add a new config field:

```typescript
export interface RiskConfig {
  maxLeverage: number;
  maxPositionPct: number;
  maxExposurePct: number;
  maxStopLossPct: number;
  maxLossUsd: number;
  maxLossPct: number;
  minConfidence?: number;  // NEW — default 55
}
```

In `validate()`, after the HOLD/CLOSE/FETCH_NEWS early return (line 48), add:

```typescript
// Confidence check
const confidence = decision.confidence ?? 50;
const minConf = this.config.minConfidence ?? 55;
if (confidence < minConf) {
  return { approved: false, reason: `Low confidence: ${confidence} < ${minConf}` };
}
```

**Step 4: Write test for confidence rejection**

Add to `tests/risk/manager.test.ts`:

```typescript
it('rejects low-confidence decisions', () => {
  const rm = new RiskManager({ ...config, minConfidence: 60 });
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'weak signal',
    confidence: 45,
  };
  const result = rm.validate(decision, basePortfolio);
  expect(result.approved).toBe(false);
  expect(result.reason).toContain('confidence');
});

it('approves high-confidence decisions', () => {
  const rm = new RiskManager({ ...config, minConfidence: 60 });
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'strong setup',
    confidence: 85,
  };
  const result = rm.validate(decision, basePortfolio);
  expect(result.approved).toBe(true);
});
```

**Step 5: Run tests**

```bash
npx vitest run tests/risk/manager.test.ts
npx vitest run tests/
```

**Step 6: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts
git commit -m "feat: add confidence scoring to decisions — reject below minConfidence"
```

---

### Task 6: Hard guardrails in Risk Manager

**Files:**
- Modify: `src/risk/manager.ts`
- Modify: `tests/risk/manager.test.ts`

**Context:** Code-enforced safety nets that LLM cannot bypass. Risk manager needs additional context: indicators4h, fearGreed, positions.

**Step 1: Extend validate() signature**

Update `validate()` to accept optional context:

```typescript
export interface ValidationContext {
  indicators4h?: Map<string, { trend: string }>;
  fearGreed?: { value: number };
  fearGreedLeverageCap?: number;
}

validate(decision: TradeDecision, portfolio: PortfolioState, ctx?: ValidationContext): ValidationResult {
```

**Step 2: Add guardrails after existing checks**

After the exposure check (line 81), add:

```typescript
// 4h timeframe confirmation (soft — overridable with high confidence)
if (ctx?.indicators4h) {
  const trend4h = ctx.indicators4h.get(decision.pair)?.trend;
  const confidence = decision.confidence ?? 50;
  if (decision.action === 'LONG' && trend4h === 'bearish' && confidence < 80) {
    return { approved: false, reason: `4h trend bearish — need confidence >=80 (got ${confidence})` };
  }
  if (decision.action === 'SHORT' && trend4h === 'bullish' && confidence < 80) {
    return { approved: false, reason: `4h trend bullish — need confidence >=80 (got ${confidence})` };
  }
}

// Fear & Greed leverage cap
if (ctx?.fearGreed) {
  const fgCap = ctx.fearGreedLeverageCap ?? 10;
  if ((ctx.fearGreed.value < 25 || ctx.fearGreed.value > 85) && decision.leverage > fgCap) {
    return { approved: false, reason: `Extreme F&G (${ctx.fearGreed.value}) — max leverage ${fgCap}x (requested ${decision.leverage}x)` };
  }
}

// Session loss scaling
if (portfolio.sessionPnl < 0 && portfolio.balanceUsd > 0) {
  const lossPct = Math.abs(portfolio.sessionPnl) / portfolio.balanceUsd * 100;
  let adjustedMaxLeverage = this.config.maxLeverage;
  let adjustedMaxSize = this.config.maxPositionPct;
  if (lossPct >= 10) {
    adjustedMaxLeverage = Math.min(5, this.config.maxLeverage);
    adjustedMaxSize = Math.min(25, this.config.maxPositionPct);
  } else if (lossPct >= 5) {
    adjustedMaxLeverage = Math.floor(this.config.maxLeverage / 2);
    adjustedMaxSize = Math.floor(this.config.maxPositionPct / 2);
  }
  if (decision.leverage > adjustedMaxLeverage) {
    return { approved: false, reason: `Session loss ${lossPct.toFixed(1)}% — max leverage reduced to ${adjustedMaxLeverage}x` };
  }
  if (decision.size_pct > adjustedMaxSize) {
    return { approved: false, reason: `Session loss ${lossPct.toFixed(1)}% — max size reduced to ${adjustedMaxSize}%` };
  }
}

// Duplicate position check
const existingSameDirection = portfolio.positions.find(
  p => p.pair === decision.pair && p.side === decision.action
);
if (existingSameDirection) {
  return { approved: false, reason: `Already ${decision.action} on ${decision.pair}` };
}
```

**Step 3: Write tests for each guardrail**

Add to `tests/risk/manager.test.ts`:

```typescript
describe('Hard guardrails', () => {
  it('rejects LONG when 4h bearish and confidence < 80', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 65,
    };
    const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
    const result = rm.validate(decision, basePortfolio, ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('4h trend bearish');
  });

  it('allows LONG against 4h if confidence >= 80', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 85,
    };
    const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
    const result = rm.validate(decision, basePortfolio, ctx);
    expect(result.approved).toBe(true);
  });

  it('caps leverage in extreme Fear & Greed', () => {
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 15,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
    };
    const ctx = { fearGreed: { value: 20 }, fearGreedLeverageCap: 10 };
    const result = rm.validate(decision, basePortfolio, ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Extreme F&G');
  });

  it('reduces leverage on session loss > 5%', () => {
    const portfolio = { ...basePortfolio, balanceUsd: 100, sessionPnl: -6 };
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 8,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Session loss');
  });

  it('rejects duplicate position', () => {
    const portfolio = {
      ...basePortfolio,
      positions: [{ pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG' as const, entryPrice: 50000, unrealizedPnlPct: 1, heldHours: 2 }],
    };
    const decision: TradeDecision = {
      pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
      stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 70,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Already LONG');
  });
});
```

**Step 4: Run tests**

```bash
npx vitest run tests/risk/manager.test.ts
npx vitest run tests/
```

**Step 5: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts
git commit -m "feat: hard guardrails — 4h confirmation, F&G cap, loss scaling, duplicate check"
```

---

### Task 7: Position age auto-exit

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `tests/trading-loop.test.ts`

**Context:** Positions hang for hours without progress. Bot should auto-close stale positions.

**Step 1: Add auto-exit logic in runOnce()**

In `src/trading-loop.ts`, after portfolio state fetch and before news refresh, add:

```typescript
// Auto-exit stale positions
const staleHours = this.deps.tradingConfig.stalePositionHours ?? 8;
const maxHoldHours = this.deps.tradingConfig.maxHoldHours ?? 24;

for (const pos of portfolio.positions) {
  let closeReason: string | null = null;

  if (pos.heldHours > maxHoldHours) {
    closeReason = `max_hold_${maxHoldHours}h`;
  } else if (pos.heldHours > staleHours && Math.abs(pos.unrealizedPnlPct) < 1) {
    closeReason = `stale_${staleHours}h`;
  }

  if (closeReason) {
    console.log(`[AutoExit] Closing ${pos.pair} ${pos.side} — ${closeReason} (held ${pos.heldHours.toFixed(1)}h, P&L: ${pos.unrealizedPnlPct.toFixed(1)}%)`);
    const result = await orders.close(pos.pair, pos.side);
    if (result.success) {
      this.deps.logger.logTrade({ type: 'AUTO_CLOSE', pair: pos.pair, reason: closeReason });
      this.lastClosedAt.set(pos.pair, Date.now());
      this.deps.memory.addTrade({
        pair: pos.pair,
        action: 'AUTO_CLOSE',
        pnlUsd: pos.unrealizedPnlPct * (pos.sizeUsd / pos.leverage) / 100,
        pnlPct: pos.unrealizedPnlPct,
        closedAt: new Date().toISOString(),
      });
    }
  }
}
```

**Step 2: Update TradingLoopDeps.tradingConfig**

Add the new fields to `tradingConfig` in the interface:

```typescript
tradingConfig: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
  stalePositionHours?: number;   // NEW
  maxHoldHours?: number;         // NEW
};
```

**Step 3: Write test**

Add to `tests/trading-loop.test.ts`:

```typescript
it('auto-closes stale positions (>8h, <1% P&L)', async () => {
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 100,
    sessionPnl: 0,
    positions: [{
      pair: 'BTCUSDT', sizeUsd: 500, leverage: 5, side: 'LONG',
      entryPrice: 50000, unrealizedPnlPct: 0.3, heldHours: 9,
    }],
  });
  mockOrders.close.mockResolvedValue({ success: true, orderId: 99 });
  mockLlm.analyze.mockResolvedValue([]);

  await loop.runOnce();

  expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');
  expect(mockLogger.logTrade).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'AUTO_CLOSE', reason: expect.stringContaining('stale') }),
  );
});
```

**Step 4: Run tests**

```bash
npx vitest run tests/trading-loop.test.ts
npx vitest run tests/
```

**Step 5: Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: auto-exit stale positions — close after 8h no progress or 24h max hold"
```

---

### Task 8: System prompt rewrite

**Files:**
- Modify: `src/llm/prompts.ts`

**Context:** Current system prompt has basic rules. Need to add multi-timeframe confirmation, regime scaling, volume/funding guidance, confluence checklist, confidence scoring instruction, and position management rules.

**Step 1: Rewrite `buildSystemPrompt()` in `src/llm/prompts.ts`**

Replace the return string in `buildSystemPrompt()` (lines 25-64):

```typescript
return `You are an aggressive crypto futures trader managing a LIVE account with real money.
Trading pairs: ${config.pairs?.join(', ') ?? 'BTCUSDT, ETHUSDT, SOLUSDT'}
Monitoring macro: Oil (WTI), DXY, S&P500, VIX, EUR/USD, Gold, BTC Dominance
Target: +${config.targetReturnPct}% returns.

You receive: technical indicators (1h + 4h), funding rate, open interest, Fear & Greed, news with age, macro analysis, portfolio with open positions, session P&L, recent trade history.

MULTI-TIMEFRAME CONFIRMATION:
- LONG: Only if 1h AND 4h trends align bullish (EMA20 > EMA50). If only 1h bullish but 4h bearish, HOLD or use minimal leverage (3-5x).
- SHORT: Only if 1h AND 4h trends align bearish. If only 1h bearish but 4h bullish, HOLD.
- 4h trend overrides 1h for direction. Use 1h for entry timing.

ENTRY RULES:
- Trend-following: LONG if EMA20 > EMA50 (both timeframes), SHORT if EMA20 < EMA50
- Momentum: RSI 40-65 for LONG, 35-60 for SHORT. Avoid entries with RSI > 70 or RSI < 30.
- Volume: Only enter if volume ratio > 1.0x (current above 20-period average). Volume < 0.8x = avoid.
- VWAP: LONG only if price above VWAP. SHORT only if price below VWAP.
- Bollinger: Avoid LONG if %B > 90% (overbought). Avoid SHORT if %B < 10% (oversold).

CONFLUENCE CHECKLIST (need 3+ of 5 for entry):
1. EMA trend alignment (1h + 4h same direction)
2. RSI in entry zone
3. Price above/below VWAP (matching direction)
4. Volume > 1x average
5. News/macro catalyst (importance >= 5 or macro signal aligns)
If <3 factors: HOLD or minimal leverage (3-5x).

FUNDING & OI SIGNALS:
- Funding rate < -0.05%: Crowded shorts, lean LONG if technicals confirm
- Funding rate > +0.1%: Crowded longs, lean SHORT if technicals confirm
- Funding trend rising 3+ periods: Follow momentum
- OI up >10% with flat price: Leverage buildup, risk of liquidation wick — reduce size

MARKET REGIME (Fear & Greed):
- Extreme Fear (<25): Only highest-confluence setups. Expect capitulation wicks. Max leverage reduced.
- Extreme Greed (>85): Expect mean reversion. Prefer shorts. Max leverage reduced.
- Normal (25-85): Standard rules.

POSITION MANAGEMENT:
- Exit rule 1: P&L < -${config.maxStopLossPct / 2}% and held > 4h with no recovery → CLOSE
- Exit rule 2: RSI > 78 on LONG → CLOSE. RSI < 22 on SHORT → CLOSE.
- Exit rule 3: Position held > 8h with P&L between -1% and +1% (stale) → CLOSE
- Exit rule 4: MACD histogram flipped against position direction → tighten exit
- After 2 consecutive losses on same pair: Skip next signal on that pair

RISK SCALING (enforced by system, your awareness helps):
- If session P&L < -5%: System halves max leverage and position size
- If session P&L < -10%: System caps leverage at 5x, position size at 25%
- Extreme Fear/Greed: System caps leverage at ${config.fearGreedLeverageCap ?? 10}x
- If confidence < ${config.minConfidence ?? 55}: System will reject your trade

CONSTRAINTS:
- Max leverage: ${config.maxLeverage}x
- Max position size: ${config.maxPositionPct}% of balance per trade
- Stop-loss MANDATORY (1-${config.maxStopLossPct}%)
- Minimum take-profit: ${config.minTakeProfitPct}%
- This is LIVE money. Be selective.
- Do NOT scalp. Target swing moves.

Respond ONLY with valid JSON:
{
  "decisions": [
    {
      "pair": "BTCUSDT",
      "action": "LONG" | "SHORT" | "CLOSE" | "HOLD",
      "size_pct": <0-${config.maxPositionPct}>,
      "leverage": <1-${config.maxLeverage}>,
      "stop_loss_pct": <1-${config.maxStopLossPct}>,
      "take_profit_pct": <${config.minTakeProfitPct}-50>,
      "reasoning": "<2-3 sentences: what signals aligned, what's the thesis>",
      "confidence": <1-100>
    }
  ]
}

confidence guide: <30 = very uncertain, 30-55 = weak, 55-70 = moderate, 70-85 = strong, >85 = very strong
Always include a decision for every pair. HOLD = do nothing.
If you need fresher news: { "pair": "_meta", "action": "FETCH_NEWS", ... }`;
```

**Step 2: Update buildSystemPrompt signature**

Add new config fields:

```typescript
export function buildSystemPrompt(config: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
  pairs?: string[];
  minConfidence?: number;        // NEW
  fearGreedLeverageCap?: number; // NEW
}): string {
```

**Step 3: Run tests**

```bash
npx vitest run tests/
```

If `client.test.ts` breaks on prompt checks, update the SYSTEM_PROMPT constant (line 68-71) or adjust test assertions.

**Step 4: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: comprehensive system prompt — multi-timeframe, confluence checklist, confidence, regime scaling"
```

---

### Task 9: User prompt data narratives

**Files:**
- Modify: `src/llm/prompts.ts`

**Context:** Replace raw numbers with interpreted narratives. LLM makes better decisions when data is pre-interpreted.

**Step 1: Add narrative helpers to `buildEnrichedPrompt()`**

In the per-snapshot loop (after line 153 — vol ratio), add narratives:

```typescript
// Volume narrative
if (ind) {
  if (ind.volumeRatio > 1.8) {
    prompt += `!! HIGH VOLUME: ${ind.volumeRatio.toFixed(1)}x average — strong conviction\n`;
  } else if (ind.volumeRatio < 0.7) {
    prompt += `!! LOW VOLUME: ${ind.volumeRatio.toFixed(1)}x average — low conviction, weak move\n`;
  }

  // VWAP positioning
  const vwapDelta = ((currentPrice - ind.vwap) / ind.vwap * 100);
  const vwapSide = vwapDelta > 0 ? 'above' : 'below';
  const vwapBias = vwapDelta > 0 ? 'bullish' : 'bearish';
  prompt += `VWAP: price ${Math.abs(vwapDelta).toFixed(2)}% ${vwapSide} — ${vwapBias} intraday bias\n`;

  // Bollinger Band alerts
  if (ind.bollingerPercentB > 90) {
    prompt += `!! AT UPPER BAND (%B=${ind.bollingerPercentB.toFixed(0)}%) — overbought, reversal risk\n`;
  } else if (ind.bollingerPercentB < 10) {
    prompt += `!! AT LOWER BAND (%B=${ind.bollingerPercentB.toFixed(0)}%) — oversold, bounce potential\n`;
  }
}
```

After the funding history block (line 176), add:

```typescript
// Funding trend narrative
if (snap.fundingHistory && snap.fundingHistory.length >= 3) {
  const rates = snap.fundingHistory.map(f => f.rate);
  const first = rates[0];
  const last = rates[rates.length - 1];
  const trend = last > first ? 'RISING' : last < first ? 'FALLING' : 'STABLE';
  prompt += `Funding trend: ${trend} (${(first * 100).toFixed(4)}% → ${(last * 100).toFixed(4)}%)\n`;
  if (last < -0.0005) prompt += `!! NEGATIVE FUNDING: crowded shorts, potential squeeze\n`;
  if (last > 0.001) prompt += `!! HIGH FUNDING: crowded longs, potential dump\n`;
}
```

**Step 2: Add trade performance analysis**

Before the portfolio section (line 272), add:

```typescript
// Trade performance analysis
if (data.recentTrades && data.recentTrades.length > 0) {
  const wins = data.recentTrades.filter(t => t.pnlUsd >= 0);
  const losses = data.recentTrades.filter(t => t.pnlUsd < 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnlUsd), 0) / losses.length : 0;

  prompt += '## Trade Performance\n';
  prompt += `Last ${data.recentTrades.length} trades: ${wins.length}W-${losses.length}L`;
  if (wins.length > 0 || losses.length > 0) {
    prompt += ` | Avg win: $${avgWin.toFixed(2)}, Avg loss: $${avgLoss.toFixed(2)}`;
  }
  prompt += '\n';

  // Streak detection
  let streak = 0;
  let streakType = '';
  for (const t of data.recentTrades) {
    if (streak === 0) { streakType = t.pnlUsd >= 0 ? 'W' : 'L'; streak = 1; }
    else if ((t.pnlUsd >= 0 ? 'W' : 'L') === streakType) streak++;
    else break;
  }
  if (streak >= 2 && streakType === 'L') {
    prompt += `!! LOSING STREAK: ${streak} consecutive losses — reduce size, be more selective\n`;
  }
  prompt += '\n';
}
```

**Step 3: Run tests**

```bash
npx vitest run tests/
```

**Step 4: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "feat: data narratives — volume/VWAP/Bollinger/funding interpretation + trade performance analysis"
```

---

### Task 10: Session state + order feedback in prompt

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `src/trading-loop.ts`
- Modify: `src/memory/session.ts`

**Context:** LLM should know session status, risk level, and result of its last order.

**Step 1: Add lastOrderResult to SessionMemory**

In `src/memory/session.ts`, add method:

```typescript
setLastOrderResult(result: string): void {
  const state = this.load();
  state.last_order_result = result;
  state.last_updated = new Date().toISOString();
  this.save(state);
}

getLastOrderResult(): string | undefined {
  return this.load().last_order_result;
}
```

**Step 2: Save order results in TradingLoop**

In `src/trading-loop.ts`, after successful execute (line 230-236):

```typescript
this.deps.memory.setLastOrderResult(
  `${decision.pair} ${decision.action} filled — SL/TP set`
);
```

After failed execute (line 238-240):

```typescript
this.deps.memory.setLastOrderResult(
  `${decision.pair} ${decision.action} FAILED: ${result.error}`
);
```

After auto-exit:

```typescript
this.deps.memory.setLastOrderResult(
  `${pos.pair} AUTO_CLOSE — ${closeReason}`
);
```

**Step 3: Add session context to EnrichedPromptData**

In `src/llm/prompts.ts`, add to `EnrichedPromptData`:

```typescript
sessionPnlPct?: number;        // NEW
lastOrderResult?: string;       // NEW
riskStatus?: string;            // NEW — 'normal' | 'reduced' | 'critical'
```

**Step 4: Add session context block to buildEnrichedPrompt()**

After `## Context` line (line 135), add:

```typescript
// Session status
if (data.sessionPnlPct !== undefined) {
  const sign = data.sessionPnlPct >= 0 ? '+' : '';
  let riskLabel = 'NORMAL';
  if (data.riskStatus === 'critical') riskLabel = 'CRITICAL — leverage heavily reduced';
  else if (data.riskStatus === 'reduced') riskLabel = 'REDUCED — leverage halved';
  prompt += `Session P&L: ${sign}${data.sessionPnlPct.toFixed(2)}% | Risk status: ${riskLabel}\n`;
}
if (data.lastOrderResult) {
  prompt += `Last order: ${data.lastOrderResult}\n`;
}
prompt += '\n';
```

**Step 5: Pass session context from TradingLoop**

In `src/trading-loop.ts`, when building the `llm.analyze()` call, add:

```typescript
const sessionPnlPct = startBalance > 0 ? (sessionPnl / startBalance) * 100 : 0;
const lossPct = Math.abs(Math.min(sessionPnlPct, 0));
const riskStatus = lossPct >= 10 ? 'critical' : lossPct >= 5 ? 'reduced' : 'normal';

const decisions = await llm.analyze({
  // ... existing fields ...
  sessionPnlPct,
  lastOrderResult: this.deps.memory.getLastOrderResult(),
  riskStatus,
});
```

**Step 6: Run tests**

```bash
npx vitest run tests/
```

Update mocks if needed (add `setLastOrderResult`, `getLastOrderResult` to memory mock).

**Step 7: Commit**

```bash
git add src/llm/prompts.ts src/trading-loop.ts src/memory/session.ts
git commit -m "feat: session state + order feedback — LLM sees P&L, risk status, last order result"
```

---

### Task 11: Fetch timeouts

**Files:**
- Modify: `src/news/macro-fetcher.ts`
- Modify: `src/news/cryptopanic.ts`
- Modify: `src/news/fear-greed.ts`

**Context:** External API calls can hang and block the trading cycle. Add timeouts.

**Step 1: Add timeout helper**

Create a shared helper. Add to the top of each file or in a utils file:

```typescript
function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}
```

**Step 2: Apply to macro-fetcher.ts**

Replace `fetch(...)` call in `fetch()` method (line 28) with:

```typescript
const response = await fetchWithTimeout(
  `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${this.apifyToken}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) },
  15000,
);
```

Replace `fetch(...)` in `fetchBTCDominance()` (line 61):

```typescript
const r = await fetchWithTimeout('https://api.coingecko.com/api/v3/global', {}, 10000);
```

**Step 3: Apply to cryptopanic.ts**

Replace `fetch(...)` call (line 12):

```typescript
const response = await fetchWithTimeout(url, { method: 'POST', ... }, 15000);
```

**Step 4: Apply to fear-greed.ts**

Replace `fetch(...)` call (line 7):

```typescript
const response = await fetchWithTimeout(FEAR_GREED_URL, {}, 5000);
```

**Step 5: Run tests**

```bash
npx vitest run tests/
```

**Step 6: Commit**

```bash
git add src/news/macro-fetcher.ts src/news/cryptopanic.ts src/news/fear-greed.ts
git commit -m "feat: fetch timeouts — 15s for Apify, 10s for CoinGecko, 5s for Fear&Greed"
```

---

### Task 12: Wire guardrails into TradingLoop + pass ValidationContext

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/index.ts`
- Modify: `tests/trading-loop.test.ts`

**Context:** Risk manager now accepts `ValidationContext` with indicators4h, fearGreed, fearGreedLeverageCap. TradingLoop needs to pass these when calling validate(). Also wire new config fields.

**Step 1: Update riskManager.validate() call in runOnce()**

Replace the `riskManager.validate(decision, portfolio)` call (line 192):

```typescript
const validationCtx = {
  indicators4h: indicators4h.size > 0 ? indicators4h as Map<string, { trend: string }> : undefined,
  fearGreed,
  fearGreedLeverageCap: this.deps.tradingConfig.fearGreedLeverageCap,
};
const validation = riskManager.validate(decision, portfolio, validationCtx);
```

**Step 2: Update TradingLoopDeps.tradingConfig**

Add new optional fields:

```typescript
tradingConfig: {
  targetReturnPct: number;
  minTakeProfitPct: number;
  maxLeverage: number;
  maxPositionPct: number;
  maxStopLossPct: number;
  stalePositionHours?: number;
  maxHoldHours?: number;
  minConfidence?: number;
  fearGreedLeverageCap?: number;
};
```

**Step 3: Pass minConfidence to RiskManager in index.ts**

In `src/index.ts`, update the riskManager constructor:

```typescript
const riskManager = new RiskManager({
  maxLeverage: config.trading.maxLeverage,
  maxPositionPct: config.trading.maxPositionPct,
  maxExposurePct: config.trading.maxExposurePct,
  maxStopLossPct: config.trading.maxStopLossPct,
  maxLossUsd: config.trading.maxLossUsd,
  maxLossPct: config.trading.maxLossPct,
  minConfidence: config.trading.minConfidence,  // NEW
});
```

Pass new config fields to TradingLoop:

```typescript
tradingConfig: {
  ...promptConfig,
  stalePositionHours: config.trading.stalePositionHours,
  maxHoldHours: config.trading.maxHoldHours,
  minConfidence: config.trading.minConfidence,
  fearGreedLeverageCap: config.trading.fearGreedLeverageCap,
},
```

Also pass new config fields to `buildSystemPrompt` in LLMClient constructor:

In `src/index.ts`, update `promptConfig`:

```typescript
const promptConfig = {
  targetReturnPct: config.trading.targetReturnPct,
  minTakeProfitPct: config.trading.minTakeProfitPct,
  maxLeverage: config.trading.maxLeverage,
  maxPositionPct: config.trading.maxPositionPct,
  maxStopLossPct: config.trading.maxStopLossPct,
  pairs: config.trading.pairs,              // NEW
  minConfidence: config.trading.minConfidence,        // NEW
  fearGreedLeverageCap: config.trading.fearGreedLeverageCap,  // NEW
};
```

**Step 4: Update tests**

In `tests/trading-loop.test.ts`, update `mockRisk.validate` to accept 3 args:

```typescript
mockRisk.validate = vi.fn().mockReturnValue({ approved: true });
```

(The mock already ignores extra args, but verify it still works.)

**Step 5: Run tests**

```bash
npx vitest run tests/
```

**Step 6: Commit**

```bash
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat: wire guardrails — pass indicators4h, fearGreed, config to risk manager"
```

---

### Task 13: Documentation — ARCHITECTURE.md

**Files:**
- Create: `docs/ARCHITECTURE.md`
- Modify: `CLAUDE.md`

**Step 1: Write ARCHITECTURE.md**

Create `docs/ARCHITECTURE.md` with:
- Project overview: what the bot does, trading philosophy
- Strategy: multi-timeframe confirmation, confluence-based entry, hard guardrails
- Architecture: component diagram (MarketData → Indicators → Prompts → LLM → RiskManager → Orders)
- Data flow per cycle
- Risk management philosophy (hybrid: soft prompt rules + hard code guardrails)
- Configuration reference
- Deployment (GCP VM, pm2)

**Step 2: Update CLAUDE.md**

Add references to new components: confidence scoring, hard guardrails, auto-exit, data narratives, session state feedback.

**Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md CLAUDE.md
git commit -m "docs: ARCHITECTURE.md — strategy, data flow, risk philosophy, component overview"
```

---

## Task Dependency Graph

```
Task 1 (sessionPnL fix) ─────────────────────┐
Task 2 (SL/TP fix) ──────────── independent   │
Task 3 (JSON regex) ──────────── independent   │
Task 4 (config) ──────────────── independent   │
Task 5 (confidence) ───── needs Task 4 ────────┤
Task 6 (guardrails) ──── needs Tasks 1, 5 ─────┤
Task 7 (auto-exit) ──── needs Tasks 1, 4 ──────┤
Task 8 (system prompt) ─ needs Task 5 ─────────┤
Task 9 (narratives) ──── independent ──────────┤
Task 10 (session state) ─ needs Tasks 1, 7 ────┤
Task 11 (timeouts) ────── independent ─────────┤
Task 12 (wire all) ────── needs Tasks 5-10 ────┘
Task 13 (docs) ────────── after all
```

**Parallelizable groups:**
- Group A (independent): Tasks 1, 2, 3, 4 — can run in parallel
- Group B (needs A): Tasks 5, 9, 11 — can run in parallel after A
- Group C (needs B): Tasks 6, 7, 8 — can run in parallel after B
- Group D (needs C): Tasks 10, 12 — can run in parallel after C
- Group E: Task 13 — after all

---

## Summary

| Task | What it builds | Files |
|------|---------------|-------|
| 1 | Real sessionPnL from Binance | trading-loop, memory/session |
| 2 | SL failure → cancel trade | orders |
| 3 | Smart JSON regex + retry | client |
| 4 | Config: minConfidence, staleHours, etc. | config |
| 5 | Confidence scoring in decisions | manager, client |
| 6 | Hard guardrails: 4h, F&G, loss scaling | manager |
| 7 | Position age auto-exit | trading-loop |
| 8 | Comprehensive system prompt | prompts |
| 9 | Data narratives in user prompt | prompts |
| 10 | Session state + order feedback | prompts, trading-loop, session |
| 11 | Fetch timeouts (15s/10s/5s) | macro-fetcher, cryptopanic, fear-greed |
| 12 | Wire guardrails into TradingLoop | trading-loop, index |
| 13 | ARCHITECTURE.md + CLAUDE.md update | docs |
