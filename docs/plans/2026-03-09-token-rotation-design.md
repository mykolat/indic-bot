# Token Rotation & Multi-Account Pool

**Date:** 2026-03-09
**Status:** Approved

## Problem

Codex API (ChatGPT OAuth) has 5-hour and weekly rate limits per account. Bot runs 24/7 and can exhaust a single account's weekly limit. Need to rotate across multiple accounts and show usage stats in dashboard.

## Design

### DB Schema — `tokens` table

```sql
CREATE TABLE tokens (
  id                  SERIAL PRIMARY KEY,
  label               TEXT NOT NULL,
  provider            TEXT NOT NULL,              -- 'codex', 'openai', 'xai', 'google'
  auth_type           TEXT NOT NULL DEFAULT 'api',-- 'api' | 'oauth'

  -- API tokens
  api_key             TEXT,

  -- OAuth tokens
  access_token        TEXT,
  refresh_token       TEXT,
  account_id          TEXT,
  expires_at          TIMESTAMPTZ,

  -- Rate limit stats (codex only, from x-codex-* headers)
  primary_used_pct    SMALLINT DEFAULT 0,         -- 5h window %
  secondary_used_pct  SMALLINT DEFAULT 0,         -- weekly %
  primary_reset_at    TIMESTAMPTZ,
  secondary_reset_at  TIMESTAMPTZ,

  -- State
  is_active           BOOLEAN DEFAULT true,
  last_used_at        TIMESTAMPTZ,
  last_error          TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);
```

### Token Pool — `src/llm/token-pool.ts`

```
TokenPool class:
  - loadTokens(provider)        — SELECT from tokens WHERE provider AND is_active
  - getBestToken('codex')       — pick token with lowest secondary_used_pct
                                  where primary < 90% AND secondary < 95%
  - updateStats(tokenId, headers) — parse x-codex-* headers, UPDATE DB
  - rotateOnError(tokenId)      — mark last_error, pick next token
  - refreshOAuthToken(tokenId)  — refresh if expires_at < now+60s
```

**Selection logic:**
1. Filter: `is_active=true`, `secondary_used_pct < 95`, `primary_used_pct < 90`
2. Sort: `secondary_used_pct ASC` (freshest weekly first)
3. If all exhausted → return `null` → Layer 2/3 fallback + alert

**Rotation triggers:**
- Proactive: `primary_used_pct > 80%` or `secondary_used_pct > 85%` after stats update
- Reactive: 429 error → immediate rotation

### CLI — `npm run token:add`

```
scripts/token-add.ts:
  1. Read provider from args (codex/openai/xai/google) or ask interactively
  2. If auth_type='oauth': run OAuth flow (reuse oauth.ts), get access+refresh+accountId
  3. If auth_type='api': read API key from stdin
  4. Generate random NATO label (alpha, bravo, charlie...)
  5. INSERT into tokens table
  6. Print confirmation
```

Usage:
```bash
npm run token:add              # interactive
npm run token:add codex        # OAuth flow for codex
npm run token:add xai          # asks for API key
```

### Changes to Existing Code

**`client.ts`** — minimal:
- `streamSSE()` returns additional `rateLimitHeaders` from `x-codex-*` response headers
- New getter `lastRateLimitHeaders` for pool to read after request

**`index.ts`** — replace token flow:
- Before: `getOpenAIAccessToken()` → single token, refresh each cycle
- After: `TokenPool.getBestToken('codex')` → best available token from DB
- Each cycle: update stats from headers → rotate if threshold exceeded → `llm.updateAccessToken()`

**`oauth.ts`** — no changes, reused by `token-add.ts`

**Fallback:** if `getBestToken()` returns null → standard Layer 2/3 + alert row in DB

### Dashboard — `dashboard/src/pages/Tokens.tsx`

Table with columns: Label, Provider, Type, 5h Used, Weekly Used, Reset, Status

- Auto-refresh every 60s via Supabase REST
- `active` = last_used_at < 5 min ago
- Red alert banner when all codex tokens exhausted
- Progress bars for 5h/weekly usage

## Files to Create/Modify

**New:**
- `src/llm/token-pool.ts` — TokenPool class
- `scripts/token-add.ts` — CLI for adding tokens
- `dashboard/src/pages/Tokens.tsx` — dashboard page

**Modified:**
- `src/llm/client.ts` — parse + expose rate limit headers
- `src/index.ts` — replace single-token flow with TokenPool
- `src/db/repository.ts` — token CRUD functions
- `src/db/types.ts` — DbToken interface
- `package.json` — add `token:add` script
- `dashboard/src/App.tsx` — add Tokens route
