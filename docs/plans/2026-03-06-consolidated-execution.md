# Tiered Intelligence v2 — Consolidated Execution Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Execute remaining 16 issues (#2-#9, #11, #13-#19) — from 0.8% to 10%+ trade conversion.

**Architecture:** Issues reorganized into 7 rounds ordered by file-conflict avoidance. Shared files (`index.ts`, `trading-loop.ts`) batched together. Each round commits independently and runs full test suite.

**Tech Stack:** TypeScript ESM (`.js` imports), Vitest, Binance Futures, xAI Grok, OpenAI Embeddings, Supabase PostgreSQL

---

## Pre-flight Checks

- **Branch:** `feat/max-info-fetch`
- **Baseline:** 269/269 tests pass (40 files)
- **Completed:** #10 (price rounding), #12 (circuit breaker)
- **Key rules:**
  - ESM `.js` extension on ALL imports
  - `import { describe, it, expect, vi } from 'vitest'`
  - Binance: `submitNewAlgoOrder` with `triggerPrice` (NOT `submitNewOrder` with `stopPrice`)
  - `OrderExecutor` constructor: `(client, stepDecimals?, priceDecimals?)` — 3rd param from #10
  - `CircuitBreaker` constructor: `(threshold?, cooldownMs?)` — 2nd param from #12
  - **NEVER read `.env` files**
  - All DB writes are fire-and-forget: `.catch(() => {})`

---

## Round 1: Grok Wiring — #11 (5 tasks)

**Problem:** xAI dashboard shows $0 usage. `GrokClient` silently returns `''` on empty key (no log). `FlashCrashScanner` swallows all errors. `SwarmAgent` narrative_expert failures not tracked. `index.ts` uses `process.env.XAI_API_KEY` directly instead of `config.xaiApiKey`.

### Task 1: GrokClient healthCheck + logging

**Files:**
- Modify: `src/llm/grok-client.ts`
- Modify: `tests/llm/grok-client.test.ts`

**Step 1: Write failing tests**

Append to `tests/llm/grok-client.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GrokClient } from '../../src/llm/grok-client.js';

describe('GrokClient', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('calls xAI API correctly', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'Test response' } }] })
        });
        const client = new GrokClient('fake-key');
        const res = await client.call('Sys', 'User', 'grok-4-1-fast-reasoning');
        expect(res).toBe('Test response');
        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.x.ai/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('grok-4-1-fast-reasoning')
            })
        );
    });

    it('healthCheck returns ok:true on valid key', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ choices: [{ message: { content: 'hi' } }] }),
        });
        const client = new GrokClient('valid-key');
        const result = await client.healthCheck();
        expect(result).toEqual({ ok: true });
        const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
        expect(body.max_tokens).toBe(1);
    });

    it('healthCheck returns ok:false on API error', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false, status: 401, statusText: 'Unauthorized',
        });
        const client = new GrokClient('bad-key');
        const result = await client.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('401');
    });

    it('healthCheck returns ok:false when no key', async () => {
        const client = new GrokClient('');
        const result = await client.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('API key');
    });

    it('healthCheck returns ok:false on network error', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
        const client = new GrokClient('valid-key');
        const result = await client.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('fetch failed');
    });

    it('call() logs warning once when key is empty', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const client = new GrokClient('');
        await client.call('Sys', 'User');
        await client.call('Sys', 'User');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok]'));
        warnSpy.mockRestore();
    });
});
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/llm/grok-client.test.ts`
Expected: 4 new tests FAIL (`healthCheck` not found, `call()` doesn't warn)

**Step 3: Implement**

Replace entire `src/llm/grok-client.ts`:

```typescript
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

export interface GrokHealthResult {
  ok: boolean;
  error?: string;
}

export class GrokClient {
    private emptyKeyWarned = false;

    constructor(private apiKey: string) { }

    async healthCheck(): Promise<GrokHealthResult> {
        if (!this.apiKey) return { ok: false, error: 'No xAI API key configured' };
        try {
            const res = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({
                    model: 'grok-4-1-fast-non-reasoning',
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                }),
            }, 10000);
            if (!res.ok) return { ok: false, error: `xAI API ${res.status}: ${res.statusText}` };
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: err?.message ?? 'unknown error' };
        }
    }

    async call(systemPrompt: string, userPrompt: string, model: string = 'grok-4-1-fast-reasoning'): Promise<string> {
        if (!this.apiKey) {
            if (!this.emptyKeyWarned) {
                console.warn('[Grok] No API key — all Grok calls will be skipped');
                this.emptyKeyWarned = true;
            }
            return '';
        }
        const res = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.1
            })
        }, 15000);

        if (!res.ok) throw new Error(`xAI Error: ${res.status} ${res.statusText}`);
        const data = await res.json() as any;
        return data.choices?.[0]?.message?.content ?? '';
    }
}
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/llm/grok-client.test.ts`
Expected: 6/6 PASS

**Step 5: Commit**

```bash
git add src/llm/grok-client.ts tests/llm/grok-client.test.ts
git commit -m "feat(grok): add healthCheck + log on empty key

Closes part of #11"
```

---

### Task 2: FlashCrashScanner — log errors, track health

**Files:**
- Modify: `src/news/flash-crash.ts`
- Modify: `tests/news/flash-crash.test.ts`

**Step 1: Write failing tests**

Replace `tests/news/flash-crash.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { FlashCrashScanner } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
    it('detects panic using non-reasoning model', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();
        expect(res).toBe('PANIC');
        expect(mockGrok.call).toHaveBeenCalledWith(
            expect.any(String), expect.any(String), 'grok-4-1-fast-non-reasoning'
        );
    });

    it('returns IGNORE when grokClient is null', async () => {
        const scanner = new FlashCrashScanner(null);
        expect(await scanner.scan()).toBe('IGNORE');
    });

    it('logs error instead of swallowing', async () => {
        const mockGrok = {
            call: vi.fn().mockRejectedValue(new Error('xAI Error: 401 Unauthorized')),
        } as any;
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const scanner = new FlashCrashScanner(mockGrok);
        const res = await scanner.scan();
        expect(res).toBe('IGNORE');
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('[FlashCrash]'),
            expect.stringContaining('401'),
        );
        warnSpy.mockRestore();
    });

    it('records success in sourceHealth', async () => {
        const mockGrok = { call: vi.fn().mockResolvedValue('IGNORE') } as any;
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const scanner = new FlashCrashScanner(mockGrok, mockHealth as any);
        await scanner.scan();
        expect(mockHealth.recordSuccess).toHaveBeenCalledWith('grok-flash-crash');
    });

    it('records failure in sourceHealth', async () => {
        const mockGrok = { call: vi.fn().mockRejectedValue(new Error('timeout')) } as any;
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const scanner = new FlashCrashScanner(mockGrok, mockHealth as any);
        await scanner.scan();
        expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-flash-crash', 'timeout');
    });
});
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/news/flash-crash.test.ts`
Expected: 3 new tests FAIL (constructor doesn't accept sourceHealth, no logging)

**Step 3: Implement**

Replace `src/news/flash-crash.ts`:

```typescript
import type { SourceHealthMonitor } from './source-health.js';

export class FlashCrashScanner {
    constructor(private grokClient: any, private sourceHealth?: SourceHealthMonitor) { }

    async scan(): Promise<'PANIC' | 'IGNORE'> {
        if (!this.grokClient) return 'IGNORE';

        const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".`;

        try {
            const raw = await this.grokClient.call(sys, 'Scan crypto X now.', 'grok-4-1-fast-non-reasoning');
            this.sourceHealth?.recordSuccess('grok-flash-crash');
            if (raw.trim().toUpperCase().includes('PANIC')) return 'PANIC';
        } catch (e: any) {
            const msg = e?.message ?? 'unknown';
            console.warn(`[FlashCrash] Grok scan failed: ${msg}`);
            this.sourceHealth?.recordFailure('grok-flash-crash', msg);
        }

        return 'IGNORE';
    }
}
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/news/flash-crash.test.ts`
Expected: 5/5 PASS

**Step 5: Commit**

```bash
git add src/news/flash-crash.ts tests/news/flash-crash.test.ts
git commit -m "fix(flash-crash): log errors, track in sourceHealth

