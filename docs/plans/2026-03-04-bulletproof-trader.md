# Bulletproof Trader — 3-Layer Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the bot resilient to LLM and Binance API failures via a 3-layer fallback system that protects open positions when the primary AI is unavailable.

**Architecture:** Layer 1 = Codex API (normal, full prompt). Layer 2 = OpenAI standard API fallback (`OPENAI_API_KEY_FALLBACK`, `gpt-4o-mini`, HOLD/CLOSE only, minimal prompt with soul.md External Insights as "Big Brother"). Layer 3 = Rule-based (no LLM at all — SL/TP on Binance + emergency auto-close if sessionPnl < -5%). Binance circuit breaker (3 consecutive all-fail cycles → skip cycle). `Promise.allSettled` for partial pair failures. LLMClient throws on API errors so TradingLoop can switch layers.

**Tech Stack:** TypeScript ESM, Vitest, standard `fetch` (no new npm deps).

---

## Task Dependency Graph

```
Task 1 (CircuitBreaker)  ──┐
Task 2 (FallbackLLMClient) │
Task 3 (Config)            ├─→ Task 5 (TradingLoop 3-layer)
Task 4 (LLMClient throw)   │       ↓
                            │   Task 6 (Wire index.ts)
                            │   Task 7 (CLAUDE.md)
```

**Group A (independent):** Tasks 1–4
**Group B (depends on A):** Tasks 5–7

---

## Task 1: CircuitBreaker utility class

**Files:**
- Create: `src/utils/circuit-breaker.ts`
- Create: `tests/utils/circuit-breaker.test.ts`

### Step 1: Write the failing test

```typescript
// tests/utils/circuit-breaker.test.ts
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const cb = new CircuitBreaker(3);
    expect(cb.isOpen()).toBe(false);
  });

  it('opens after N consecutive failures', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('resets to closed on recordSuccess()', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    cb.recordSuccess();
    expect(cb.isOpen()).toBe(false);
  });

  it('exposes failureCount', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure(); cb.recordFailure();
    expect(cb.failureCount).toBe(2);
  });

  it('uses default threshold of 3', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run tests/utils/circuit-breaker.test.ts`
Expected: FAIL — `Cannot find module`

### Step 3: Implement the class

```typescript
// src/utils/circuit-breaker.ts
export class CircuitBreaker {
  private failures = 0;

  constructor(private readonly threshold: number = 3) {}

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
  }

  isOpen(): boolean {
    return this.failures >= this.threshold;
  }

  get failureCount(): number {
    return this.failures;
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run tests/utils/circuit-breaker.test.ts`
Expected: PASS (5 tests)

### Step 5: Commit

```bash
git add src/utils/circuit-breaker.ts tests/utils/circuit-breaker.test.ts
git commit -m "feat: add CircuitBreaker utility for Binance API resilience"
```

---

## Task 2: FallbackLLMClient

**Files:**
- Create: `src/llm/fallback-client.ts`
- Create: `tests/llm/fallback-client.test.ts`

### Step 1: Write the failing tests

