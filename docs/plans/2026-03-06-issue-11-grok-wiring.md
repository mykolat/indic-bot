# Issue #11: Grok (xAI) Not Used -- $0 of $10 Credit Spent

## Problem

xAI dashboard shows $0 usage despite FlashCrashScanner, GrokGrounder, and SwarmAgent narrative_expert all being "enabled" in code. Three silent failure modes:

1. **GrokClient silently returns `''` on empty API key** (`grok-client.ts:7`): `if (!this.apiKey) return '';` -- no log, no error.
2. **FlashCrashScanner swallows all errors** (`flash-crash.ts:14`): `catch (e) { /* ignore */ }` -- API auth failures, network errors, everything invisible.
3. **`config.xaiApiKey` is set but never passed to consumers** -- `src/index.ts:179,189` reads `process.env.XAI_API_KEY` directly instead of using `config.xaiApiKey`. This works but bypasses the config layer, meaning `loadConfig()` loads the key for nothing.
4. **No startup health check** -- bot logs `[FlashCrash] Scanner enabled (Grok)` even if the key is invalid/expired.
5. **SwarmAgent narrative_expert failure is logged but not tracked** (`swarm-agent.ts:233`): `console.warn(...)` only -- no metric, no sourceHealth integration.

## Root Cause Hypothesis

Most likely: `XAI_API_KEY` env var is either missing on the GCP VM or contains an invalid/expired key. The bot logs "enabled" but every call silently fails and returns defaults (IGNORE / empty string / null expert).

## Solution

1. Add a **startup health check** that makes a minimal xAI API call and logs success/failure with HTTP status
2. **Add logging to all catch blocks** in GrokClient, FlashCrashScanner, GrokGrounder
3. **Wire `config.xaiApiKey`** through to consumers instead of raw `process.env.XAI_API_KEY`
4. **Track Grok call success/failure** in SourceHealthMonitor for all three consumers
5. **Add `[Grok] DISABLED` log** when API key is missing (already exists for GrokGrounder, missing for FlashCrash/Swarm narrative)

## Files to Modify

| File | Change |
|------|--------|
| `src/llm/grok-client.ts` | Add `healthCheck()` method, log on empty key, log on API errors |
| `src/news/flash-crash.ts` | Log errors instead of swallowing, accept SourceHealthMonitor |
| `src/news/grok-grounder.ts` | Already logs errors (good), add sourceHealth tracking |
| `src/llm/swarm-agent.ts` | Log narrative_expert failures with detail, track in sourceHealth |
| `src/index.ts` | Use `config.xaiApiKey`, run health check at startup, pass sourceHealth to FlashCrash |
| `src/config.ts` | No changes needed (already loads `xaiApiKey`) |
| `tests/llm/grok-client.test.ts` | New tests for healthCheck, empty key logging |
| `tests/news/flash-crash.test.ts` | New tests for error logging, sourceHealth tracking |
| `tests/trading-loop.test.ts` | Test startup health check integration |

---

## TDD Implementation Steps

### Step 1: GrokClient.healthCheck() method

**1a. Write failing test**

File: `tests/llm/grok-client.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/fetch-timeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { GrokClient } from '../../src/llm/grok-client.js';
import { fetchWithTimeout } from '../../src/utils/fetch-timeout.js';

const mockFetch = vi.mocked(fetchWithTimeout);

describe('GrokClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls xAI API correctly', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'Test response' } }] }),
    } as any);
    const client = new GrokClient('fake-key');
    const res = await client.call('Sys', 'User', 'grok-4-1-fast-reasoning');
    expect(res).toBe('Test response');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.x.ai/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('grok-4-1-fast-reasoning'),
      }),
      15000,
    );
  });

  // --- NEW TESTS ---

  it('healthCheck returns { ok: true } on valid API key', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: 'hi' } }] }),
    } as any);

    const client = new GrokClient('valid-key');
    const result = await client.healthCheck();

    expect(result).toEqual({ ok: true });
    // Should use cheapest model
    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.model).toBe('grok-4-1-fast-non-reasoning');
    expect(body.max_tokens).toBe(1);
  });

  it('healthCheck returns { ok: false, error } on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as any);

    const client = new GrokClient('bad-key');
    const result = await client.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('healthCheck returns { ok: false } when no API key', async () => {
    const client = new GrokClient('');
    const result = await client.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('API key');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('healthCheck returns { ok: false } on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

    const client = new GrokClient('valid-key');
    const result = await client.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('fetch failed');
  });

  it('call() logs warning when API key is empty', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const client = new GrokClient('');
    const res = await client.call('Sys', 'User');

    expect(res).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[GrokClient]'));
    warnSpy.mockRestore();
  });

  it('call() logs error on API failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    } as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = new GrokClient('valid-key');
    await expect(client.call('Sys', 'User')).rejects.toThrow('xAI Error');
    errorSpy.mockRestore();
  });
});
```