Closes part of #11"
```

---

### Task 3: GrokGrounder — sourceHealth tracking

**Files:**
- Modify: `src/news/grok-grounder.ts`
- Modify: `tests/news/grok-grounder.test.ts`

**Step 1: Write failing tests**

Append to existing tests in `tests/news/grok-grounder.test.ts`:

```typescript
    it('records success in sourceHealth on verify', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '{"verified": true, "confidence": 0.9, "summary": "confirmed"}' } }],
                usage: { total_tokens: 100 },
            }),
        } as any);
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const g = new GrokGrounder('key', mockHealth as any);
        await g.verify('test claim');
        expect(mockHealth.recordSuccess).toHaveBeenCalledWith('grok-grounder');
    });

    it('records failure in sourceHealth on API error', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false, status: 500,
            text: async () => 'Internal Server Error',
        } as any);
        const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
        const g = new GrokGrounder('key', mockHealth as any);
        await g.verify('test claim');
        expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-grounder', expect.stringContaining('500'));
    });
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/news/grok-grounder.test.ts`
Expected: 2 new tests FAIL (constructor doesn't accept 2nd param)

**Step 3: Implement**

In `src/news/grok-grounder.ts`, change constructor (line 36) and add tracking in verify():

```typescript
// Line 36: add optional sourceHealth
export class GrokGrounder {
  constructor(private xaiApiKey: string, private sourceHealth?: any) { }
```

Inside `verify()`, after the successful parse block (after line 82, before the return):

```typescript
      this.sourceHealth?.recordSuccess('grok-grounder');
```

In the `if (!response.ok)` block (after line 62, replace throw):

```typescript
        this.sourceHealth?.recordFailure('grok-grounder', `xAI API ${response.status}: ${errText.slice(0, 200)}`);
        throw new Error(`xAI API ${response.status}: ${errText.slice(0, 200)}`);
```

In the catch block (line 84-88), add before return:

```typescript
      this.sourceHealth?.recordFailure('grok-grounder', err?.message ?? 'unknown');
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/news/grok-grounder.test.ts`
Expected: 6/6 PASS

**Step 5: Commit**

```bash
git add src/news/grok-grounder.ts tests/news/grok-grounder.test.ts
git commit -m "feat(grok-grounder): track success/failure in sourceHealth

Closes part of #11"
```

---

### Task 4: SwarmAgent — sourceHealth for narrative_expert

**Files:**
- Modify: `src/llm/swarm-agent.ts:185,216-230`
- Modify: `tests/llm/swarm-agent.test.ts`

**Step 1: Write failing test**

Append to `tests/llm/swarm-agent.test.ts`:

```typescript
  it('tracks narrative_expert failure in sourceHealth', async () => {
    const mockGrokLlm = {
      call: vi.fn().mockRejectedValue(new Error('xAI Error: 401')),
    } as any;
    const mockSourceHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) return Promise.resolve(makeStructuredResponse('test', 'HOLD', 50));
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    await swarm.getConsensus(makeMinimalPromptData());

    expect(mockSourceHealth.recordFailure).toHaveBeenCalledWith(
      'grok-narrative', expect.stringContaining('401'),
    );
  });

  it('tracks narrative_expert success in sourceHealth', async () => {
    const mockGrokLlm = {
      call: vi.fn().mockResolvedValue(makeStructuredResponse('narrative_expert', 'HOLD', 50)),
    } as any;
    const mockSourceHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 5) return Promise.resolve(makeStructuredResponse('test', 'HOLD', 50));
        return Promise.resolve(consensusResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    await swarm.getConsensus(makeMinimalPromptData());

    expect(mockSourceHealth.recordSuccess).toHaveBeenCalledWith('grok-narrative');
  });
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: 2 new tests FAIL (constructor doesn't accept 3rd param)

**Step 3: Implement**

In `src/llm/swarm-agent.ts`:

Line 185 — add `sourceHealth` param:
```typescript
  constructor(private llm: LLMClient, private grokLlm?: any, private sourceHealth?: any) { }
```

In the results loop (line 216-230), update the fulfilled/rejected handling:

After `expertOutputs.push(parseExpertOutput(res.value, personas[i]));` (line 220), add:
```typescript
        if (personas[i] === 'narrative_expert') this.sourceHealth?.recordSuccess('grok-narrative');
```

In the else branch (rejected), after the existing `console.warn` (which should be around line 232), add:
```typescript
        if (personas[i] === 'narrative_expert') this.sourceHealth?.recordFailure('grok-narrative', res.reason?.message ?? String(res.reason));
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/llm/swarm-agent.test.ts`
Expected: all PASS

**Step 5: Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): track narrative_expert in sourceHealth

