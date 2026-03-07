# EPIC: Tiered Intelligence v3 Implementation Plan (#21)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Strategic (3x/day) and Tactical (1x/hour) intelligence tiers that constrain the Execution loop.

**Architecture:** Three new classes: `StrategicSession` outputs `DailyDirective`, `TacticalSession` outputs `HourlyPlan`, `TieredScheduler` coordinates when each runs. Brain (`TradingLoop.runOnce()`) becomes Tier 3 and operates within directive/plan constraints. Controlled by `tiered.enabled` config flag.

**Tech Stack:** TypeScript ESM, PostgreSQL (Supabase), GPT + Grok, Vitest

**Design doc:** `docs/plans/2026-03-06-tiered-intelligence-design.md`

---

### Task 1: DB Schema + Types + Repository

**Files:**
- Modify: `src/db/types.ts` (add 3 interfaces)
- Modify: `src/db/repository.ts` (add insert/query methods)
- Migration: Supabase SQL

**Step 1: Add types**

Add to `src/db/types.ts`:
```typescript
export interface DbDailyDirective {
  id?: string;
  session_id?: string;
  allowed_pairs: string[];
  pair_bias: Record<string, string>;
  max_exposure_pct: number;
  risk_appetite: string;
  banned_pairs: string[];
  key_levels: Record<string, { support: number[]; resistance: number[] }>;
  reasoning: string;
  valid_until?: string;
  created_at?: string;
}

export interface DbHourlyPlan {
  id?: string;
  directive_id?: string;
  session_id?: string;
  watchlist: string[];
  entry_zones: Record<string, { min: number; max: number; bias: string }>;
  position_notes: Record<string, string>;
  escalate_daily: boolean;
  reasoning: string;
  created_at?: string;
}

export interface DbExpertCall {
  id?: number;
  cycle_id?: number;
  tier: string;
  expert_name: string;
  llm_provider: string;
  input_tokens?: number;
  output_tokens?: number;
  result?: any;
  latency_ms?: number;
  created_at?: string;
}
```

**Step 2: Add repository methods**

Add to `src/db/repository.ts`:
```typescript
export async function insertDailyDirective(d: Omit<DbDailyDirective, 'id' | 'created_at'>): Promise<string> {
  const { rows } = await query(
    `INSERT INTO daily_directives (session_id, allowed_pairs, pair_bias, max_exposure_pct, risk_appetite, banned_pairs, key_levels, reasoning, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [d.session_id, d.allowed_pairs, JSON.stringify(d.pair_bias), d.max_exposure_pct, d.risk_appetite, d.banned_pairs, JSON.stringify(d.key_levels), d.reasoning, d.valid_until],
  );
  return rows[0].id;
}

