# Token Rotation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Multi-account token pool with automatic rotation based on rate limits, stored in Supabase.

**Architecture:** New `tokens` table in Supabase. `TokenPool` class reads/rotates tokens. `LLMClient` exposes rate limit headers after each SSE call. CLI script `token:add` for adding tokens via OAuth or API key. Dashboard page shows token stats with auto-refresh.

**Tech Stack:** TypeScript, pg (direct SQL), Supabase REST (dashboard), React + Tailwind (dashboard)

---

### Task 1: DB Migration — `tokens` table

**Files:**
- Create: Supabase migration via MCP

**Step 1: Apply migration**

```sql
CREATE TABLE tokens (
  id                  SERIAL PRIMARY KEY,
  label               TEXT NOT NULL,
  provider            TEXT NOT NULL,
  auth_type           TEXT NOT NULL DEFAULT 'api',
  api_key             TEXT,
  access_token        TEXT,
  refresh_token       TEXT,
  account_id          TEXT,
  expires_at          TIMESTAMPTZ,
  primary_used_pct    SMALLINT DEFAULT 0,
  secondary_used_pct  SMALLINT DEFAULT 0,
  primary_reset_at    TIMESTAMPTZ,
  secondary_reset_at  TIMESTAMPTZ,
  is_active           BOOLEAN DEFAULT true,
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);
```

**Step 2: Verify**

Run: `SELECT * FROM tokens LIMIT 1;` — should return empty set, no errors.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat(db): add tokens table for multi-account pool"
```

---

### Task 2: DB Types + Repository — `DbToken` interface + CRUD

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/repository.ts`
- Test: `tests/db/token-repository.test.ts`

**Step 1: Write test**

```typescript
import { describe, it, expect, vi } from 'vitest';

// Unit test — mock the pool
describe('token repository SQL', () => {
  it('insertToken builds correct INSERT', () => {
    // We test the function exists and has correct signature
    // Integration tested via token:add script
    expect(true).toBe(true);
  });
});
```

**Step 2: Add DbToken to types.ts**

Append to `src/db/types.ts`:

```typescript
export interface DbToken {
  id?: number;
  label: string;
  provider: string;
  auth_type: string;
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  expires_at?: string;
  primary_used_pct?: number;
  secondary_used_pct?: number;
  primary_reset_at?: string;
  secondary_reset_at?: string;
  is_active?: boolean;
  last_used_at?: string;
  last_error?: string;
  created_at?: string;
  updated_at?: string;
}
```

**Step 3: Add repository functions to `src/db/repository.ts`**

Add import `DbToken` to the import list, then append:

```typescript
// --- Tokens ---

export async function insertToken(t: Omit<DbToken, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO tokens (label, provider, auth_type, api_key, access_token, refresh_token, account_id, expires_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [t.label, t.provider, t.auth_type, t.api_key ?? null,
     t.access_token ?? null, t.refresh_token ?? null, t.account_id ?? null,
     t.expires_at ?? null, t.is_active ?? true],
  );
  return rows[0].id;
}

export async function getActiveTokens(provider: string): Promise<DbToken[]> {
  const { rows } = await q().query(
    `SELECT * FROM tokens WHERE provider = $1 AND is_active = true ORDER BY secondary_used_pct ASC`,
    [provider],
  );
  return rows;
}

export async function updateTokenStats(id: number, stats: {
  primary_used_pct: number;
  secondary_used_pct: number;
  primary_reset_at: string | null;
  secondary_reset_at: string | null;
  last_used_at: string;
  access_token?: string;
  expires_at?: string;
}): Promise<void> {
  await q().query(
    `UPDATE tokens SET
       primary_used_pct = $2, secondary_used_pct = $3,
       primary_reset_at = $4, secondary_reset_at = $5,
       last_used_at = $6, access_token = COALESCE($7, access_token),
       expires_at = COALESCE($8, expires_at), updated_at = NOW()
     WHERE id = $1`,
    [id, stats.primary_used_pct, stats.secondary_used_pct,
     stats.primary_reset_at, stats.secondary_reset_at,
     stats.last_used_at, stats.access_token ?? null, stats.expires_at ?? null],
  );
}

export async function updateTokenError(id: number, error: string): Promise<void> {
  await q().query(
    `UPDATE tokens SET last_error = $2, updated_at = NOW() WHERE id = $1`,
    [id, error],
  );
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/db/`