Closes part of #11"
```

---

### Task 5: Wire config.xaiApiKey + healthCheck in index.ts

**Files:**
- Create: `src/utils/grok-startup.ts`
- Create: `tests/grok-startup.test.ts`
- Modify: `src/index.ts:182,192-200`

**Step 1: Write failing test**

Create `tests/grok-startup.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runGrokHealthCheck } from '../src/utils/grok-startup.js';

describe('runGrokHealthCheck', () => {
  it('logs success when healthCheck passes', async () => {
    const mockClient = { healthCheck: vi.fn().mockResolvedValue({ ok: true }) };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runGrokHealthCheck(mockClient as any);
    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check PASSED'));
    logSpy.mockRestore();
  });

  it('logs error when healthCheck fails', async () => {
    const mockClient = { healthCheck: vi.fn().mockResolvedValue({ ok: false, error: '401 Unauthorized' }) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runGrokHealthCheck(mockClient as any);
    expect(result).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check FAILED'), expect.stringContaining('401'));
    errSpy.mockRestore();
  });

  it('logs error when healthCheck throws', async () => {
    const mockClient = { healthCheck: vi.fn().mockRejectedValue(new Error('network down')) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runGrokHealthCheck(mockClient as any);
    expect(result).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check FAILED'), expect.stringContaining('network down'));
    errSpy.mockRestore();
  });
});
```

**Step 2: Verify test fails**

Run: `npx vitest run tests/grok-startup.test.ts`
Expected: FAIL — module not found

**Step 3: Implement grok-startup.ts**

Create `src/utils/grok-startup.ts`:

```typescript
import type { GrokClient } from '../llm/grok-client.js';

export async function runGrokHealthCheck(client: GrokClient): Promise<boolean> {
  try {
    const result = await client.healthCheck();
    if (result.ok) {
      console.log('[Grok] Health check PASSED — xAI API key is valid');
      return true;
    }
    console.error('[Grok] Health check FAILED', result.error ?? 'unknown');
    return false;
  } catch (err: any) {
    console.error('[Grok] Health check FAILED', err?.message ?? 'unknown');
    return false;
  }
}
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/grok-startup.test.ts`
Expected: 3/3 PASS

**Step 5: Wire in index.ts**

In `src/index.ts`, make these changes:

Add import at top:
```typescript
import { runGrokHealthCheck } from './utils/grok-startup.js';
```

Replace lines 182-200 (Grok setup section) with:

```typescript
  // Grok setup — use config.xaiApiKey instead of raw process.env
  const grokGrounder = config.xaiApiKey ? new GrokGrounder(config.xaiApiKey, sourceHealth) : undefined;
  if (grokGrounder) console.log('[Grok] xAI Grounder enabled for claim verification');
  else console.log('[Grok] No XAI_API_KEY — claim verification disabled');

  // ... webhook server block stays as-is (lines 186-190) ...

  const grokClient = config.xaiApiKey ? new GrokClient(config.xaiApiKey) : undefined;

  // Startup health check
  if (grokClient) {
    const healthy = await runGrokHealthCheck(grokClient);
    if (!healthy) console.error('[Grok] WARNING: xAI API key invalid — Grok features will fail');
  }

  const enableSwarm = process.env.ENABLE_SWARM !== 'false';
  const swarmAgent = enableSwarm ? new SwarmAgent(llm, grokClient, sourceHealth) : undefined;
  if (swarmAgent) console.log('[Swarm] SwarmAgent enabled (disable with ENABLE_SWARM=false)');
  if (swarmAgent && sessionId) {
    swarmAgent.sessionId = sessionId;
  }

  const flashCrashScanner = grokClient ? new FlashCrashScanner(grokClient, sourceHealth) : undefined;
  if (flashCrashScanner) console.log('[FlashCrash] Scanner enabled (Grok)');
```

**Key changes:**
- `process.env.XAI_API_KEY` → `config.xaiApiKey` (3 places)
- `new GrokGrounder(key)` → `new GrokGrounder(key, sourceHealth)`
- `new SwarmAgent(llm, grokClient)` → `new SwarmAgent(llm, grokClient, sourceHealth)`
- `new FlashCrashScanner(grokClient)` → `new FlashCrashScanner(grokClient, sourceHealth)`
- Added `runGrokHealthCheck()` call

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: all pass

**Step 7: Commit**

```bash
git add src/utils/grok-startup.ts tests/grok-startup.test.ts src/index.ts
git commit -m "feat(grok): startup health check + wire config.xaiApiKey consistently

Closes #11"
```

---

## Round 2: Episodic Memory Write — #7 (3 tasks)

**Problem:** `EpisodicStore.addEpisode()` exists but is never called in production. Graph RAG searches an empty store every cycle.

### Task 6: Add episodicStore + embeddingClient to TradingLoopDeps

**Files:**
- Modify: `src/trading-loop.ts:33-82` (interface only)

**Step 1: Add deps to interface**

In `src/trading-loop.ts`, add two fields after `episodicAgent` (line 71):

```typescript
  episodicStore?: import('./memory/episodic-store.js').EpisodicStore;
  embeddingClient?: import('./llm/embedding-client.js').EmbeddingClient;
```

**Step 2: Verify no breakage**

Run: `npx vitest run`
Expected: all pass (fields are optional)

**Step 3: Commit**

```bash
git add src/trading-loop.ts
git commit -m "refactor(loop): add episodicStore + embeddingClient deps

Part of #7"
```

---

### Task 7: Save episodes after CLOSE and AUTO_CLOSE

**Files:**
- Modify: `src/trading-loop.ts` (add helper + call sites)
- Modify: `src/index.ts:206-214,217-258` (wire new deps)

**Step 1: Write failing test**

Append to `tests/trading-loop.test.ts` — but first read the file to understand existing mock setup, then add:

```typescript
it('calls episodicStore.addEpisode after successful CLOSE', async () => {
  const mockEpisodicStore = { addEpisode: vi.fn() };
  const mockEmbeddingClient = { getEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) };

  // Set up portfolio with an open position
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 100, availableUsd: 80,
    positions: [{ pair: 'BTCUSDT', sizeUsd: 200, leverage: 10, side: 'LONG', entryPrice: 50000, unrealizedPnlPct: 5.0, heldHours: 2 }],
    sessionPnl: 5, drawdownPct: 0,
  });
  mockLlm.analyze.mockResolvedValue([
    { pair: 'BTCUSDT', action: 'CLOSE', size_pct: 0, leverage: 0, stop_loss_pct: 0, take_profit_pct: 0, reasoning: 'take profit', confidence: 80 },
  ]);

  const closeLoop = new TradingLoop({
    ...baseDeps,
    episodicStore: mockEpisodicStore as any,
    embeddingClient: mockEmbeddingClient as any,
  });

  await closeLoop.runOnce();

  // Wait for fire-and-forget promise
  await new Promise(r => setTimeout(r, 50));

  expect(mockEmbeddingClient.getEmbedding).toHaveBeenCalledTimes(1);
  expect(mockEpisodicStore.addEpisode).toHaveBeenCalledTimes(1);
  const episode = mockEpisodicStore.addEpisode.mock.calls[0][0];
  expect(episode.textSummary).toContain('BTCUSDT');
  expect(episode.textSummary).toContain('LONG');
  expect(episode.resultPnl).toBe(5.0);
  expect(episode.embedding).toEqual([0.1, 0.2, 0.3]);
});
```

> **Note for executor:** The `baseDeps` variable should be extracted from the existing test setup. If the test file doesn't have it, create a helper from the existing `new TradingLoop({...})` pattern. Read the test file first.

**Step 2: Verify test fails**

Run: `npx vitest run tests/trading-loop.test.ts`
Expected: FAIL — `episodicStore` not used

**Step 3: Implement saveEpisode helper**

Add a private method to `TradingLoop` class (after `lastClosedAt` declaration, around line 90):

```typescript
  private saveEpisode(
    pair: string,
    side: string,
    regime: string,
    indicators: Map<string, import('./indicators/technical.js').Indicators>,
    heldHours: number,
    pnlPct: number,
    reasoning: string,
  ): void {
    if (!this.deps.episodicStore || !this.deps.embeddingClient) return;
    const ind = indicators.get(pair);
    const summary = [
      `Pair: ${pair}. Direction: ${side}.`,
      `Regime: ${regime}.`,
      `RSI: ${ind?.rsi?.toFixed(0) ?? '?'}. Volume: ${ind?.volumeRatio?.toFixed(1) ?? '?'}x.`,
      `ADX: ${ind?.adx?.toFixed(0) ?? '?'}. Trend: ${ind?.trend ?? 'unknown'}.`,
      `Held: ${heldHours.toFixed(1)}h. PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%.`,
      `Reasoning: ${reasoning}`,
    ].join(' ');

    this.deps.embeddingClient.getEmbedding(summary)
      .then(embedding => {
        this.deps.episodicStore!.addEpisode({
          id: `${pair}-${Date.now()}`,
          timestamp: Date.now(),
          textSummary: summary,
          embedding,
          resultPnl: pnlPct,
        });
        console.log(`[EpisodicRAG] Saved episode for ${pair} (PnL: ${pnlPct.toFixed(1)}%)`);
      })
      .catch(err => console.error('[EpisodicRAG] Failed:', err.message));
  }