export async function getLatestDirective(sessionId: string): Promise<DbDailyDirective | null> {
  const { rows } = await query(
    `SELECT * FROM daily_directives WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

export async function insertHourlyPlan(p: Omit<DbHourlyPlan, 'id' | 'created_at'>): Promise<string> {
  const { rows } = await query(
    `INSERT INTO hourly_plans (directive_id, session_id, watchlist, entry_zones, position_notes, escalate_daily, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [p.directive_id, p.session_id, p.watchlist, JSON.stringify(p.entry_zones), JSON.stringify(p.position_notes), p.escalate_daily, p.reasoning],
  );
  return rows[0].id;
}

export async function getLatestHourlyPlan(sessionId: string): Promise<DbHourlyPlan | null> {
  const { rows } = await query(
    `SELECT * FROM hourly_plans WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

export async function insertExpertCall(e: Omit<DbExpertCall, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await query(
    `INSERT INTO expert_calls (cycle_id, tier, expert_name, llm_provider, input_tokens, output_tokens, result, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [e.cycle_id, e.tier, e.expert_name, e.llm_provider, e.input_tokens, e.output_tokens, JSON.stringify(e.result), e.latency_ms],
  );
  return rows[0].id;
}
```

**Step 3: Apply Supabase migration**

```sql
CREATE TABLE daily_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID,
  allowed_pairs TEXT[] NOT NULL,
  pair_bias JSONB NOT NULL DEFAULT '{}',
  max_exposure_pct NUMERIC NOT NULL DEFAULT 150,
  risk_appetite TEXT NOT NULL DEFAULT 'normal',
  banned_pairs TEXT[] DEFAULT '{}',
  key_levels JSONB DEFAULT '{}',
  reasoning TEXT,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE hourly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  directive_id UUID REFERENCES daily_directives(id),
  session_id UUID,
  watchlist TEXT[] NOT NULL,
  entry_zones JSONB DEFAULT '{}',
  position_notes JSONB DEFAULT '{}',
  escalate_daily BOOLEAN DEFAULT FALSE,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE expert_calls (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT,
  tier TEXT NOT NULL,
  expert_name TEXT NOT NULL,
  llm_provider TEXT NOT NULL,
  input_tokens INT,
  output_tokens INT,
  result JSONB,
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Step 4: Commit**
```bash
git add src/db/types.ts src/db/repository.ts
git commit -m "feat(db): add tiered intelligence tables -- directives, plans, expert_calls (#21)"
```

---

### Task 2: StrategicSession (Tier 1)

**Files:**
- Create: `src/sessions/strategic-session.ts`
- Create: `src/sessions/types.ts`
- Test: `tests/sessions/strategic-session.test.ts`

**Step 1: Create types**

Create `src/sessions/types.ts`:
```typescript
import type { DbDailyDirective, DbHourlyPlan } from '../db/types.js';

export type DailyDirective = DbDailyDirective;
export type HourlyPlan = DbHourlyPlan;

export interface SessionDeps {
  llm: { call: (system: string, user: string) => Promise<string> };
  grok?: { call: (system: string, user: string) => Promise<string> };
  sessionId: string;
  pairs: string[];
}

export interface MarketContext {
  regimes: Record<string, { regime: string; confidence: number }>;
  fearGreed: { value: number; label: string };
  macroSummary?: string;
  newsSummary?: string;
  memoryContent?: string;
  portfolioSummary?: string;
}
```

**Step 2: Create StrategicSession**

Create `src/sessions/strategic-session.ts`:
```typescript
import type { SessionDeps, MarketContext, DailyDirective } from './types.js';
import { insertDailyDirective, insertExpertCall } from '../db/repository.js';

export class StrategicSession {
  constructor(private deps: SessionDeps) {}

  async run(ctx: MarketContext): Promise<DailyDirective> {
    const experts: Array<{ name: string; provider: 'gpt' | 'grok'; prompt: string }> = [
      {
        name: 'strategist',
        provider: 'gpt',
        prompt: `You are a crypto strategist. Analyze the market and output a DailyDirective as JSON.\n\nMarket: ${JSON.stringify(ctx)}\nPairs: ${this.deps.pairs.join(', ')}\n\nOutput JSON: { allowed_pairs: string[], pair_bias: {pair: "bullish"|"bearish"|"neutral"}, max_exposure_pct: number, risk_appetite: "conservative"|"normal"|"aggressive", banned_pairs: string[], key_levels: {pair: {support: number[], resistance: number[]}}, reasoning: string }`,
      },
      {
        name: 'risk_assessor',
        provider: 'gpt',
        prompt: `You are a risk manager. Review market conditions and recommend risk appetite and exposure limits.\n\nMarket: ${JSON.stringify(ctx)}\n\nOutput JSON: { risk_appetite: string, max_exposure_pct: number, banned_pairs: string[], reasoning: string }`,
      },
    ];

    if (this.deps.grok) {
      experts.push({
        name: 'grok_sentinel',
        provider: 'grok',
        prompt: `Crypto market right now. What's the mood on X/Twitter? Any fear events or unusual narratives?\n\nOutput JSON: { mood: string, fear_events: string[], narratives: string[], unusual: string[], reasoning: string }`,
      });
    }

    const results = await Promise.allSettled(
      experts.map(async (expert) => {
        const start = Date.now();
        const llm = expert.provider === 'grok' && this.deps.grok ? this.deps.grok : this.deps.llm;
        const raw = await llm.call(expert.prompt, 'Provide your analysis as JSON.');
        const latency = Date.now() - start;

        insertExpertCall({
          tier: 'strategic',
          expert_name: expert.name,
          llm_provider: expert.provider,
          result: raw,
          latency_ms: latency,
        }).catch(() => {});

        return { name: expert.name, raw };
      }),
    );

    const directive = this.aggregateDirective(results, ctx);
    directive.session_id = this.deps.sessionId;
    directive.valid_until = new Date(Date.now() + 8 * 3600_000).toISOString();
    await insertDailyDirective(directive).catch(() => {});

    console.log(`[Strategic] Directive: ${directive.allowed_pairs.length} pairs, risk=${directive.risk_appetite}, exposure=${directive.max_exposure_pct}%`);
    return directive;
  }

  private aggregateDirective(
    results: PromiseSettledResult<{ name: string; raw: string }>[],
    ctx: MarketContext,
  ): DailyDirective {
    const directive: DailyDirective = {
      allowed_pairs: this.deps.pairs,
      pair_bias: {},
      max_exposure_pct: 150,
      risk_appetite: 'normal',
      banned_pairs: [],
      key_levels: {},
      reasoning: '',
    };

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      try {
        const json = JSON.parse(r.value.raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
        if (r.value.name === 'strategist') {
          if (json.allowed_pairs) directive.allowed_pairs = json.allowed_pairs;
          if (json.pair_bias) directive.pair_bias = json.pair_bias;
          if (json.key_levels) directive.key_levels = json.key_levels;
          if (json.reasoning) directive.reasoning = json.reasoning;
        }
        if (r.value.name === 'risk_assessor') {
          if (json.risk_appetite) directive.risk_appetite = json.risk_appetite;
          if (json.max_exposure_pct) directive.max_exposure_pct = json.max_exposure_pct;
          if (json.banned_pairs) directive.banned_pairs = json.banned_pairs;
        }
        if (r.value.name === 'grok_sentinel' && json.fear_events?.length > 0) {
          directive.risk_appetite = 'conservative';
          directive.reasoning += ` | Grok sentinel: ${json.fear_events.join(', ')}`;
        }
      } catch { /* ignore parse errors */ }
    }

    return directive;
  }
}
```

**Step 3: Write tests, run, commit**

Test file `tests/sessions/strategic-session.test.ts` should mock LLM calls and verify directive output structure.

```bash
git add src/sessions/types.ts src/sessions/strategic-session.ts tests/sessions/strategic-session.test.ts
git commit -m "feat(sessions): StrategicSession -- Tier 1 daily directive (#21)"
```

---

### Task 3: TacticalSession (Tier 2)

**Files:**
- Create: `src/sessions/tactical-session.ts`
- Test: `tests/sessions/tactical-session.test.ts`

Same pattern as StrategicSession but:
- Reads DailyDirective as input constraint
- Runs 2 experts: GPT analyst + Grok challenger
- Outputs HourlyPlan (watchlist, entry_zones, position_notes, escalate_daily)
- Budget: up to 8 LLM calls

```bash
git commit -m "feat(sessions): TacticalSession -- Tier 2 hourly plan (#21)"
```

---

### Task 4: Constraint Injection into Brain

**Files:**
- Modify: `src/llm/prompts.ts` (add directive/plan sections to EnrichedPromptData)
- Modify: `src/trading-loop.ts` (read directive/plan, inject, filter banned pairs)

**Step 1: Extend EnrichedPromptData**

Add to the `EnrichedPromptData` interface in `src/llm/prompts.ts`:
```typescript
  dailyDirective?: {
    allowed_pairs: string[];
    pair_bias: Record<string, string>;
    risk_appetite: string;
    banned_pairs: string[];
    key_levels: Record<string, { support: number[]; resistance: number[] }>;
  };
  hourlyPlan?: {
    watchlist: string[];
    entry_zones: Record<string, { min: number; max: number; bias: string }>;
    position_notes: Record<string, string>;
  };