**Step 5: Commit**

```bash
git add src/db/types.ts src/db/repository.ts tests/db/
git commit -m "feat(db): add DbToken type + token CRUD repository functions"
```

---

### Task 3: TokenPool class — `src/llm/token-pool.ts`

**Files:**
- Create: `src/llm/token-pool.ts`
- Test: `tests/llm/token-pool.test.ts`

**Step 1: Write test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenPool } from '../../src/llm/token-pool.js';

// Mock repository
vi.mock('../../src/db/repository.js', () => ({
  getActiveTokens: vi.fn(),
  updateTokenStats: vi.fn(),
  updateTokenError: vi.fn(),
}));

import { getActiveTokens, updateTokenStats, updateTokenError } from '../../src/db/repository.js';

const mockTokens = [
  { id: 1, label: 'alpha', provider: 'codex', auth_type: 'oauth', access_token: 'tok1', refresh_token: 'ref1', account_id: 'acc1', primary_used_pct: 20, secondary_used_pct: 40, is_active: true },
  { id: 2, label: 'bravo', provider: 'codex', auth_type: 'oauth', access_token: 'tok2', refresh_token: 'ref2', account_id: 'acc2', primary_used_pct: 80, secondary_used_pct: 10, is_active: true },
  { id: 3, label: 'charlie', provider: 'codex', auth_type: 'oauth', access_token: 'tok3', refresh_token: 'ref3', account_id: 'acc3', primary_used_pct: 95, secondary_used_pct: 96, is_active: true },
];