```

**Step 4: Call saveEpisode after LLM CLOSE**

In `runOnce()`, after the trade story log block (line 910, right after closing brace of `if (this.deps.tradeStoryLogger)`), add:

```typescript
              this.saveEpisode(decision.pair, pos.side, marketRegime, indicators, pos.heldHours, pos.unrealizedPnlPct, decision.reasoning);
```

**Step 5: Call saveEpisode after AUTO_CLOSE**

In the auto-exit block (line 262, after closing brace of trade story log), add:

```typescript
            this.saveEpisode(pos.pair, pos.side, 'unknown', indicators, pos.heldHours, pos.unrealizedPnlPct, closeReason);
```

> **Note:** `indicators` Map is not yet built at the auto-exit point (built at line 267). Move `saveEpisode` call to use empty `new Map()` or move indicator computation before auto-exit. Simplest: pass `new Map()` since auto-exit episodes care more about PnL/timing than indicators. Or use an empty indicators map since it gracefully handles missing data with `'?'`.

Actually — the `indicators` variable is declared later (line 268). For auto-exit, pass `new Map()`:

```typescript
            this.saveEpisode(pos.pair, pos.side, 'unknown', new Map(), pos.heldHours, pos.unrealizedPnlPct, closeReason);
```

**Step 6: Wire in index.ts**

In `src/index.ts`, hoist `embeddingClient` and `episodicStore` out of the `if` block (lines 207-214):

```typescript
  let episodicAgent: EpisodicAgent | undefined;
  let embeddingClient: EmbeddingClient | undefined;
  let episodicStore: EpisodicStore | undefined;
  if (process.env.OPENAI_API_KEY_FALLBACK) {
    embeddingClient = new EmbeddingClient(process.env.OPENAI_API_KEY_FALLBACK);
    episodicStore = new EpisodicStore(join(process.env.DATA_DIR || './tmp', 'memory-graph.json'));
    episodicAgent = new EpisodicAgent(embeddingClient, episodicStore);
    console.log('[Memory] Episodic RAG enabled (Graph DB)');
  } else {
    console.warn('[Memory] Episodic RAG disabled — missing OPENAI_API_KEY_FALLBACK');
  }