```

**Step 2: Add to prompt assembly**

In `buildEnrichedPrompt()`, add sections:
```typescript
  if (data.dailyDirective) {
    parts.push(`\n## Strategic Directive (Tier 1)\nAllowed pairs: ${data.dailyDirective.allowed_pairs.join(', ')}\nBanned: ${data.dailyDirective.banned_pairs.join(', ') || 'none'}\nRisk appetite: ${data.dailyDirective.risk_appetite}\nPair bias: ${JSON.stringify(data.dailyDirective.pair_bias)}`);
  }
  if (data.hourlyPlan) {
    parts.push(`\n## Tactical Plan (Tier 2)\nWatchlist: ${data.hourlyPlan.watchlist.join(', ')}\nEntry zones: ${JSON.stringify(data.hourlyPlan.entry_zones)}\nNotes: ${JSON.stringify(data.hourlyPlan.position_notes)}`);
  }
```

**Step 3: Filter banned pairs in TradingLoop**

In `src/trading-loop.ts`, after decisions are received, filter out banned pair decisions:
```typescript
  if (directive?.banned_pairs?.length) {
    decisions = decisions.filter(d =>
      d.action === 'CLOSE' || d.action === 'HOLD' || !directive.banned_pairs.includes(d.pair)
    );
  }