```typescript
// tests/llm/fallback-client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FallbackLLMClient } from '../../src/llm/fallback-client.js';
import type { Position } from '../../src/risk/manager.js';

const POSITIONS: Position[] = [
  { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -1.5, heldHours: 3.5 },
];

afterEach(() => vi.unstubAllGlobals());

function mockFetch(responseJson: object) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => responseJson,
  }));
}

function mockFetchFail(status: number) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => 'Error',
  }));
}

describe('FallbackLLMClient', () => {
  it('returns HOLD decision when LLM responds HOLD', async () => {
    mockFetch({
      choices: [{ message: { content: '{"decisions":[{"pair":"BTCUSDT","action":"HOLD","confidence":70,"reasoning":"SL protects"}]}' } }],
    });

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, -1.5);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('HOLD');
    expect(decisions[0].pair).toBe('BTCUSDT');
  });

  it('returns CLOSE decision', async () => {
    mockFetch({
      choices: [{ message: { content: '{"decisions":[{"pair":"BTCUSDT","action":"CLOSE","confidence":80,"reasoning":"exit now"}]}' } }],
    });

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, -3);

    expect(decisions[0].action).toBe('CLOSE');
  });

  it('filters out LONG and SHORT even if LLM returns them', async () => {
    mockFetch({
      choices: [{ message: { content: '{"decisions":[{"pair":"BTCUSDT","action":"LONG","confidence":75,"reasoning":"bullish"},{"pair":"ETHUSDT","action":"CLOSE","confidence":80,"reasoning":"exit"}]}' } }],
    });

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, 0);

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('CLOSE');
  });

  it('returns [] when no positions', async () => {
    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze([], 0);

    expect(decisions).toHaveLength(0);
  });

  it('returns [] on API error (does not throw)', async () => {
    mockFetchFail(429);

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    const decisions = await client.analyze(POSITIONS, -2);

    expect(decisions).toHaveLength(0);
  });

  it('throws on API error so TradingLoop can detect fallback exhaustion', async () => {
    mockFetchFail(429);

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini', true);
    await expect(client.analyze(POSITIONS, -2)).rejects.toThrow('429');
  });

  it('includes soul External Insights in prompt when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"decisions":[]}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const soulContent = `# Soul\n## External Insights\n- [2026-03-04] audit: Close ETH immediately\n## Other\nstuff`;
    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    await client.analyze(POSITIONS, -3, soulContent);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user').content;
    expect(userMsg).toContain('Close ETH immediately');
  });

  it('sends request to standard OpenAI API endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"decisions":[]}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FallbackLLMClient('sk-test', 'gpt-4o-mini');
    await client.analyze(POSITIONS, 0);

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBeLessThanOrEqual(500);
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run tests/llm/fallback-client.test.ts`
Expected: FAIL — `Cannot find module`

### Step 3: Implement FallbackLLMClient

```typescript
// src/llm/fallback-client.ts
import type { TradeDecision, Position } from '../risk/manager.js';

const FALLBACK_API_URL = 'https://api.openai.com/v1/chat/completions';

const SYSTEM_PROMPT = `You are an emergency position manager for a crypto futures bot. The primary AI is unavailable.
Your ONLY job: decide HOLD or CLOSE for each open position. Never suggest LONG or SHORT.
Be conservative — when in doubt, HOLD and let the exchange SL/TP handle it.
Respond ONLY with valid JSON, no explanation.`;

function extractExternalInsights(soulContent: string): string {
  const match = soulContent.match(/## External Insights\n([\s\S]*?)(?=\n## |$)/);
  return match?.[1]?.trim() ?? '';
}

export class FallbackLLMClient {
  /**
   * @param throwOnError - if true, throws on API error instead of returning [].
   *   Used so TradingLoop can detect that Layer 2 is also down and enter Layer 3.
   */
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'gpt-4o-mini',
    private readonly throwOnError: boolean = true,
  ) {}

  async analyze(
    positions: Position[],
    sessionPnlPct: number,
    soulContent?: string,
  ): Promise<TradeDecision[]> {
    if (positions.length === 0) return [];

    const insights = soulContent ? extractExternalInsights(soulContent) : '';

    let userPrompt = `EMERGENCY MODE — only HOLD or CLOSE decisions allowed.\n\n`;
    userPrompt += `Session P&L: ${sessionPnlPct >= 0 ? '+' : ''}${sessionPnlPct.toFixed(2)}%\n\n`;
    userPrompt += `Open positions:\n`;
    for (const p of positions) {
      const sign = p.unrealizedPnlPct >= 0 ? '+' : '';
      userPrompt += `- ${p.pair} ${p.side}: PnL ${sign}${p.unrealizedPnlPct.toFixed(2)}%, held ${p.heldHours.toFixed(1)}h, size $${p.sizeUsd.toFixed(0)}\n`;
    }
    if (insights) {
      userPrompt += `\nBig Brother instructions:\n${insights}\n`;
    }
    userPrompt += `\nRespond ONLY with JSON:\n{"decisions":[{"pair":"BTCUSDT","action":"HOLD","confidence":80,"reasoning":"brief reason"}]}`;

    try {
      const response = await fetch(FALLBACK_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 400,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Fallback API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = await response.json() as any;
      const content: string = data.choices?.[0]?.message?.content ?? '';

      const match = content.match(/\{[\s\S]*"decisions"[\s\S]*\}/);
      if (!match) return [];

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed.decisions)) return [];

      // Hard guard: ONLY HOLD and CLOSE allowed
      return (parsed.decisions as any[])
        .filter(d => d.action === 'HOLD' || d.action === 'CLOSE')
        .map(d => ({
          pair: d.pair,
          action: d.action,
          size_pct: 0,
          leverage: 0,
          stop_loss_pct: 0,
          take_profit_pct: 0,
          reasoning: d.reasoning ?? 'fallback mode',
          confidence: d.confidence,
        }));
    } catch (err) {
      console.error('[FallbackLLM] Error:', err);
      if (this.throwOnError) throw err;
      return [];
    }
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run tests/llm/fallback-client.test.ts`
Expected: PASS (8 tests)

### Step 5: Commit

```bash
git add src/llm/fallback-client.ts tests/llm/fallback-client.test.ts
git commit -m "feat: add FallbackLLMClient — standard OpenAI API, HOLD/CLOSE only"
```

---

## Task 3: Config — add fallback keys

**Files:**
- Modify: `src/config.ts`

No new test needed — config is verified by integration (TradingLoop + index.ts tests).

### Step 1: Update Config interface and loadConfig()

In `src/config.ts`, replace the `openai` block in the `Config` interface:

```typescript
// OLD:
openai: {
  apiKey: string;
  model: string;
};

// NEW:
openai: {
  apiKey: string;
  apiKeyFallback: string | undefined;
  model: string;
  fallbackModel: string;
};
```

In `loadConfig()`, replace the `openai` block:

```typescript
// OLD:
openai: {
  apiKey: process.env.OPENAI_API_KEY || 'oauth',
  model: process.env.OPENAI_MODEL || 'gpt-4o',
},

// NEW:
openai: {
  apiKey: process.env.OPENAI_API_KEY || 'oauth',
  apiKeyFallback: process.env.OPENAI_API_KEY_FALLBACK,
  model: process.env.OPENAI_MODEL || 'gpt-4o',
  fallbackModel: process.env.FALLBACK_MODEL || 'gpt-4o-mini',
},
```

### Step 2: Run full suite to verify no breakage

Run: `npx vitest run`
Expected: All existing tests PASS (config change is additive).

### Step 3: Commit

```bash
git add src/config.ts
git commit -m "feat: add OPENAI_API_KEY_FALLBACK and FALLBACK_MODEL to config"
```

---

## Task 4: LLMClient — throw on API errors

Currently `LLMClient.analyze()` catches all errors internally and returns `[]`. This prevents TradingLoop from knowing that Codex is down. We need it to throw on API errors (not parse errors) so TradingLoop can switch to Layer 2.

**Parse errors** (malformed JSON response) return `[]` — keep as-is (HOLD all = safe).
**API errors** (401, 429, 5xx, network) — now throw so TradingLoop can escalate.

**Files:**
- Modify: `src/llm/client.ts` (lines 116–120)
- Modify: `tests/llm/client.test.ts`

### Step 1: Write the new test

Add to `tests/llm/client.test.ts` after the last `it(...)`:

```typescript
  it('throws on API error so TradingLoop can switch layers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
      body: undefined,
    }));

    await expect(llm.analyze(makePromptData())).rejects.toThrow('401');
  });