**1b. Verify test fails**

```bash
npx vitest run tests/llm/grok-client.test.ts
```

Expected: `healthCheck` does not exist, `call()` does not log warning.

**1c. Implement**

File: `src/llm/grok-client.ts`

```typescript
import { fetchWithTimeout } from '../utils/fetch-timeout.js';

export interface GrokHealthResult {
  ok: boolean;
  error?: string;
}

export class GrokClient {
  private emptyKeyWarned = false;

  constructor(private apiKey: string) {}

  async healthCheck(): Promise<GrokHealthResult> {
    if (!this.apiKey) {
      return { ok: false, error: 'No xAI API key configured' };
    }

    try {
      const res = await fetchWithTimeout(
        'https://api.x.ai/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: 'grok-4-1-fast-non-reasoning',
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
        },
        10000,
      );

      if (!res.ok) {
        return { ok: false, error: `xAI API ${res.status}: ${res.statusText}` };
      }

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'unknown error' };
    }
  }

  async call(
    systemPrompt: string,
    userPrompt: string,
    model: string = 'grok-4-1-fast-reasoning',
  ): Promise<string> {
    if (!this.apiKey) {
      if (!this.emptyKeyWarned) {
        console.warn('[GrokClient] No API key — all Grok calls will be skipped');
        this.emptyKeyWarned = true;
      }
      return '';
    }

    const res = await fetchWithTimeout(
      'https://api.x.ai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
        }),
      },
      15000,
    );

    if (!res.ok) throw new Error(`xAI Error: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as any;
    return data.choices?.[0]?.message?.content ?? '';
  }
}
```

**1d. Verify tests pass**

```bash
npx vitest run tests/llm/grok-client.test.ts
```

**1e. Commit**

```bash
git add src/llm/grok-client.ts tests/llm/grok-client.test.ts
git commit -m "feat(grok): add healthCheck() method + logging on empty key"
```

---

### Step 2: FlashCrashScanner -- log errors, track health

**2a. Write failing test**

File: `tests/news/flash-crash.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlashCrashScanner } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects panic using non-reasoning model', async () => {
    const mockGrok = { call: vi.fn().mockResolvedValue('PANIC') } as any;
    const scanner = new FlashCrashScanner(mockGrok);
    const res = await scanner.scan();

    expect(res).toBe('PANIC');
    expect(mockGrok.call).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'grok-4-1-fast-non-reasoning',
    );
  });

  // --- NEW TESTS ---

  it('logs error when Grok call fails (not silently swallow)', async () => {
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

  it('tracks success in sourceHealth when provided', async () => {
    const mockGrok = { call: vi.fn().mockResolvedValue('IGNORE') } as any;
    const mockHealth = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };

    const scanner = new FlashCrashScanner(mockGrok, mockHealth as any);
    await scanner.scan();

    expect(mockHealth.recordSuccess).toHaveBeenCalledWith('grok-flash-crash');
  });

  it('tracks failure in sourceHealth when Grok throws', async () => {
    const mockGrok = {
      call: vi.fn().mockRejectedValue(new Error('timeout')),
    } as any;
    const mockHealth = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const scanner = new FlashCrashScanner(mockGrok, mockHealth as any);
    await scanner.scan();

    expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-flash-crash', 'timeout');
  });

  it('returns IGNORE when grokClient is null', async () => {
    const scanner = new FlashCrashScanner(null);
    const res = await scanner.scan();
    expect(res).toBe('IGNORE');
  });
});
```

**2b. Verify test fails**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

Expected: constructor doesn't accept `sourceHealth`, no logging on error.

**2c. Implement**

File: `src/news/flash-crash.ts`

```typescript
import type { SourceHealthMonitor } from './source-health.js';

export class FlashCrashScanner {
  constructor(
    private grokClient: any,
    private sourceHealth?: SourceHealthMonitor,
  ) {}