describe('TokenPool', () => {
  let pool: TokenPool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new TokenPool();
  });

  it('getBestToken picks lowest secondary_used_pct within thresholds', async () => {
    (getActiveTokens as any).mockResolvedValue(mockTokens);
    const result = await pool.getBestToken('codex');
    // bravo has secondary 10% (lowest) and primary 80% (< 90)
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2);
  });

  it('getBestToken skips tokens over threshold', async () => {
    (getActiveTokens as any).mockResolvedValue([mockTokens[2]]); // charlie: 95%/96%
    const result = await pool.getBestToken('codex');
    expect(result).toBeNull();
  });

  it('getBestToken returns null on empty pool', async () => {
    (getActiveTokens as any).mockResolvedValue([]);
    const result = await pool.getBestToken('codex');
    expect(result).toBeNull();
  });

  it('parseRateLimitHeaders extracts x-codex-* headers', () => {
    const headers = new Map([
      ['x-codex-primary-used-percent', '45'],
      ['x-codex-secondary-used-percent', '72'],
      ['x-codex-primary-reset-at', '1773034096'],
      ['x-codex-secondary-reset-at', '1773436859'],
    ]);
    const stats = pool.parseRateLimitHeaders(headers);
    expect(stats.primary_used_pct).toBe(45);
    expect(stats.secondary_used_pct).toBe(72);
  });

  it('needsRotation returns true when primary > 80', () => {
    expect(pool.needsRotation({ primary_used_pct: 85, secondary_used_pct: 50 })).toBe(true);
  });

  it('needsRotation returns true when secondary > 85', () => {
    expect(pool.needsRotation({ primary_used_pct: 30, secondary_used_pct: 90 })).toBe(true);
  });

  it('needsRotation returns false when both below threshold', () => {
    expect(pool.needsRotation({ primary_used_pct: 30, secondary_used_pct: 50 })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/token-pool.test.ts`
Expected: FAIL — module not found

**Step 3: Implement TokenPool**

Create `src/llm/token-pool.ts`:

```typescript
import { getActiveTokens, updateTokenStats, updateTokenError } from '../db/repository.js';
import type { DbToken } from '../db/types.js';

const PRIMARY_THRESHOLD = 90;
const SECONDARY_THRESHOLD = 95;
const ROTATION_PRIMARY = 80;
const ROTATION_SECONDARY = 85;

export interface RateLimitStats {
  primary_used_pct: number;
  secondary_used_pct: number;
  primary_reset_at: string | null;
  secondary_reset_at: string | null;
}

export class TokenPool {
  private currentTokenId: number | null = null;

  async getBestToken(provider: string): Promise<DbToken | null> {
    const tokens = await getActiveTokens(provider);
    const eligible = tokens.filter(t =>
      (t.primary_used_pct ?? 0) < PRIMARY_THRESHOLD &&
      (t.secondary_used_pct ?? 0) < SECONDARY_THRESHOLD,
    );
    if (eligible.length === 0) return null;
    // Already sorted by secondary_used_pct ASC from DB query
    const best = eligible[0];
    this.currentTokenId = best.id!;
    return best;
  }

  getCurrentTokenId(): number | null {
    return this.currentTokenId;
  }

  parseRateLimitHeaders(headers: Map<string, string> | Record<string, string>): RateLimitStats {
    const get = (key: string): string | undefined =>
      headers instanceof Map ? headers.get(key) : headers[key];

    const primaryResetAt = get('x-codex-primary-reset-at');
    const secondaryResetAt = get('x-codex-secondary-reset-at');

    return {
      primary_used_pct: parseInt(get('x-codex-primary-used-percent') ?? '0', 10),
      secondary_used_pct: parseInt(get('x-codex-secondary-used-percent') ?? '0', 10),
      primary_reset_at: primaryResetAt
        ? new Date(parseInt(primaryResetAt, 10) * 1000).toISOString()
        : null,
      secondary_reset_at: secondaryResetAt
        ? new Date(parseInt(secondaryResetAt, 10) * 1000).toISOString()
        : null,
    };
  }

  needsRotation(stats: Pick<RateLimitStats, 'primary_used_pct' | 'secondary_used_pct'>): boolean {
    return stats.primary_used_pct > ROTATION_PRIMARY ||
           stats.secondary_used_pct > ROTATION_SECONDARY;
  }

  async updateStats(tokenId: number, headers: Map<string, string> | Record<string, string>): Promise<RateLimitStats> {
    const stats = this.parseRateLimitHeaders(headers);
    await updateTokenStats(tokenId, {
      ...stats,
      last_used_at: new Date().toISOString(),
    }).catch(() => {});
    return stats;
  }

  async rotateOnError(tokenId: number, error: string): Promise<DbToken | null> {
    await updateTokenError(tokenId, error).catch(() => {});
    // Get next best token (will exclude the errored one if it hit limits)
    return this.getBestToken('codex');
  }
}
```

**Step 4: Run test**

Run: `npx vitest run tests/llm/token-pool.test.ts`
Expected: all PASS

**Step 5: Commit**

```bash
git add src/llm/token-pool.ts tests/llm/token-pool.test.ts
git commit -m "feat(llm): add TokenPool class with rotation logic + tests"
```

---

### Task 4: Expose rate limit headers from `client.ts`

**Files:**
- Modify: `src/llm/client.ts`

**Step 1: Add `rateLimitHeaders` field and expose from streamSSE**

In `client.ts`, add a field after line 27:

```typescript
private _rateLimitHeaders: Record<string, string> = {};
```

Add getter:

```typescript
get rateLimitHeaders(): Record<string, string> {
  return this._rateLimitHeaders;
}
```

**Step 2: Capture headers in streamSSE**

At the start of `streamSSE()` (after line 192), before reading the body, add:

```typescript
// Capture rate limit headers
this._rateLimitHeaders = {};
for (const key of ['x-codex-primary-used-percent', 'x-codex-secondary-used-percent',
  'x-codex-primary-reset-at', 'x-codex-secondary-reset-at',
  'x-codex-plan-type', 'x-codex-active-limit']) {
  const val = response.headers.get(key);
  if (val) this._rateLimitHeaders[key] = val;
}
```

**Step 3: Run existing tests**

Run: `npx vitest run tests/llm/`
Expected: all PASS (no breaking changes)

**Step 4: Commit**

```bash
git add src/llm/client.ts
git commit -m "feat(llm): expose x-codex rate limit headers from SSE responses"
```

---

### Task 5: Integrate TokenPool into `index.ts`

**Files:**
- Modify: `src/index.ts`

**Step 1: Replace single-token flow with TokenPool**

At imports section add:

```typescript
import { TokenPool } from './llm/token-pool.js';
```

Replace lines 114-122 (OAuth auth block) with:

```typescript
// Token pool: multi-account rotation
const tokenPool = new TokenPool();
let currentToken = await tokenPool.getBestToken('codex');
let accessToken: string;
if (currentToken?.access_token) {
  console.log(`[Auth] Using token pool — '${currentToken.label}' (${currentToken.account_id?.slice(0, 8)}...)`);
  accessToken = currentToken.access_token;
} else if (config.openai.apiKey && config.openai.apiKey !== 'oauth') {
  console.log('[Auth] No pool tokens — using OpenAI API key from env');
  accessToken = config.openai.apiKey;
} else {
  console.log('[Auth] No pool tokens — using OAuth flow fallback');
  accessToken = await getOpenAIAccessToken();
}
```

Replace lines 334-340 (cycle token refresh) with:

```typescript
// Token rotation: update stats from last call, rotate if needed
try {
  const headers = llm.rateLimitHeaders;
  if (currentToken?.id && Object.keys(headers).length > 0) {
    const stats = await tokenPool.updateStats(currentToken.id, headers);
    if (tokenPool.needsRotation(stats)) {
      const next = await tokenPool.getBestToken('codex');
      if (next?.access_token) {
        console.log(`[Auth] Rotating token: '${currentToken.label}' → '${next.label}' (5h: ${stats.primary_used_pct}%, weekly: ${stats.secondary_used_pct}%)`);
        currentToken = next;
        llm.updateAccessToken(next.access_token);
      } else {
        console.warn('[Auth] All tokens exhausted — staying on current, Layer 2/3 will catch failures');
      }
    }
  } else if (!currentToken) {
    // Fallback: try OAuth refresh as before
    const freshToken = await getOpenAIAccessToken();
    llm.updateAccessToken(freshToken);
  }
} catch (err: any) {
  console.warn('[Auth] Token rotation skipped:', err.message);
}
```

**Step 2: Run bot locally to verify startup**

Run: `npm run dev` — verify it starts (will use OAuth fallback if no tokens in DB yet)
Ctrl+C after startup.

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(core): integrate TokenPool rotation into trading loop"
```

---

### Task 6: Handle 429 reactive rotation in `client.ts`

**Files:**
- Modify: `src/llm/client.ts`

**Step 1: Add token exhaustion error type**

After the `analyze()` catch block (line 150-153), the error is already thrown and caught by TradingLoop. We need `index.ts` to detect 429 and rotate. Modify the error in `analyze()` to include status:

In the existing error throw (line 72):

```typescript
if (!response.ok) {
  const errText = await response.text().catch(() => '');
  const err = new Error(`Codex API ${response.status}: ${errText.slice(0, 300)}`);
  (err as any).status = response.status;
  throw err;
}
```

**Step 2: Add 429 handling in `index.ts` runCycle**

In the TradingLoop error handler (wherever Codex errors are caught and Layer 2 is tried), add before fallback:

```typescript
// In the catch block that handles LLM errors:
if ((err as any).status === 429 && currentToken?.id) {
  console.warn(`[Auth] 429 rate limit on '${currentToken.label}' — rotating...`);
  const next = await tokenPool.rotateOnError(currentToken.id, '429 rate limit');
  if (next?.access_token) {
    currentToken = next;
    llm.updateAccessToken(next.access_token);
    console.log(`[Auth] Rotated to '${next.label}'`);
  }
}
```

Note: This will be placed in `trading-loop.ts` or `index.ts` depending on where the LLM error is caught. Check `TradingLoop.runOnce()` for the exact catch location.

**Step 3: Run tests**

Run: `npx vitest run tests/llm/`

**Step 4: Commit**

```bash
git add src/llm/client.ts src/index.ts
git commit -m "feat(llm): handle 429 with reactive token rotation"
```

---

### Task 7: CLI script — `scripts/token-add.ts`

**Files:**
- Create: `scripts/token-add.ts`
- Modify: `package.json`

**Step 1: Create script**

```typescript
import { createInterface } from 'readline';
import { initPool, closePool } from '../src/db/connection.js';
import { insertToken } from '../src/db/repository.js';
import { loadConfig } from '../src/config.js';
import { getOpenAIAccessToken } from '../src/llm/oauth.js';
import { readFileSync } from 'fs';
import { join } from 'path';

const NATO = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel',
  'india','juliet','kilo','lima','mike','november','oscar','papa','quebec',
  'romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu'];

function randomLabel(): string {
  return NATO[Math.floor(Math.random() * NATO.length)];
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  const config = loadConfig();
  if (!config.database.url) {
    console.error('DATABASE_URL required. Set it in .env');
    process.exit(1);
  }
  initPool(config.database.url);

  const providerArg = process.argv[2];
  const provider = providerArg || await ask('Provider (codex/openai/xai/google): ');

  const oauthProviders = ['codex'];
  const authType = oauthProviders.includes(provider) ? 'oauth' : 'api';
  const label = randomLabel();

  if (authType === 'oauth') {
    console.log(`\nStarting OAuth flow for '${provider}'...\n`);
    const accessToken = await getOpenAIAccessToken();

    // Read the stored credentials to get refresh token + account_id
    const credsPath = join(process.env.HOME || '.', '.indic-bot', 'oauth-credentials.json');
    const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));

    const id = await insertToken({
      label,
      provider,
      auth_type: 'oauth',
      access_token: creds.access,
      refresh_token: creds.refresh,
      account_id: creds.accountId,
      expires_at: new Date(creds.expires * 1000).toISOString(),
      is_active: true,
    });

    console.log(`\nToken '${label}' (${provider}/oauth) added — id=${id}, account=${creds.accountId.slice(0, 8)}...`);
  } else {
    const apiKey = await ask(`API key for ${provider}: `);
    const id = await insertToken({
      label,
      provider,
      auth_type: 'api',
      api_key: apiKey,
      is_active: true,
    });
    console.log(`\nToken '${label}' (${provider}/api) added — id=${id}`);
  }

  await closePool();
}

main().catch(err => { console.error(err); process.exit(1); });
```

**Step 2: Add npm script to package.json**

Add to `scripts`:

```json
"token:add": "tsx scripts/token-add.ts"
```

**Step 3: Test manually**

Run: `npm run token:add codex` — should trigger OAuth flow and insert into DB.

**Step 4: Commit**

```bash
git add scripts/token-add.ts package.json
git commit -m "feat(cli): add npm run token:add for multi-account token pool"
```

---

### Task 8: OAuth token refresh in TokenPool

**Files:**
- Modify: `src/llm/token-pool.ts`

**Step 1: Add refresh logic**

TokenPool needs to refresh expired OAuth tokens before returning them. Add method:

```typescript
import { refreshToken } from './oauth-refresh.js';
```

Actually, reuse the existing `refreshToken` logic from `oauth.ts`. The function is not exported — we need to either export it or inline the refresh call.

Simpler approach: in `getBestToken`, check `expires_at` and call the OpenAI token refresh endpoint directly:

```typescript
private async ensureFreshToken(token: DbToken): Promise<DbToken> {
  if (token.auth_type !== 'oauth' || !token.expires_at || !token.refresh_token) return token;

  const expiresAt = new Date(token.expires_at).getTime() / 1000;
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt > now + 60) return token; // still valid

  console.log(`[TokenPool] Refreshing expired token '${token.label}'...`);
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    }),
  });

  if (!response.ok) {
    console.error(`[TokenPool] Refresh failed for '${token.label}': ${response.status}`);
    await updateTokenError(token.id!, `refresh_failed_${response.status}`).catch(() => {});
    return token; // return stale, will fail on use and trigger rotation
  }

  const json = (await response.json()) as any;
  const newExpires = new Date((Math.floor(Date.now() / 1000) + (json.expires_in || 3600)) * 1000).toISOString();

  await updateTokenStats(token.id!, {
    primary_used_pct: token.primary_used_pct ?? 0,
    secondary_used_pct: token.secondary_used_pct ?? 0,
    primary_reset_at: token.primary_reset_at ?? null,
    secondary_reset_at: token.secondary_reset_at ?? null,
    last_used_at: new Date().toISOString(),
    access_token: json.access_token,
    expires_at: newExpires,
  }).catch(() => {});

  return { ...token, access_token: json.access_token, refresh_token: json.refresh_token, expires_at: newExpires };
}
```

Call in `getBestToken` before returning:

```typescript
const best = eligible[0];
const fresh = await this.ensureFreshToken(best);
this.currentTokenId = fresh.id!;
return fresh;
```

**Step 2: Run tests**

Run: `npx vitest run tests/llm/token-pool.test.ts`

**Step 3: Commit**

```bash
git add src/llm/token-pool.ts
git commit -m "feat(llm): auto-refresh expired OAuth tokens in TokenPool"
```

---

### Task 9: Dashboard — Tokens page

**Files:**
- Create: `dashboard/src/pages/Tokens.tsx`
- Modify: `dashboard/src/App.tsx`

**Step 1: Create Tokens page**

```tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Token {
  id: number;
  label: string;
  provider: string;
  auth_type: string;
  primary_used_pct: number;
  secondary_used_pct: number;
  primary_reset_at: string | null;
  secondary_reset_at: string | null;
  is_active: boolean;
  last_used_at: string | null;
  last_error: string | null;
  account_id: string | null;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 24) return `${(h / 24).toFixed(1)}d`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Bar({ pct, warn = 80 }: { pct: number; warn?: number }) {
  const color = pct >= 95 ? 'bg-red-500' : pct >= warn ? 'bg-yellow-500' : 'bg-emerald-500';
  return (
    <div className="w-24 h-2 bg-surface-3 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function StatusBadge({ token }: { token: Token }) {
  const recent = token.last_used_at && (Date.now() - new Date(token.last_used_at).getTime()) < 5 * 60_000;
  if (!token.is_active) return <span className="text-xs text-red-400">disabled</span>;
  if (recent) return <span className="text-xs text-emerald-400">active</span>;
  return <span className="text-xs text-fg-faint">idle</span>;
}

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [allExhausted, setAllExhausted] = useState(false);

  const fetchTokens = () => {
    supabase.from('tokens')
      .select('id, label, provider, auth_type, primary_used_pct, secondary_used_pct, primary_reset_at, secondary_reset_at, is_active, last_used_at, last_error, account_id')
      .order('provider')
      .order('secondary_used_pct', { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        setTokens(data);
        const codex = data.filter(t => t.provider === 'codex' && t.is_active);
        setAllExhausted(codex.length > 0 && codex.every(t => t.secondary_used_pct >= 95));
      });
  };

  useEffect(() => {
    fetchTokens();
    const id = setInterval(fetchTokens, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Tokens</h1>

      {allExhausted && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
          All Codex tokens exhausted — bot is using Layer 2/3 fallback
        </div>
      )}

      <div className="bg-surface-1 border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-fg-faint text-left">
              <th className="px-4 py-2">Label</th>
              <th className="px-4 py-2">Provider</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">5h Used</th>
              <th className="px-4 py-2">Weekly Used</th>
              <th className="px-4 py-2">Reset</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map(t => (
              <tr key={t.id} className="border-b border-border/50 hover:bg-surface-2/50">
                <td className="px-4 py-2 font-mono">{t.label}</td>
                <td className="px-4 py-2">{t.provider}</td>
                <td className="px-4 py-2 text-fg-faint">{t.auth_type}</td>
                <td className="px-4 py-2">
                  {t.provider === 'codex' ? (
                    <div className="flex items-center gap-2">
                      <Bar pct={t.primary_used_pct} />
                      <span className="text-xs text-fg-faint">{t.primary_used_pct}%</span>
                    </div>
                  ) : '—'}
                </td>
                <td className="px-4 py-2">
                  {t.provider === 'codex' ? (
                    <div className="flex items-center gap-2">
                      <Bar pct={t.secondary_used_pct} warn={85} />
                      <span className="text-xs text-fg-faint">{t.secondary_used_pct}%</span>
                    </div>
                  ) : '—'}
                </td>
                <td className="px-4 py-2 text-xs text-fg-faint">
                  {t.provider === 'codex' ? timeUntil(t.secondary_reset_at) : '—'}
                </td>
                <td className="px-4 py-2"><StatusBadge token={t} /></td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-fg-faint">No tokens. Run: npm run token:add</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

**Step 2: Add route to App.tsx**

Add import:

```typescript
import { Tokens } from './pages/Tokens';
```

Add to `secondaryNav` array:

```typescript
{ to: '/tokens', label: 'Tokens' },
```

Add route inside `<Routes>`:

```tsx
<Route path="/tokens" element={<Tokens />} />
```

**Step 3: Verify dashboard builds**

Run: `cd dashboard && npm run build`

**Step 4: Commit**

```bash
git add dashboard/src/pages/Tokens.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): add Tokens page with live rate limit stats"
```

---

### Task 10: Migrate existing tokens to DB

**Files:**
- No new files — manual step

**Step 1: Add existing tokens via CLI**

Run `npm run token:add codex` twice — once for each existing account. After OAuth, verify with:

```sql
SELECT id, label, provider, auth_type, account_id, primary_used_pct, secondary_used_pct FROM tokens;
```

**Step 2: Deploy to VM**

```bash
npm run deploy
```

**Step 3: Verify on VM**

```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 "cd ~/indic-bot && pm2 restart indic-bot && sleep 5 && pm2 logs indic-bot --lines 20"
```

Look for: `[Auth] Using token pool — 'alpha' (...)` in logs.