```

```bash
git commit -m "feat(prompts): inject directive and plan constraints into Brain (#21)"
```

---

### Task 5: TieredScheduler

**Files:**
- Create: `src/sessions/scheduler.ts`
- Test: `tests/sessions/scheduler.test.ts`

**Core logic:**
```typescript
export class TieredScheduler {
  private lastStrategic = 0;
  private lastTactical = 0;
  private strategicIntervalMs = 8 * 3600_000; // 3x/day = every 8h
  private tacticalIntervalMs = 3600_000;       // 1x/hour

  shouldRunStrategic(): boolean {
    return Date.now() - this.lastStrategic >= this.strategicIntervalMs;
  }

  shouldRunTactical(): boolean {
    return Date.now() - this.lastTactical >= this.tacticalIntervalMs;
  }

  markStrategicDone(): void { this.lastStrategic = Date.now(); }
  markTacticalDone(): void { this.lastTactical = Date.now(); }

  escalateToTactical(): void { this.lastTactical = 0; }
  escalateToStrategic(): void { this.lastStrategic = 0; }
}
```

```bash
git commit -m "feat(sessions): TieredScheduler -- cron-like tier coordination (#21)"
```

---

### Task 6: Escalation Logic

**Files:**
- Modify: `src/watchdog.ts` (anomaly -> escalate to tactical)
- Modify: `src/trading-loop.ts` (regime shift -> escalate)

Watchdog anomaly callback calls `scheduler.escalateToTactical()`.
Brain detects regime shift -> calls `scheduler.escalateToStrategic()`.
TacticalSession `escalate_daily: true` -> calls `scheduler.escalateToStrategic()`.

```bash
git commit -m "feat(sessions): escalation logic -- anomaly and regime triggers (#21)"
```

---

### Task 7: Wire into index.ts

**Files:**
- Modify: `src/index.ts` (instantiate sessions, scheduler, integrate into cycle runner)
- Modify: `config.yaml` (add `tiered.enabled: false`)

Add to the cycle runner:
```typescript
const runCycle = async () => {
  if (config.tiered?.enabled) {
    if (scheduler.shouldRunStrategic()) {
      directive = await strategicSession.run(marketContext);
      scheduler.markStrategicDone();
    }
    if (scheduler.shouldRunTactical()) {
      plan = await tacticalSession.run(directive, marketContext);
      scheduler.markTacticalDone();
      if (plan.escalate_daily) scheduler.escalateToStrategic();
    }
  }
  // Existing Brain loop -- now with directive/plan context
  await loop.runOnce(/* pass directive, plan */);
};
```

```bash
git commit -m "feat(sessions): wire tiered intelligence into main loop (#21)"
```

---

## Verification

1. `npx vitest run tests/sessions/` -- all session tests pass
2. `npx vitest run` -- full suite passes
3. `tiered.enabled: false` -- existing behavior unchanged
4. `tiered.enabled: true` -- strategic runs on startup, tactical every hour, Brain every 10 min
5. Dashboard: `daily_directives` and `hourly_plans` tables populated

---

## File Overlap Matrix

| File | #31 | #21 |
|------|-----|-----|
| `src/binance/orders.ts` | X | |
| `config.yaml` | X | X |
| `src/config.ts` | X | X |
| `src/index.ts` | X | X |
| `src/db/types.ts` | | X |
| `src/db/repository.ts` | | X |
| `src/trading-loop.ts` | | X |
| `src/llm/prompts.ts` | | X |
| `src/sessions/*.ts` | | X (new) |

**No file conflicts** -- #31 and #21 can be implemented in parallel.

## Execution Order

**#31 (3 tasks):** Task 1 -> Task 2 -> Task 3

**#21 (7 tasks):** Task 1 -> Tasks 2+3 (parallel) -> Task 4 -> Task 5 -> Task 6 -> Task 7