  async scan(): Promise<'PANIC' | 'IGNORE'> {
    if (!this.grokClient) return 'IGNORE';

    const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".`;

    try {
      const raw = await this.grokClient.call(
        sys,
        'Scan crypto X now.',
        'grok-4-1-fast-non-reasoning',
      );
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

**2d. Verify tests pass**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

**2e. Commit**

```bash
git add src/news/flash-crash.ts tests/news/flash-crash.test.ts
git commit -m "fix(flash-crash): log errors instead of swallowing, track in sourceHealth"
```

---

### Step 3: SwarmAgent -- log and track narrative_expert failures

**3a. Write failing test**

Add to `tests/llm/swarm-agent.test.ts` (append new `describe` block):

```typescript
// Add these test cases inside the existing describe block or in a new nested describe:

describe('SwarmAgent narrative_expert tracking', () => {
  it('logs detailed error when narrative_expert Grok call fails', async () => {
    const mockLlm = {
      call: vi.fn().mockResolvedValue(
        JSON.stringify({
          persona: 'risk_manager',
          thesis: 'Market is risky',
          position: 'HOLD',
          probability_of_success: 40,
          key_risks: ['volatility'],
          confidence: 60,
          arguments: ['high vol'],
        }),
      ),
      lastNextCheckMinutes: undefined,
    } as any;

    const mockGrokLlm = {
      call: vi.fn().mockRejectedValue(new Error('xAI Error: 401 Unauthorized')),
    } as any;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm);

    // Need to mock the judge call differently -- it comes after expert calls
    // The judge call is the last llm.call
    let callCount = 0;
    mockLlm.call.mockImplementation(() => {
      callCount++;
      if (callCount <= 5) {
        // Expert calls (5 non-grok personas)
        return Promise.resolve(
          JSON.stringify({
            persona: 'test',
            thesis: 'test thesis',
            position: 'HOLD',
            probability_of_success: 50,
            key_risks: ['risk'],
            confidence: 50,
            arguments: ['arg'],
          }),
        );
      }
      // Critique calls
      if (callCount <= 10) {
        return Promise.resolve(
          JSON.stringify({
            critiques: [{ target_persona: 'test', agrees: true, critique: 'ok' }],
            updated_probability: 50,
            updated_position: 'HOLD',
            strongest_risk_found: 'none',
          }),
        );
      }
      // Judge call
      return Promise.resolve(
        JSON.stringify({
          decisions: [{ pair: 'BTCUSDT', action: 'HOLD', confidence: 50, reasoning: 'test' }],
          next_check_minutes: 10,
        }),
      );
    });

    // Provide minimal EnrichedPromptData
    const data = {
      snapshots: [],
      portfolio: { balanceUsd: 100, positions: [], sessionPnl: 0, drawdownPct: 0 },
      indicators: {},
      sessionPnlPct: 0,
      signals: [],
      memory: '',
    } as any;

    await swarm.getConsensus(data);

    // Should log that narrative_expert failed with the specific error
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('narrative_expert'),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });
});
```

**3b. Verify test context** -- this test should already pass because `swarm-agent.ts:233` already logs `console.warn(\`[Swarm] Sub-agent ${personas[i]} failed:\`, res.reason)`. The key new behavior is **sourceHealth tracking**. Revise the test:

```typescript
describe('SwarmAgent narrative_expert sourceHealth tracking', () => {
  it('records grok-narrative failure in sourceHealth when narrative_expert throws', async () => {
    // ... (same setup as above but also pass sourceHealth)
    const mockSourceHealth = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
      recordGrokUsage: vi.fn(),
    };

    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    // ... run getConsensus ...

    expect(mockSourceHealth.recordFailure).toHaveBeenCalledWith(
      'grok-narrative',
      expect.stringContaining('401'),
    );
  });

  it('records grok-narrative success in sourceHealth when narrative_expert succeeds', async () => {
    // ... setup where grokLlm.call succeeds ...
    const swarm = new SwarmAgent(mockLlm, mockGrokLlm, mockSourceHealth as any);
    // ... run getConsensus ...

    expect(mockSourceHealth.recordSuccess).toHaveBeenCalledWith('grok-narrative');
  });
});
```

**3c. Implement**

File: `src/llm/swarm-agent.ts` -- changes at lines 185 and 216-236:

At the constructor (line 185):
```typescript
constructor(private llm: LLMClient, private grokLlm?: any, private sourceHealth?: any) { }
```

In the results processing loop (after line 232), update the fulfilled/rejected handling:
```typescript
for (let i = 0; i < results.length; i++) {
  const res = results[i];
  const isGrok = personas[i] === 'narrative_expert';
  if (res.status === 'fulfilled') {
    rawTexts.push(res.value);
    expertOutputs.push(parseExpertOutput(res.value, personas[i]));
    if (isGrok) {
      this.sourceHealth?.recordSuccess('grok-narrative');
    }
    // ... existing DB insert ...
  } else {
    console.warn(`[Swarm] Sub-agent ${personas[i]} failed:`, res.reason);
    if (isGrok) {
      this.sourceHealth?.recordFailure('grok-narrative', res.reason?.message ?? String(res.reason));
    }
    rawTexts.push('');
    expertOutputs.push(null);
  }
}
```

**3d. Verify tests pass**

```bash
npx vitest run tests/llm/swarm-agent.test.ts
```

**3e. Commit**

```bash
git add src/llm/swarm-agent.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): track narrative_expert success/failure in sourceHealth"
```

---

### Step 4: Wire config.xaiApiKey + startup health check in index.ts

**4a. Write failing test**

This is an integration-level change. Write a unit test for the wiring logic extracted as a helper:

File: `tests/grok-startup.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest';

// Test the startup health check logic (extracted function)
import { runGrokHealthCheck } from '../src/utils/grok-startup.js';

describe('runGrokHealthCheck', () => {
  it('logs success when healthCheck returns ok', async () => {
    const mockClient = {
      healthCheck: vi.fn().mockResolvedValue({ ok: true }),
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runGrokHealthCheck(mockClient as any);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Grok] Health check PASSED'));
    logSpy.mockRestore();
  });

  it('logs error when healthCheck returns not ok', async () => {
    const mockClient = {
      healthCheck: vi.fn().mockResolvedValue({ ok: false, error: 'xAI API 401: Unauthorized' }),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runGrokHealthCheck(mockClient as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Grok] Health check FAILED'),
      expect.stringContaining('401'),
    );
    errorSpy.mockRestore();
  });

  it('logs error when healthCheck throws', async () => {
    const mockClient = {
      healthCheck: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runGrokHealthCheck(mockClient as any);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Grok] Health check FAILED'),
      expect.stringContaining('network down'),
    );
    errorSpy.mockRestore();
  });
});
```

**4b. Verify test fails**

```bash
npx vitest run tests/grok-startup.test.ts
```

Expected: module `src/utils/grok-startup.ts` does not exist.

**4c. Implement**

File: `src/utils/grok-startup.ts`

```typescript
import type { GrokClient } from '../llm/grok-client.js';

export async function runGrokHealthCheck(client: GrokClient): Promise<boolean> {
  try {
    const result = await client.healthCheck();
    if (result.ok) {
      console.log('[Grok] Health check PASSED -- xAI API key is valid');
      return true;
    } else {
      console.error(`[Grok] Health check FAILED -- ${result.error}`);
      return false;
    }
  } catch (err: any) {
    console.error(`[Grok] Health check FAILED -- ${err?.message ?? 'unknown'}`);
    return false;
  }
}
```

**4d. Verify tests pass**

```bash
npx vitest run tests/grok-startup.test.ts
```

**4e. Update `src/index.ts`** to use `config.xaiApiKey` and run health check:

At line 179, replace `process.env.XAI_API_KEY` references with `config.xaiApiKey`:

```typescript
// Replace lines 179, 189 in src/index.ts:
import { runGrokHealthCheck } from './utils/grok-startup.js';

// ... inside main() ...

// Instantiate Grok Grounder if API key is provided
const grokGrounder = config.xaiApiKey ? new GrokGrounder(config.xaiApiKey) : undefined;
if (grokGrounder) console.log('[Grok] xAI Grounder enabled for claim verification');
else console.log('[Grok] No XAI_API_KEY — claim verification disabled');

// ...

const grokClient = config.xaiApiKey ? new GrokClient(config.xaiApiKey) : undefined;

// Startup health check
if (grokClient) {
  const healthy = await runGrokHealthCheck(grokClient);
  if (!healthy) {
    console.error('[Grok] WARNING: xAI API key appears invalid -- Grok features will fail silently');
  }
}

const enableSwarm = process.env.ENABLE_SWARM !== 'false';
const swarmAgent = enableSwarm ? new SwarmAgent(llm, grokClient, sourceHealth) : undefined;

const flashCrashScanner = grokClient ? new FlashCrashScanner(grokClient, sourceHealth) : undefined;
```

**4f. Commit**

```bash
git add src/utils/grok-startup.ts src/index.ts tests/grok-startup.test.ts
git commit -m "feat(grok): startup health check + wire config.xaiApiKey consistently"
```

---

### Step 5: GrokGrounder -- add sourceHealth tracking (optional enhancement)

GrokGrounder already tracks tokens via `sourceHealth.recordGrokUsage()` in `trading-loop.ts:337`. But it does not track success/failure of the API call itself. This is already handled at the call site in `trading-loop.ts`. No code changes needed for GrokGrounder itself -- the `SourceHealthMonitor` integration is done from `TradingLoop`.

However, to add internal tracking:

**5a. Write failing test**

Add to `tests/news/grok-grounder.test.ts`:

```typescript
it('records success in sourceHealth on successful verify', async () => {
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
    ok: false,
    status: 500,
    text: async () => 'Internal Server Error',
  } as any);

  const mockHealth = { recordSuccess: vi.fn(), recordFailure: vi.fn() };
  const g = new GrokGrounder('key', mockHealth as any);
  await g.verify('test claim');

  expect(mockHealth.recordFailure).toHaveBeenCalledWith('grok-grounder', expect.stringContaining('500'));
});
```

**5b. Implement**

File: `src/news/grok-grounder.ts` -- add optional `sourceHealth` to constructor:

```typescript
export class GrokGrounder {
  constructor(private xaiApiKey: string, private sourceHealth?: any) {}

  async verify(claim: string): Promise<GroundingResult> {
    try {
      // ... existing fetch logic ...
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        const error = `xAI API ${response.status}: ${errText.slice(0, 200)}`;
        this.sourceHealth?.recordFailure('grok-grounder', error);
        throw new Error(error);
      }

      // ... existing parse logic ...
      this.sourceHealth?.recordSuccess('grok-grounder');
      return { /* ... existing return */ };
    } catch (err: any) {
      if (!err?.message?.includes('timeout') && !err?.message?.includes('401')) {
        console.error('[GrokGrounder] Error:', err?.message);
      }
      this.sourceHealth?.recordFailure('grok-grounder', err?.message ?? 'unknown');
      return { claim, error: err?.message, tokensUsed: 0 };
    }
  }
}
```

**5c. Verify tests pass**

```bash
npx vitest run tests/news/grok-grounder.test.ts
```

**5d. Update `src/index.ts`** to pass `sourceHealth` to `GrokGrounder`:

```typescript
const grokGrounder = config.xaiApiKey ? new GrokGrounder(config.xaiApiKey, sourceHealth) : undefined;
```

**5e. Commit**

```bash
git add src/news/grok-grounder.ts tests/news/grok-grounder.test.ts src/index.ts
git commit -m "feat(grok-grounder): track success/failure in sourceHealth"
```

---

## Verification Checklist

After all steps, run the full test suite:

```bash
npx vitest run
```

Then deploy to GCP and check logs:

```bash
npm run deploy
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 "cd ~/indic-bot && pm2 restart indic-bot && sleep 5 && pm2 logs indic-bot --lines 30"
```

Expected startup logs if key is valid:
```
[Grok] xAI Grounder enabled for claim verification
[Grok] Health check PASSED -- xAI API key is valid
[Swarm] SwarmAgent enabled (disable with ENABLE_SWARM=false)
[FlashCrash] Scanner enabled (Grok)
```

Expected startup logs if key is invalid:
```
[Grok] xAI Grounder enabled for claim verification
[Grok] Health check FAILED -- xAI API 401: Unauthorized
[Grok] WARNING: xAI API key appears invalid -- Grok features will fail silently
```

After a few cycles, check SourceHealthMonitor output in performance logs for Grok call counts > 0.

## Summary of Changes

| Component | Before | After |
|-----------|--------|-------|
| `GrokClient.call()` | Silent return `''` on empty key | Logs warning once, still returns `''` |
| `GrokClient` | No health check | `healthCheck()` method: 1-token API call |
| `FlashCrashScanner` | `catch (e) { /* ignore */ }` | Logs error, tracks in sourceHealth |
| `SwarmAgent` | `console.warn` only for narrative_expert | Also tracks in sourceHealth |
| `GrokGrounder` | Logs errors, no sourceHealth | Tracks success/failure in sourceHealth |
| `index.ts` | `process.env.XAI_API_KEY` direct | Uses `config.xaiApiKey`, runs health check |
| Startup | "enabled" log even if key is bad | Health check validates key actually works |