```

### Step 2: Run to verify it fails

Run: `npx vitest run tests/llm/client.test.ts`
Expected: FAIL — the new test expects a throw but `analyze()` returns `[]`

### Step 3: Change outer catch in analyze() to throw

In `src/llm/client.ts`, find the outer catch block (currently around lines 116–120):

```typescript
// OLD (lines ~116-120):
    } catch (err: any) {
      console.error('[LLM] API error:', err);
      this.emergencyAlert(err);
      return [];
    }

// NEW:
    } catch (err: any) {
      console.error('[LLM] API error:', err);
      this.emergencyAlert(err);
      throw err;  // Let TradingLoop switch to Layer 2/3
    }
```

### Step 4: Run tests to verify

Run: `npx vitest run tests/llm/client.test.ts`
Expected: All 7 tests PASS (parse error test still returns `[]` — it goes through parseResponse, not outer catch).

### Step 5: Commit

```bash
git add src/llm/client.ts tests/llm/client.test.ts
git commit -m "feat: LLMClient.analyze() throws on API errors for layer switching"
```

---

## Task 5: TradingLoop — 3-layer state machine + Promise.allSettled

This is the core integration. Changes to `src/trading-loop.ts`:

1. Add `binanceCircuitBreaker` class field
2. Add `fallbackLlm?` and `getSoulContent?` to `TradingLoopDeps`
3. `Promise.all` → `Promise.allSettled` for snapshots
4. LLM call wrapped in try/catch with Layer 1→2→3 fallback
5. Layer 3 emergency close on significant loss
6. Filter LONG/SHORT in Layer 2/3

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `tests/trading-loop.test.ts`

### Step 1: Write failing tests

Add these tests to `tests/trading-loop.test.ts` (before the closing `}`):

```typescript
  // ── Resilience tests ──────────────────────────────────────────────────

  it('uses fallbackLlm when Layer 1 (Codex) throws', async () => {
    const mockFallbackLlm = {
      analyze: vi.fn().mockResolvedValue([
        { pair: 'BTCUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'fallback' },
      ]),
    };
    mockLlm.analyze.mockRejectedValue(new Error('Codex 503'));

    const loopWithFallback = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      fallbackLlm: mockFallbackLlm as any,
    });

    await loopWithFallback.runOnce();

    expect(mockFallbackLlm.analyze).toHaveBeenCalled();
    expect(mockLogger.logError).toHaveBeenCalledWith('LLM_LAYER1_FAILED', expect.any(String));
  });

  it('enters Layer 3 (rule-based) when both Layer 1 and Layer 2 fail', async () => {
    const mockFallbackLlm = {
      analyze: vi.fn().mockRejectedValue(new Error('Fallback 429')),
    };
    mockLlm.analyze.mockRejectedValue(new Error('Codex 503'));

    const loopWithFallback = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      fallbackLlm: mockFallbackLlm as any,
    });

    await loopWithFallback.runOnce();

    expect(mockLogger.logError).toHaveBeenCalledWith('LLM_LAYER1_FAILED', expect.any(String));
    expect(mockLogger.logError).toHaveBeenCalledWith('LLM_LAYER2_FAILED', expect.any(String));
    // No positions with significant loss → no emergency close
    expect(mockOrders.close).not.toHaveBeenCalled();
  });

  it('Layer 3: auto-closes all positions on significant loss (-5%)', async () => {
    mockLlm.analyze.mockRejectedValue(new Error('Codex down'));
    mockMarketData.getPortfolioState.mockResolvedValue({
      balanceUsd: 100,
      sessionPnl: -6,
      positions: [
        { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 100, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -6, heldHours: 2 },
      ],
    });
    mockMarketData.getSnapshot.mockResolvedValue({
      pair: 'BTCUSDT', candles1h: [], candles4h: [], candles15m: [],
      fundingRate: '0.0001', fundingHistory: [],
      openInterest: '80000', markPrice: '65800',
      longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
    });
    // startBalance = 100 → sessionPnlPct = (94 - 100)/100 * 100 = -6%
    loop['deps'].memory.getStartBalance = vi.fn().mockReturnValue(100);

    const loopL3 = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      // No fallbackLlm → straight to Layer 3
    });

    await loopL3.runOnce();

    expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');
    expect(mockLogger.logTrade).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EMERGENCY_CLOSE', pair: 'BTCUSDT' }),
    );
  });

  it('Layer 2: filters out LONG and SHORT decisions', async () => {
    const mockFallbackLlm = {
      analyze: vi.fn().mockResolvedValue([
        { pair: 'BTCUSDT', action: 'LONG', size_pct: 20, leverage: 5, stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'rogue' },
        { pair: 'ETHUSDT', action: 'HOLD', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'wait' },
      ]),
    };
    mockLlm.analyze.mockRejectedValue(new Error('Codex down'));

    const loopL2 = new TradingLoop({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
      fallbackLlm: mockFallbackLlm as any,
    });

    await loopL2.runOnce();

    // LONG was filtered → execute not called
    expect(mockOrders.execute).not.toHaveBeenCalled();
  });

  it('skips cycle when Binance circuit breaker is open', async () => {
    // Force all snapshots to fail 3 times
    mockMarketData.getSnapshot.mockRejectedValue(new Error('Binance down'));

    for (let i = 0; i < 3; i++) {
      await loop.runOnce();
    }

    // 4th cycle: circuit breaker open → skipped, no LLM call
    mockLlm.analyze.mockClear();
    await loop.runOnce();

    expect(mockLlm.analyze).not.toHaveBeenCalled();
    expect(mockLogger.logError).toHaveBeenCalledWith(
      'CIRCUIT_BREAKER_OPEN',
      expect.any(String),
    );
  });

  it('continues with partial pairs when some snapshots fail', async () => {
    // BTCUSDT fails, ETHUSDT succeeds — with allSettled, ETH continues
    let callCount = 0;
    mockMarketData.getSnapshot = vi.fn().mockImplementation((pair: string) => {
      if (pair === 'BTCUSDT') return Promise.reject(new Error('BTC timeout'));
      return Promise.resolve({
        pair: 'ETHUSDT', candles1h: [], candles4h: [], candles15m: [],
        fundingRate: '0.0001', fundingHistory: [],
        openInterest: '80000', markPrice: '3000',
        longShortRatio: null, orderBookBidPct: 50, orderBookAskPct: 50,
      });
    });

    const loopMulti = new TradingLoop({
      pairs: ['BTCUSDT', 'ETHUSDT'],
      marketData: mockMarketData,
      llm: mockLlm,
      orders: mockOrders,
      riskManager: mockRisk,
      signalBuffer: mockSignalBuffer,
      logger: mockLogger,
      memory: loop['deps'].memory,
      newsCache: loop['deps'].newsCache,
      newsAnalyst: loop['deps'].newsAnalyst,
      newsConfig: { refreshIntervalH: 12, maxItems: 100 },
      churnCooldownMs: 900000,
      tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    });

    await loopMulti.runOnce();

    // LLM called with 1 snapshot (ETHUSDT only)
    const callArg = mockLlm.analyze.mock.calls[0][0];
    expect(callArg.snapshots).toHaveLength(1);
    expect(callArg.snapshots[0].pair).toBe('ETHUSDT');
  });