```

Then in the `TradingLoop` deps object (around line 222), add:

```typescript
    episodicStore,
    embeddingClient,
```

**Step 7: Verify tests pass**

Run: `npx vitest run`
Expected: all pass

**Step 8: Commit**

```bash
git add src/trading-loop.ts src/index.ts tests/trading-loop.test.ts
git commit -m "feat(episodic): write episodes on CLOSE for Graph RAG

Closes #7"
```

---

## Round 3: Watchdog Wake + Rich Summary — #13, #14 (3 tasks)

**Problem #13:** Watchdog detects anomalies (>2% price spike) but only logs them. Brain doesn't wake up.
**Problem #14:** Watchdog summary is thin — only price delta + OI. Missing funding changes, L/S ratio.

### Task 8: Watchdog anomaly triggers brain.runOnce()

**Files:**
- Modify: `src/index.ts:269-275` (onAnomaly callback)
- Modify: `tests/watchdog.test.ts`

**Step 1: Write failing test**

Append to `tests/watchdog.test.ts`:

```typescript
  it('fires onAnomaly when price spikes > 2%', async () => {
    const anomalyCb = vi.fn();
    mockGetLatest.mockResolvedValue({
      mark_price: '70000',
      open_interest: '50000',
      funding_rate: '0.0001',
      long_short_ratio: 1.2,
      order_book_bid_pct: 55,
      order_book_ask_pct: 45,
    });
    mockMarketData.getQuickSnapshot.mockResolvedValue({
      pair: 'BTCUSDT',
      markPrice: '71500', // +2.14%
      openInterest: '50000',
      fundingRate: '0.0001',
      orderBookBidPct: 55,
      orderBookAskPct: 45,
      longShortRatio: 1.2,
    });

    const wd = new Watchdog({
      pairs: ['BTCUSDT'],
      marketData: mockMarketData,
      sessionId: 'test',
      insertSnapshot: mockInsertSnapshot,
      getLatestSnapshot: mockGetLatest,
      onAnomaly: anomalyCb,
    });

    await wd.tick();
    expect(anomalyCb).toHaveBeenCalledWith('BTCUSDT', 'PRICE_SPIKE', expect.stringContaining('2.'));
  });
```

> **Note:** This test may already pass if anomaly detection works. The real change is in `index.ts` — making the callback trigger `loop.runOnce()`. That's an integration test at the wiring level; we test it structurally.

**Step 2: Modify index.ts onAnomaly callback**

In `src/index.ts`, replace lines 269-272 with:

```typescript
      onAnomaly: (pair, type, detail) => {
        console.log(`[Watchdog] ANOMALY ${pair} ${type}: ${detail}`);
        logger.logError('WATCHDOG_ANOMALY', `${pair} ${type}: ${detail}`);
        // Wake Brain on anomaly — fire-and-forget
        console.log(`[Watchdog] Waking Brain for anomaly: ${pair} ${type}`);
        loop.runOnce().catch(err => console.error('[Watchdog] Brain wake failed:', err.message));
      },
```

**Step 3: Verify**

Run: `npx vitest run tests/watchdog.test.ts`
Expected: all pass

**Step 4: Commit**

```bash
git add src/index.ts tests/watchdog.test.ts
git commit -m "feat(watchdog): anomaly triggers brain.runOnce()

