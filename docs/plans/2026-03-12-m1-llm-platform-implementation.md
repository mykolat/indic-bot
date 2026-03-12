# M1 LLM Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use writing-plans to implement this plan task-by-task.

**Goal:** Build a standalone LLM platform inside the repo that owns provider routing, inference policy, caching, and audit logging behind a stable API.

**Architecture:** Create a new `src/platform/llm/` module with explicit contracts, a provider router, a platform service, and an HTTP app. Reuse existing `src/llm/*` clients only as provider adapters so the current bot code stops owning model selection and inference orchestration directly.

**Tech Stack:** TypeScript, Node.js, Vitest, Binance SDK.

---

### Task 1: Contracts + Inference Policy

**Files:**
- Create: `src/platform/llm/contracts.ts`
- Test: `tests/platform/llm/contracts.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import {
  normalizeInferenceRequest,
  selectInferenceProfile,
  type InferenceRequest,
} from '../../../src/platform/llm/contracts.js';

describe('platform/llm/contracts', () => {
  it('defaults to balanced profile when no hint is provided', () => {
    const request: InferenceRequest = {
      task: 'summarize',
      input: { text: 'hello' },
    };

    const normalized = normalizeInferenceRequest(request);
    expect(normalized.profile).toBe('balanced');
  });

  it('maps cost and latency hints to cheap and fast profiles', () => {
    expect(selectInferenceProfile({ hint: 'cheap' })).toBe('cheap');
    expect(selectInferenceProfile({ hint: 'fast' })).toBe('fast');
  });

  it('preserves explicit model selection', () => {
    const normalized = normalizeInferenceRequest({
      task: 'trade-analysis',
      input: { pair: 'BTCUSDT' },
      model: 'gpt-4o-mini',
      profile: 'deep',
    });

    expect(normalized.model).toBe('gpt-4o-mini');
    expect(normalized.profile).toBe('deep');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/llm/contracts.test.ts`

**Step 3: Write minimal implementation**
```typescript
export type InferenceProfile = 'cheap' | 'fast' | 'balanced' | 'deep';

export interface InferenceRequest {
  task: string;
  input: Record<string, unknown>;
  hint?: 'cheap' | 'fast' | 'deep';
  profile?: InferenceProfile;
  provider?: string;
  model?: string;
  cacheKey?: string;
}

export interface NormalizedInferenceRequest extends InferenceRequest {
  profile: InferenceProfile;
}

export interface InferenceResponse {
  provider: string;
  model: string;
  output: unknown;
  cached: boolean;
}

export function selectInferenceProfile(opts: { hint?: 'cheap' | 'fast' | 'deep' }): InferenceProfile {
  if (opts.hint === 'cheap') return 'cheap';
  if (opts.hint === 'fast') return 'fast';
  if (opts.hint === 'deep') return 'deep';
  return 'balanced';
}

export function normalizeInferenceRequest(request: InferenceRequest): NormalizedInferenceRequest {
  return {
    ...request,
    profile: request.profile ?? selectInferenceProfile({ hint: request.hint }),
  };
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/llm/contracts.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/llm/contracts.test.ts src/platform/llm/contracts.ts
git commit -m "feat(m1): add llm platform contracts and inference policy #gemini"
```

### Task 2: Provider Router

**Files:**
- Create: `src/platform/llm/provider-router.ts`
- Test: `tests/platform/llm/provider-router.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it } from 'vitest';
import { chooseProvider } from '../../../src/platform/llm/provider-router.js';

const capabilities = {
  codex: ['balanced', 'deep'],
  grok: ['fast', 'deep'],
  fallback: ['cheap', 'fast'],
} as const;

describe('platform/llm/provider-router', () => {
  it('uses explicit provider when it supports the requested profile', () => {
    const result = chooseProvider(
      { task: 'summarize', input: {}, provider: 'grok', profile: 'fast' },
      capabilities,
    );
    expect(result).toBe('grok');
  });

  it('routes cheap requests to the fallback provider', () => {
    const result = chooseProvider(
      { task: 'classify', input: {}, profile: 'cheap' },
      capabilities,
    );
    expect(result).toBe('fallback');
  });

  it('throws when no provider supports the requested profile', () => {
    expect(() =>
      chooseProvider(
        { task: 'reason', input: {}, profile: 'deep', provider: 'unknown' },
        capabilities,
      ),
    ).toThrow('No provider');
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/llm/provider-router.test.ts`

**Step 3: Write minimal implementation**
```typescript
import type { InferenceProfile, NormalizedInferenceRequest } from './contracts.js';

export type ProviderCapabilities = Record<string, readonly InferenceProfile[]>;

export function chooseProvider(
  request: Pick<NormalizedInferenceRequest, 'provider' | 'profile'>,
  capabilities: ProviderCapabilities,
): string {
  if (request.provider) {
    const supported = capabilities[request.provider];
    if (supported?.includes(request.profile)) return request.provider;
    throw new Error(`No provider supports profile ${request.profile}`);
  }

  for (const [provider, profiles] of Object.entries(capabilities)) {
    if (profiles.includes(request.profile)) return provider;
  }

  throw new Error(`No provider supports profile ${request.profile}`);
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/llm/provider-router.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/llm/provider-router.test.ts src/platform/llm/provider-router.ts
git commit -m "feat(m1): add llm provider router #gemini"
```