```

### Step 2: Run to verify tests fail

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: FAIL — new tests fail (Layer 1 doesn't throw, no fallbackLlm dep, etc.)

### Step 3: Implement the changes in `src/trading-loop.ts`

**3a. Add import and helper function** at the top of the file, after existing imports:

```typescript
import { CircuitBreaker } from './utils/circuit-breaker.js';

function extractExternalInsights(soulContent: string): string {
  const match = soulContent.match(/## External Insights\n([\s\S]*?)(?=\n## |$)/);
  return match?.[1]?.trim() ?? '';
}
```

**3b. Add to `TradingLoopDeps` interface** (after `macroRefreshIntervalMs` line):

```typescript
  fallbackLlm?: import('./llm/fallback-client.js').FallbackLLMClient;
  getSoulContent?: () => string | undefined;
```

**3c. Add class field** to `TradingLoop` class (after `lastMacroAnalysis` line):

```typescript
  private binanceCircuitBreaker = new CircuitBreaker(3);
```

**3d. Replace lines 67–76** (start of `runOnce()`, the `try {` and `Promise.all` block):

```typescript
  async runOnce(): Promise<void> {
    if (this._shutdown) return;

    const { pairs, marketData, llm, orders, riskManager, signalBuffer, logger } = this.deps;

    // Circuit breaker: skip cycle if Binance has been failing consecutively
    if (this.binanceCircuitBreaker.isOpen()) {
      console.log(`[Loop] Binance circuit breaker open (${this.binanceCircuitBreaker.failureCount} consecutive failures) — skipping cycle`);
      logger.logError('CIRCUIT_BREAKER_OPEN', `Skipping cycle — ${this.binanceCircuitBreaker.failureCount} consecutive Binance failures`);
      return;
    }

    try {
      // 1. Fetch market data — use allSettled so one pair failure doesn't kill the cycle
      const settled = await Promise.allSettled(
        pairs.map((pair) => marketData.getSnapshot(pair)),
      );
      const rawSnapshots: MarketSnapshot[] = settled
        .filter((r): r is PromiseFulfilledResult<MarketSnapshot> => r.status === 'fulfilled')
        .map((r) => r.value);

      if (rawSnapshots.length === 0) {
        this.binanceCircuitBreaker.recordFailure();
        logger.logError('MARKET_DATA_FAILED', `All ${pairs.length} pair snapshots failed`);
        return;
      }
      this.binanceCircuitBreaker.recordSuccess();
```

**3e. Replace lines 191–207** (the LLM analyze call):

```typescript
      // 6. LLM analysis — 3-layer fallback
      const memState = this.deps.memory.load();
      const recentNewsWithAge = this.deps.newsCache.getRecentItems(48);
      const sessionPnlPct = startBalance > 0 ? (sessionPnl / startBalance) * 100 : 0;
      const lossPct = Math.abs(Math.min(sessionPnlPct, 0));
      const riskStatus = lossPct >= 10 ? 'critical' : lossPct >= 5 ? 'reduced' : 'normal';
      const promptData = {
        snapshots,
        indicators,
        indicators4h,
        portfolio,
        signals,
        news: [],
        fearGreed,
        sessionNotes: memState.session_notes || undefined,
        recentTrades: memState.recent_trades.slice(0, 5),
        newsAnalysis,
        recentNewsWithAge,
        macroAnalysis: this.lastMacroAnalysis,
        sessionPnlPct,
        lastOrderResult: this.deps.memory.getLastOrderResult(),
        riskStatus,
      };

      let decisions: import('./risk/manager.js').TradeDecision[] = [];
      let currentLayer: 1 | 2 | 3 = 1;

      try {
        decisions = await llm.analyze(promptData);
      } catch (llmErr: any) {
        console.error('[Loop] Layer 1 (Codex API) failed:', llmErr?.message);
        logger.logError('LLM_LAYER1_FAILED', llmErr?.message ?? 'unknown');

        if (this.deps.fallbackLlm) {
          try {
            const soulContent = this.deps.getSoulContent?.();
            decisions = await this.deps.fallbackLlm.analyze(
              portfolio.positions,
              sessionPnlPct,
              soulContent,
            );
            currentLayer = 2;
            console.log('[Loop] Layer 2 (Fallback LLM) active — HOLD/CLOSE only');
          } catch (fallbackErr: any) {
            console.error('[Loop] Layer 2 (Fallback LLM) failed:', fallbackErr?.message);
            logger.logError('LLM_LAYER2_FAILED', fallbackErr?.message ?? 'unknown');
            currentLayer = 3;
          }
        } else {
          currentLayer = 3;
          console.log('[Loop] Layer 3 (rule-based) — no fallback LLM configured');
        }
      }

      // Layer 3: if significant loss and positions open — read Big Brother + emergency close
      if (currentLayer === 3 && portfolio.positions.length > 0 && sessionPnlPct < -5) {
        const soulContent = this.deps.getSoulContent?.();
        if (soulContent) {
          const insights = extractExternalInsights(soulContent);
          if (insights) {
            console.log('[Loop] Layer 3 — Big Brother instructions:\n' + insights);
          }
        }
        console.error(`[Loop] Layer 3: Loss ${sessionPnlPct.toFixed(1)}% + no LLM — closing all positions`);
        for (const pos of portfolio.positions) {
          const result = await orders.close(pos.pair, pos.side);
          if (result.success) {
            logger.logTrade({ type: 'EMERGENCY_CLOSE', pair: pos.pair, layer: 3, sessionPnlPct });
          }
        }
        logger.logPerformance({ balance: portfolio.balanceUsd, openPositions: 0, sessionPnl, cycleCount: this.cycleCount });
        this.cycleCount++;
        return;
      }

      // Safety guard: in Layer 2/3, filter out any LONG/SHORT decisions
      if (currentLayer >= 2) {
        decisions = decisions.filter(d => d.action === 'HOLD' || d.action === 'CLOSE');
      }
```

### Step 4: Run tests to verify they pass

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: All PASS (existing + 6 new tests)

### Step 5: Run full suite

Run: `npx vitest run`
Expected: All PASS

### Step 6: Commit

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat: TradingLoop 3-layer resilience — fallback LLM + rule-based + Binance circuit breaker"
```

---

## Task 6: Wire FallbackLLMClient in index.ts

**Files:**
- Modify: `src/index.ts`

### Step 1: Add import and initialization

In `src/index.ts`, add import after the `LLMClient` import line:

```typescript
import { FallbackLLMClient } from './llm/fallback-client.js';
```

After the `const llm = new LLMClient(...)` line (currently ~line 67), add:

```typescript
  const fallbackLlm = config.openai.apiKeyFallback
    ? new FallbackLLMClient(config.openai.apiKeyFallback, config.openai.fallbackModel)
    : undefined;
  if (fallbackLlm) {
    console.log(`[Fallback] Layer 2 enabled — ${config.openai.fallbackModel} (OPENAI_API_KEY_FALLBACK)`);
  } else {
    console.log('[Fallback] No OPENAI_API_KEY_FALLBACK — Layer 3 (rule-based) on Codex failure');
  }
```

In the `TradingLoop` constructor call (currently ~line 103), add before the closing `}`):

```typescript
    fallbackLlm,
```

### Step 2: Run all tests

Run: `npx vitest run`
Expected: All PASS

### Step 3: Verify build compiles

Run: `npm run build`
Expected: No TypeScript errors

### Step 4: Commit

```bash
git add src/index.ts
git commit -m "feat: wire FallbackLLMClient into index.ts"
```

---

## Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

### Step 1: Add soul:insight command to Commands section

After the `npm run audit:bot` line, add:

```bash
npm run soul:insight "text" # inject external insight into soul.md (Big Brother)
```

### Step 2: Add fallback mode to Architecture section

After the `**LLM flow**` block, add:

```markdown
**LLM resilience — 3 layers** (`src/llm/`):
- Layer 1: Codex API (OAuth/JWT, `chatgpt.com/backend-api/codex/responses`) — full prompt
- Layer 2: `fallback-client.ts` — standard OpenAI `/v1/chat/completions` via `OPENAI_API_KEY_FALLBACK`; minimal prompt (positions + PnL + soul.md External Insights); HOLD/CLOSE only; `gpt-4o-mini`
- Layer 3: Rule-based — no LLM; SL/TP on Binance; if `sessionPnlPct < -5%` → close all positions + log Big Brother (soul.md External Insights)
- `CircuitBreaker` (`src/utils/circuit-breaker.ts`) — 3 consecutive all-fail Binance cycles → skip cycle
```

### Step 3: Add to Key Gotchas

Add to the Key Gotchas section:

```markdown
- **LLM layer switching** — `LLMClient.analyze()` throws on API errors (not parse errors). TradingLoop catches this and falls to Layer 2 or 3. Parse errors (bad JSON) still return `[]` (HOLD all positions).
- **`Promise.allSettled`** for market snapshots — one pair failing won't kill the whole cycle. All-fail triggers circuit breaker.
- **Big Brother** — `soul.md` External Insights section is the "Big Brother" message. Injected into Layer 2 prompt and logged in Layer 3 emergency close.
```

### Step 4: Update Planned section — remove bullet once completed

Remove the `max-info-fetch` and `soul system` lines from Planned as they get completed via parallel plans.

### Step 5: Commit

```bash
git add CLAUDE.md
git commit -m "docs: document 3-layer LLM resilience, circuit breaker, Big Brother"
```

---

## Final Verification

```bash
npx vitest run
npm run build
```

Both should succeed with no errors.

---

## Summary

| Task | Files | New Tests |
|------|-------|-----------|
| 1: CircuitBreaker | `src/utils/circuit-breaker.ts` | 5 |
| 2: FallbackLLMClient | `src/llm/fallback-client.ts` | 8 |
| 3: Config | `src/config.ts` | 0 |
| 4: LLMClient throws | `src/llm/client.ts` | 1 |
| 5: TradingLoop 3-layer | `src/trading-loop.ts` | 6 |
| 6: Wire index.ts | `src/index.ts` | 0 |
| 7: CLAUDE.md | `CLAUDE.md` | 0 |

**Total: 7 tasks, 20 new tests, 3 new files, 5 modified files**

### What's protected

| Failure scenario | Response |
|---|---|
| Codex API 401/429/503/timeout | → Layer 2 (Fallback LLM, $10 key) |
| `OPENAI_API_KEY_FALLBACK` not set | → Layer 3 immediately |
| Fallback key 429 / depleted | → Layer 3 |
| Layer 3 + positions + loss > 5% | → Close all + log Big Brother |
| One pair Binance timeout | → Continue with other pairs |
| All pairs Binance fail (3x) | → Skip cycle, circuit breaker open |