Closes #13"
```

---

### Task 9: Rich watchdog summary

**Files:**
- Modify: `src/watchdog-summary.ts`
- Modify: `tests/watchdog-summary.test.ts`

**Step 1: Write failing test**

Append to `tests/watchdog-summary.test.ts`:

```typescript
  it('includes funding rate and L/S ratio in summary', () => {
    const snaps = [
      { mark_price: 70000, open_interest: 50000, funding_rate: 0.0001, long_short_ratio: 1.2, created_at: '2026-03-06T10:00:00Z' },
      { mark_price: 70500, open_interest: 51000, funding_rate: 0.0003, long_short_ratio: 1.5, created_at: '2026-03-06T10:10:00Z' },
    ] as any;

    const result = buildWatchdogSummary('BTCUSDT', snaps, undefined);
    expect(result).toContain('Funding');
    expect(result).toContain('L/S');
  });

  it('flags funding rate change direction', () => {
    const snaps = [
      { mark_price: 70000, open_interest: 50000, funding_rate: 0.0001, long_short_ratio: 1.0, created_at: '2026-03-06T10:00:00Z' },
      { mark_price: 70100, open_interest: 50000, funding_rate: -0.0002, long_short_ratio: 0.8, created_at: '2026-03-06T10:10:00Z' },
    ] as any;

    const result = buildWatchdogSummary('BTCUSDT', snaps, undefined);
    expect(result).toContain('Funding flipped');
    expect(result).toContain('L/S 1.00→0.80');
  });
```

**Step 2: Verify tests fail**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: FAIL — no funding/L/S info in output

**Step 3: Implement**

Replace `src/watchdog-summary.ts`:

```typescript
import type { DbMarketSnapshot } from './db/types.js';
import type { OpenPositionContext } from './db/repository.js';

export function buildWatchdogSummary(
  pair: string,
  snapshots: DbMarketSnapshot[],
  posCtx: OpenPositionContext | undefined,
): string {
  if (snapshots.length === 0) return `${pair}: no data since last Brain cycle`;

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const priceDelta = ((Number(last.mark_price) - Number(first.mark_price)) / Number(first.mark_price) * 100).toFixed(1);
  const sign = Number(priceDelta) >= 0 ? '+' : '';
  const minutes = Math.round((new Date(last.created_at!).getTime() - new Date(first.created_at!).getTime()) / 60000);

  let summary = `${pair}: ${sign}${priceDelta}% over ${minutes}m (${snapshots.length} snapshots)`;

  // OI delta
  if (first.open_interest && last.open_interest) {
    const oiDelta = ((Number(last.open_interest) - Number(first.open_interest)) / Number(first.open_interest) * 100).toFixed(1);
    summary += ` | OI ${Number(oiDelta) >= 0 ? '+' : ''}${oiDelta}%`;
  }

  // Funding rate
  if (first.funding_rate != null && last.funding_rate != null) {
    const fr0 = Number(first.funding_rate);
    const fr1 = Number(last.funding_rate);
    if (Math.sign(fr0) !== Math.sign(fr1) && fr0 !== 0) {
      summary += ` | Funding flipped ${fr0 > 0 ? '+→-' : '-→+'}`;
    } else {
      const frBps = (fr1 * 10000).toFixed(1);
      summary += ` | Funding ${Number(frBps) >= 0 ? '+' : ''}${frBps}bps`;
    }
  }

  // Long/Short ratio
  if (first.long_short_ratio != null && last.long_short_ratio != null) {
    summary += ` | L/S ${Number(first.long_short_ratio).toFixed(2)}→${Number(last.long_short_ratio).toFixed(2)}`;
  }

  // SL/TP status
  if (posCtx) {
    const currentPrice = Number(last.mark_price);
    const slHit = posCtx.side === 'BUY'
      ? currentPrice <= posCtx.sl_price
      : currentPrice >= posCtx.sl_price;
    const tpHit = posCtx.side === 'BUY'
      ? currentPrice >= posCtx.tp_price
      : currentPrice <= posCtx.tp_price;

    summary += ` | SL $${posCtx.sl_price} ${slHit ? 'HIT' : 'NOT hit'}`;
    summary += ` | TP $${posCtx.tp_price} ${tpHit ? 'HIT' : 'NOT hit'}`;
  }

  return summary;
}
```

**Step 4: Verify tests pass**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: all pass

**Step 5: Run full suite**

Run: `npx vitest run`
Expected: all pass

**Step 6: Commit**

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog): rich summary with funding, L/S ratio

Closes #14"
```

---

## Round 4: Per-Pair Confluence — #15 (2 tasks)

**Problem:** `classifyRegime()` and `computeConfluence()` use BTC indicators only. SOL could breakout while BTC ranges — but all pairs get the same regime and confluence score.

### Task 10: Per-pair regime + confluence

**Files:**
- Modify: `src/trading-loop.ts:394-408,478-502`
- Modify: `src/llm/prompts.ts` (EnrichedPromptData)
- No new test file — modify existing

**Step 1: Write failing test**

In `tests/trading-loop.test.ts`, add test verifying per-pair data is passed to LLM:

```typescript
it('computes per-pair regime and confluence', async () => {
  // Setup snapshots for 2 pairs with different indicators
  mockMarketData.getSnapshot.mockImplementation((pair: string) => ({
    pair,
    markPrice: pair === 'BTCUSDT' ? '70000' : '0.50',
    candles1h: Array.from({ length: 50 }, (_, i) => ({
      close: String(pair === 'BTCUSDT' ? 69000 + i * 50 : 0.45 + i * 0.002),
      high: String(pair === 'BTCUSDT' ? 69100 + i * 50 : 0.46 + i * 0.002),
      low: String(pair === 'BTCUSDT' ? 68900 + i * 50 : 0.44 + i * 0.002),
      volume: String(100 + i),
      openTime: Date.now() - (50 - i) * 3600000,
    })),
    candles4h: [],
    openInterest: '50000',
    fundingRate: '0.0001',
    longShortRatio: 1.2,
    topTraderRatio: 1.1,
  }));

  const loop = new TradingLoop({ ...baseDeps, pairs: ['BTCUSDT', 'ADAUSDT'] });
  await loop.runOnce();

  // Verify LLM got per-pair data in prompt
  expect(mockLlm.analyze).toHaveBeenCalledTimes(1);
  const promptData = mockLlm.analyze.mock.calls[0][0];
  expect(promptData.pairRegimes).toBeDefined();
});
```