### Task 3: Platform Service with Cache + Audit

**Files:**
- Create: `src/platform/llm/service.ts`
- Modify: `src/llm/client.ts`
- Modify: `src/llm/fallback-client.ts`
- Modify: `src/llm/grok-client.ts`
- Test: `tests/platform/llm/service.test.ts`

**Step 1: Write the failing test**
```typescript
import { describe, expect, it, vi } from 'vitest';
import { InferenceService } from '../../../src/platform/llm/service.js';

describe('platform/llm/service', () => {
  it('returns cached responses without calling the provider', async () => {
    const cache = {
      get: vi.fn().mockResolvedValue({ provider: 'codex', model: 'gpt-5.4', output: { ok: true }, cached: true }),
      set: vi.fn(),
    };

    const providers = {
      codex: { run: vi.fn() },
    };

    const audit = { write: vi.fn().mockResolvedValue(undefined) };
    const service = new InferenceService({ cache, providers, audit, router: () => 'codex' });

    const result = await service.run({ task: 'test', input: {}, profile: 'balanced', cacheKey: 'abc' });

    expect(result.cached).toBe(true);
    expect(providers.codex.run).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/llm/service.test.ts`

**Step 3: Write minimal implementation**
```typescript
import type { InferenceResponse, NormalizedInferenceRequest } from './contracts.js';

interface Cache {
  get(key: string): Promise<InferenceResponse | null>;
  set(key: string, value: InferenceResponse): Promise<void>;
}

interface AuditWriter {
  write(event: { request: NormalizedInferenceRequest; response: InferenceResponse }): Promise<void>;
}

interface ProviderAdapter {
  run(request: NormalizedInferenceRequest): Promise<InferenceResponse>;
}

export class InferenceService {
  constructor(private deps: {
    cache: Cache;
    providers: Record<string, ProviderAdapter>;
    audit: AuditWriter;
    router: (request: NormalizedInferenceRequest) => string;
  }) {}

  async run(request: NormalizedInferenceRequest): Promise<InferenceResponse> {
    if (request.cacheKey) {
      const cached = await this.deps.cache.get(request.cacheKey);
      if (cached) {
        await this.deps.audit.write({ request, response: cached });
        return cached;
      }
    }

    const providerName = this.deps.router(request);
    const provider = this.deps.providers[providerName];
    const response = await provider.run(request);

    if (request.cacheKey) {
      await this.deps.cache.set(request.cacheKey, response);
    }

    await this.deps.audit.write({ request, response });
    return response;
  }
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/llm/service.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/llm/service.test.ts src/platform/llm/service.ts src/llm/client.ts src/llm/fallback-client.ts src/llm/grok-client.ts
git commit -m "feat(m1): add llm inference service with cache and audit #gemini"
```

### Task 4: HTTP App + Bot Client

**Files:**
- Create: `src/platform/llm/app.ts`
- Create: `src/platform/llm/http-server.ts`
- Create: `src/platform/llm/bot-client.ts`
- Test: `tests/platform/llm/app.test.ts`

**Step 1: Write the failing test**
```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLlmPlatformApp } from '../../../src/platform/llm/app.js';

describe('platform/llm/app', () => {
  let server: ReturnType<ReturnType<typeof buildLlmPlatformApp>['listen']>;
  let baseUrl = '';

  beforeAll(async () => {
    const app = buildLlmPlatformApp({
      runInference: async () => ({ provider: 'codex', model: 'gpt-5.4', output: { ok: true }, cached: false }),
      listModels: () => ['gpt-5.4', 'gpt-4o-mini'],
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns available models', async () => {
    const response = await fetch(`${baseUrl}/models`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: ['gpt-5.4', 'gpt-4o-mini'] });
  });
});
```

**Step 2: Run test to verify it fails**
Run: `npx vitest run tests/platform/llm/app.test.ts`

**Step 3: Write minimal implementation**
```typescript
import express from 'express';

export function buildLlmPlatformApp(deps: {
  runInference: (body: any) => Promise<any>;
  listModels: () => string[];
}) {
  const app = express();
  app.use(express.json());

  app.get('/models', (_req, res) => {
    res.json({ models: deps.listModels() });
  });

  app.post('/inference', async (req, res) => {
    const result = await deps.runInference(req.body);
    res.json(result);
  });

  return app;
}
```

**Step 4: Run test to verify it passes**
Run: `npx vitest run tests/platform/llm/app.test.ts`

**Step 5: Commit**
```bash
git add tests/platform/llm/app.test.ts src/platform/llm/app.ts src/platform/llm/http-server.ts src/platform/llm/bot-client.ts
git commit -m "feat(m1): expose llm platform http app and bot client #gemini"
```