**Step 2: Implement**

In `src/trading-loop.ts`, replace the BTC-only regime block (lines 394-408) with per-pair:

```typescript
      // Calculate regime per pair (BTC as global fallback)
      const pairRegimes = new Map<string, { regime: MarketRegime; confidence: number; profile: FilterProfile }>();
      let marketRegime: MarketRegime = MarketRegime.Range;
      let regimeConfidence = 0;
      let activeProfile: FilterProfile | undefined;

      for (const snap of snapshots) {
        const ind = indicators.get(snap.pair);
        if (ind) {
          const res = classifyRegime(ind, parseFloat(snap.markPrice), fearGreed);
          pairRegimes.set(snap.pair, {
            regime: res.regime,
            confidence: res.confidence,
            profile: getFilterProfile(res.regime),
          });
        }
      }
      // Global regime = BTC or first available
      const btcSnap = snapshots.find(s => s.pair === 'BTCUSDT') || snapshots[0];
      const btcRegime = pairRegimes.get(btcSnap?.pair ?? '');
      if (btcRegime) {
        marketRegime = btcRegime.regime;
        regimeConfidence = btcRegime.confidence;
        activeProfile = btcRegime.profile;
      }
```

Replace the BTC-only confluence block (lines 482-494) with per-pair:

```typescript
      // Per-pair confluence
      const pairConfluence = new Map<string, { score: number; factors: string[] }>();
      const btcInd = indicators.get(btcSnap?.pair ?? '');
      for (const snap of snapshots) {
        const ind = indicators.get(snap.pair);
        const pairProfile = pairRegimes.get(snap.pair)?.profile;
        if (ind && snap) {
          const hasNewsCatalyst = !!(newsAnalysis && Array.isArray((newsAnalysis as any).top_signals) && (newsAnalysis as any).top_signals.some((s: any) => s.importance >= 7));
          pairConfluence.set(snap.pair, computeConfluence({
            trend: ind.trend,
            volumeRatio: ind.volumeRatio,
            vwap: ind.vwap || 0,
            markPrice: parseFloat(snap.markPrice),
            rsi: ind.rsi,
            rsiRange: pairProfile ? [pairProfile.rsiRange?.[0] ?? 30, pairProfile.rsiRange?.[1] ?? 70] : [30, 70],
            hasNewsCatalyst,
          }));
        }
      }
      // BTC confluence for backwards-compat
      let confluenceResult = pairConfluence.get(btcSnap?.pair ?? '') ?? (btcInd ? computeConfluence({
        trend: btcInd.trend,
        volumeRatio: btcInd.volumeRatio,
        vwap: btcInd.vwap || 0,
        markPrice: parseFloat(btcSnap?.markPrice ?? '0'),
        rsi: btcInd.rsi,
        rsiRange: activeProfile ? [activeProfile.rsiRange?.[0] ?? 30, activeProfile.rsiRange?.[1] ?? 70] : [30, 70],
        hasNewsCatalyst: false,
      }) : undefined);
```

Add `pairRegimes` and `pairConfluence` to `promptData` (around line 504):

```typescript
      const promptData = {
        // ...existing fields...
        pairRegimes: Object.fromEntries([...pairRegimes.entries()].map(([k, v]) => [k, { regime: v.regime, confidence: v.confidence }])),
        pairConfluence: Object.fromEntries(pairConfluence),
      };
```

In `src/llm/prompts.ts`, add fields to `EnrichedPromptData`:

```typescript
  pairRegimes?: Record<string, { regime: string; confidence: number }>;
  pairConfluence?: Record<string, { score: number; factors: string[] }>;
```

In `buildEnrichedPrompt()`, add a section for per-pair data if present:

```typescript
  if (data.pairRegimes && Object.keys(data.pairRegimes).length > 1) {
    parts.push('\n### PER-PAIR REGIME & CONFLUENCE');
    for (const [pair, r] of Object.entries(data.pairRegimes)) {
      const conf = data.pairConfluence?.[pair];
      parts.push(`${pair}: ${r.regime} (${r.confidence}%) | Confluence: ${conf?.score ?? '?'}/5 [${conf?.factors?.join(',') ?? ''}]`);
    }
  }
```

**Step 3: Update filter warning to use per-pair**

In the filter warning block (lines 496-502), update to use per-pair confluence for the BTC check (keep behavior same):

```typescript
      if (activeProfile && btcInd && portfolio.positions.length === 0 && confluenceResult) {
        if (btcInd.volumeRatio < activeProfile.volumeMin) {
          filterWarning = `Volume ${btcInd.volumeRatio.toFixed(2)}x < ${activeProfile.volumeMin}x required for ${marketRegime}`;
        } else if (confluenceResult.score < activeProfile.confluenceMin) {
          filterWarning = `Confluence ${confluenceResult.score}/5 [${confluenceResult.factors.join(',')}] < ${activeProfile.confluenceMin} required for ${marketRegime}`;
        }
      }
```

(This stays the same — `confluenceResult` is now the BTC confluence from the per-pair map.)

**Step 4: Verify**

Run: `npx vitest run`
Expected: all pass

**Step 5: Commit**

```bash
git add src/trading-loop.ts src/llm/prompts.ts tests/trading-loop.test.ts
git commit -m "feat(confluence): per-pair regime + confluence instead of BTC-only

Closes #15"
```

---

## Round 5: Memory Decisions — #17 (1 task)

**Problem:** `MemoryReviewAgent.review()` is called with empty decisions array (`[]`) at line 1062.

### Task 11: Pass recent decisions from DB to MemoryReview

**Files:**
- Modify: `src/trading-loop.ts:1058-1064`

**Step 1: Implement**

Replace the memoryReview call block (lines 1060-1064) with:

```typescript
            // Fetch recent decisions from DB for context
            let recentDecisionStrings: string[] = [];
            if (this.deps.sessionId) {
              try {
                const { getRecentDecisions } = await import('./db/repository.js');
                const rows = await getRecentDecisions(this.deps.sessionId, 20);
                recentDecisionStrings = rows.map(d =>
                  `${d.pair} ${d.action} (conf:${d.confidence}) — ${d.reasoning?.slice(0, 100) ?? ''}`
                );
              } catch { /* DB optional */ }
            }
            await this.deps.memoryReview.review(
              this.deps.memory.load().recent_trades,
              recentDecisionStrings,
              this.cycleCount,
            );
```

**Step 2: Check if getRecentDecisions exists**

Run: `grep -r "getRecentDecisions" src/db/repository.ts`

If it doesn't exist, add to `src/db/repository.ts`:

```typescript
export async function getRecentDecisions(sessionId: string, limit: number = 20): Promise<any[]> {
  const { rows } = await q().query(
    `SELECT pair, action, confidence, reasoning, created_at
     FROM trade_decisions
     WHERE session_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [sessionId, limit],
  );
  return rows;
}
```

**Step 3: Verify**

Run: `npx vitest run`
Expected: all pass

**Step 4: Commit**

```bash
git add src/trading-loop.ts src/db/repository.ts
git commit -m "feat(memory-review): pass recent decisions from DB instead of empty array

Closes #17"
```

---

## Round 6: Regime Override — #9 (1 task)

### Task 12: Apply LLM regime_override

**Files:**
- Modify: `src/trading-loop.ts` (after LLM decisions, before execution)

**Step 1: Implement**

After LLM decisions are received (around line 610), before the risk validation loop, add:

```typescript
      // Apply regime_override if LLM suggested one
      for (const d of decisions) {
        if ((d as any).regime_override && Object.values(MarketRegime).includes((d as any).regime_override)) {
          console.log(`[Loop] LLM regime override: ${marketRegime} → ${(d as any).regime_override}`);
          marketRegime = (d as any).regime_override as MarketRegime;
          activeProfile = getFilterProfile(marketRegime);
          break;
        }
      }
```

**Step 2: Verify**

Run: `npx vitest run`
Expected: all pass

**Step 3: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat(regime): apply LLM regime_override when provided

Closes #9"
```

---

## Round 7: Intelligence Reform — #16, #18, #19 (outlines)

These are larger issues. Use existing plan files for full details:

### Task 13: Swarm Reform (#16)
**Plan:** `docs/plans/2026-03-06-issue-16-swarm-reform.md`
**Key changes:** Reduce experts from 5→3 in default mode, skip critique phase for HOLD consensus, add confidence-weighted voting, reduce token budget.

### Task 14: FlashCrash Confirmation (#18)
**Plan:** `docs/plans/2026-03-06-issue-18-flashcrash-confirm.md`
**Key changes:** Add Binance price check before PANIC (verify >2% drop in last 5m via klines). Prevents false positives from Grok hallucination.

### Task 15: Pair Fixation Fix (#19)
**Plan:** `docs/plans/2026-03-06-issue-19-pair-fixation.md`
**Key changes:** New `pair-diversity.ts` module that tracks pair selection frequency and penalizes overrepresented pairs in prompt.

---

## Round 8: SL/TP Styles — #8 (outline)

### Task 16: Wire FilterProfile SL/TP
**Plan:** `docs/plans/2026-03-06-issue-08-sl-tp-styles.md`
**Key changes:** New `sl-tp-styles.ts` module that maps `slStyle`/`tpStyle` from `FilterProfile` to actual SL/TP calculations (trailing, ATR-based, range-based). Wire into `OrderExecutor`.

---

## Round 9: Dashboard — #2, #3, #4, #5, #6 (outlines)

All touch `src/binance/market-data.ts` + `src/webhook/server.ts`. Execute sequentially.

### Task 17-21: Dashboard endpoints
**Plans:** `docs/plans/2026-03-06-issue-02-*.md` through `issue-06-*.md`
**Key changes:** Add Binance API calls for margin balance, BNB balance, ROI per position, session PnL, total balance. Expose via webhook server endpoints.

---

## Verification Checklist (after all rounds)

```bash
# 1. Full test suite
npx vitest run

# 2. Build check
npm run build

# 3. Deploy
npm run deploy

# 4. Verify Grok health check in logs
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'pm2 logs indic-bot --lines 30 | grep Grok'

# 5. After a few cycles, verify episodic writes
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 'cat ~/.indic-bot/memory-graph.json | python3 -c "import sys,json; print(len(json.load(sys.stdin)))"'
```

## File Conflict Map

| File | Touched by tasks | Execution order |
|------|-----------------|-----------------|
| `src/llm/grok-client.ts` | T1 only | Round 1 |
| `src/news/flash-crash.ts` | T2 only | Round 1 |
| `src/news/grok-grounder.ts` | T3 only | Round 1 |
| `src/llm/swarm-agent.ts` | T4, T13 | Round 1, then Round 7 |
| `src/index.ts` | T5, T7, T8 | Round 1→2→3 (sequential) |
| `src/trading-loop.ts` | T6, T7, T10, T11, T12 | Rounds 2→4→5→6 (sequential) |
| `src/watchdog-summary.ts` | T9 only | Round 3 |
| `src/llm/prompts.ts` | T10 only | Round 4 |
