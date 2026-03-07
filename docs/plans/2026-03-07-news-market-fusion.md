# News-Market Fusion Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the news pipeline with watchdog market data so Chief Architect sees pre-correlated "event + market reaction" context instead of two separate text blocks.

**Architecture:** Three layers built bottom-up: (1) algorithmic Market Reaction Check that computes price/OI/volume displacement after news events, (2) enriched Grounder output with claim taxonomy and tradability, (3) News-Market Fusion block in prompt that correlates news signals with watchdog snapshots. Also wires liquidation data (already collected, never surfaced) into the prompt.

**Tech Stack:** TypeScript ESM, Vitest, PostgreSQL (Supabase), xAI Grok API

**Key files reference:**
- News pipeline: `src/news/grok-grounder.ts`, `src/news/news-analyst.ts`, `src/news/news-cache.ts`
- Prompt builder: `src/llm/prompts.ts` (EnrichedPromptData interface at line 121, buildEnrichedPrompt at line 213)
- Trading loop: `src/trading-loop.ts` (grounding at lines 436-462, watchdog summary at lines 587-603)
- Watchdog data: `src/watchdog-summary.ts`, `src/db/repository.ts` (getMarketSnapshotsSince at line 311, getRecentLiquidations at line 433)
- DB types: `src/db/types.ts` (DbMarketSnapshot at line 282, DbLiquidation at line 310)
- Market signals: `src/market/signals.ts`

---

### Task 1: Market Reaction Checker — module + tests

**Files:**
- Create: `src/news/market-reaction.ts`
- Create: `tests/news/market-reaction.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/news/market-reaction.test.ts
import { describe, it, expect } from 'vitest';
import { computeMarketReaction, type MarketReaction } from '../../src/news/market-reaction.js';
import type { DbMarketSnapshot } from '../../src/db/types.js';

function makeSnap(overrides: Partial<DbMarketSnapshot> & { created_at: string }): DbMarketSnapshot {
  return {
    pair: 'BTCUSDT',
    mark_price: 100000,
    open_interest: 5000000000,
    funding_rate: 0.0001,
    imbalance_pct: 0,
    ...overrides,
  };
}

describe('computeMarketReaction', () => {
  it('returns IGNORES when no price displacement', () => {
    const eventTime = '2026-03-07T10:00:00Z';
    const snapshots: DbMarketSnapshot[] = [
      makeSnap({ mark_price: 100000, open_interest: 5e9, created_at: '2026-03-07T09:55:00Z' }),
      makeSnap({ mark_price: 100050, open_interest: 5e9, created_at: '2026-03-07T10:05:00Z' }),
      makeSnap({ mark_price: 100020, open_interest: 5.01e9, created_at: '2026-03-07T10:10:00Z' }),
    ];
    const result = computeMarketReaction(snapshots, eventTime);
    expect(result.verdict).toBe('IGNORES');
    expect(result.priceDisplacementPct).toBeCloseTo(0.02, 1);
  });

  it('returns CONFIRMS when price moves in direction with volume', () => {
    const eventTime = '2026-03-07T10:00:00Z';
    const snapshots: DbMarketSnapshot[] = [
      makeSnap({ mark_price: 100000, open_interest: 5e9, created_at: '2026-03-07T09:55:00Z' }),
      makeSnap({ mark_price: 101500, open_interest: 5.3e9, created_at: '2026-03-07T10:05:00Z' }),
      makeSnap({ mark_price: 101800, open_interest: 5.4e9, created_at: '2026-03-07T10:15:00Z' }),
    ];
    const result = computeMarketReaction(snapshots, eventTime, 'bullish');
    expect(result.verdict).toBe('CONFIRMS');
    expect(result.priceDisplacementPct).toBeGreaterThan(1);
    expect(result.oiChangePct).toBeGreaterThan(5);
  });

  it('returns FADES when price moves opposite to claim direction', () => {
    const eventTime = '2026-03-07T10:00:00Z';
    const snapshots: DbMarketSnapshot[] = [
      makeSnap({ mark_price: 100000, open_interest: 5e9, created_at: '2026-03-07T09:55:00Z' }),
      makeSnap({ mark_price: 98500, open_interest: 4.7e9, created_at: '2026-03-07T10:10:00Z' }),
    ];
    const result = computeMarketReaction(snapshots, eventTime, 'bullish');
    expect(result.verdict).toBe('FADES');
  });

  it('returns IGNORES when no snapshots after event', () => {
    const eventTime = '2026-03-07T10:00:00Z';
    const snapshots: DbMarketSnapshot[] = [
      makeSnap({ mark_price: 100000, created_at: '2026-03-07T09:50:00Z' }),
    ];
    const result = computeMarketReaction(snapshots, eventTime);
    expect(result.verdict).toBe('IGNORES');
    expect(result.priceDisplacementPct).toBe(0);
  });

  it('detects funding shift', () => {
    const eventTime = '2026-03-07T10:00:00Z';
    const snapshots: DbMarketSnapshot[] = [
      makeSnap({ mark_price: 100000, funding_rate: 0.0001, created_at: '2026-03-07T09:55:00Z' }),
      makeSnap({ mark_price: 101200, funding_rate: -0.0003, created_at: '2026-03-07T10:10:00Z' }),
    ];
    const result = computeMarketReaction(snapshots, eventTime);
    expect(result.fundingFlipped).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/news/market-reaction.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/news/market-reaction.ts

import type { DbMarketSnapshot } from '../db/types.js';

export type MarketVerdict = 'CONFIRMS' | 'FADES' | 'IGNORES';

export interface MarketReaction {
  verdict: MarketVerdict;
  priceDisplacementPct: number;
  oiChangePct: number;
  fundingFlipped: boolean;
  imbalanceShift: number;  // delta in imbalance_pct
  summary: string;
}

const DISPLACEMENT_THRESHOLD = 0.5;  // 0.5% price move = significant

export function computeMarketReaction(
  snapshots: DbMarketSnapshot[],
  eventTime: string,
  claimDirection?: 'bullish' | 'bearish' | 'neutral',
): MarketReaction {
  const eventTs = new Date(eventTime).getTime();

  // Split into before/after event
  const before = snapshots.filter(s => new Date(s.created_at!).getTime() <= eventTs);
  const after = snapshots.filter(s => new Date(s.created_at!).getTime() > eventTs);

  const baseline = before.length > 0 ? before[before.length - 1] : snapshots[0];
  const latest = after.length > 0 ? after[after.length - 1] : null;

  if (!baseline || !latest) {
    return {
      verdict: 'IGNORES',
      priceDisplacementPct: 0,
      oiChangePct: 0,
      fundingFlipped: false,
      imbalanceShift: 0,
      summary: 'No market data after event',
    };
  }

  const basePrice = Number(baseline.mark_price);
  const latestPrice = Number(latest.mark_price);
  const priceDisplacementPct = ((latestPrice - basePrice) / basePrice) * 100;

  const baseOi = Number(baseline.open_interest ?? 0);
  const latestOi = Number(latest.open_interest ?? 0);
  const oiChangePct = baseOi > 0 ? ((latestOi - baseOi) / baseOi) * 100 : 0;

  const baseFunding = Number(baseline.funding_rate ?? 0);
  const latestFunding = Number(latest.funding_rate ?? 0);
  const fundingFlipped = baseFunding !== 0 && Math.sign(baseFunding) !== Math.sign(latestFunding);

  const baseImb = Number(baseline.imbalance_pct ?? 0);
  const latestImb = Number(latest.imbalance_pct ?? 0);
  const imbalanceShift = latestImb - baseImb;

  // Determine verdict
  const absPriceMove = Math.abs(priceDisplacementPct);
  let verdict: MarketVerdict = 'IGNORES';

  if (absPriceMove >= DISPLACEMENT_THRESHOLD) {
    const priceUp = priceDisplacementPct > 0;
    if (!claimDirection || claimDirection === 'neutral') {
      // No direction context — any significant move = market reacting
      verdict = 'CONFIRMS';
    } else {
      const claimBullish = claimDirection === 'bullish';
      verdict = (priceUp === claimBullish) ? 'CONFIRMS' : 'FADES';
    }
  }

  // Build summary
  const parts: string[] = [];
  const sign = priceDisplacementPct >= 0 ? '+' : '';
  parts.push(`price ${sign}${priceDisplacementPct.toFixed(2)}%`);
  if (Math.abs(oiChangePct) > 1) {
    const oiSign = oiChangePct >= 0 ? '+' : '';
    parts.push(`OI ${oiSign}${oiChangePct.toFixed(1)}%`);
  }
  if (fundingFlipped) parts.push('funding flipped');
  if (Math.abs(imbalanceShift) > 10) {
    parts.push(`OBI shift ${imbalanceShift > 0 ? '+' : ''}${imbalanceShift.toFixed(0)}%`);
  }

  return {
    verdict,
    priceDisplacementPct,
    oiChangePct,
    fundingFlipped,
    imbalanceShift,
    summary: `${verdict}: ${parts.join(', ')}`,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/news/market-reaction.test.ts`
Expected: all 5 tests PASS

**Step 5: Commit**

```bash
git add src/news/market-reaction.ts tests/news/market-reaction.test.ts
git commit -m "feat(news): add market reaction checker — algorithmic news-to-market correlation"
```

---

### Task 2: Enriched Grounder Output — richer taxonomy

**Files:**
- Modify: `src/news/grok-grounder.ts`
- Create: `tests/news/grok-grounder.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/news/grok-grounder.test.ts
import { describe, it, expect } from 'vitest';
import type { GroundingResult } from '../../src/news/grok-grounder.js';

describe('GroundingResult type', () => {
  it('has enriched fields', () => {
    const result: GroundingResult = {
      claim: 'BTC to 200k',
      verified: null,
      confidence: 0.3,
      summary: 'Unverified prediction',
      sources: ['@crypto_guru'],
      contradictions: [],
      tokensUsed: 500,
      claimType: 'prediction',
      tradability: 'none',
      sourceQuality: 'influencer',
    };
    expect(result.claimType).toBe('prediction');
    expect(result.tradability).toBe('none');
    expect(result.sourceQuality).toBe('influencer');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/news/grok-grounder.test.ts`
Expected: FAIL — `claimType` does not exist on type `GroundingResult`

**Step 3: Modify GroundingResult and GROUNDING_PROMPT in `src/news/grok-grounder.ts`**

Update the interface at line 24:
```typescript
export interface GroundingResult {
  claim: string;
  verified?: boolean | null;
  confidence?: number;
  summary?: string;
  sources?: string[];
  contradictions?: string[];
  tokensUsed: number;
  error?: string;
  // Enriched fields
  claimType?: 'rumor' | 'prediction' | 'official_event' | 'market_data' | 'exchange_incident' | 'regulatory' | 'influencer_noise';
  tradability?: 'none' | 'context_only' | 'watch' | 'actionable';
  sourceQuality?: 'official' | 'mainstream_media' | 'crypto_media' | 'influencer' | 'anonymous' | 'unknown';
}
```

Update the GROUNDING_PROMPT (line 5) — replace the existing JSON schema in the prompt:
```typescript
const GROUNDING_PROMPT = `You are a crypto news fact-checker with real-time X/Twitter access.
Given a claim about crypto markets, search X for verification.

Return ONLY valid JSON:
{
  "verified": true|false|null,
  "confidence": <0-1>,
  "summary": "1-2 sentences: what you found on X",
  "sources": ["@account1", "@account2"],
  "contradictions": ["any contradicting evidence"],
  "claim_type": "rumor|prediction|official_event|market_data|exchange_incident|regulatory|influencer_noise",
  "tradability": "none|context_only|watch|actionable",
  "source_quality": "official|mainstream_media|crypto_media|influencer|anonymous|unknown"
}

Rules:
- verified=true: multiple credible sources confirm
- verified=false: contradicted by official sources or clearly fake
- verified=null: insufficient data to determine
- confidence: 0=no data, 0.5=mixed signals, 1.0=certain
- sources: X accounts that discuss this claim
- claim_type: classify the nature of the claim
  - rumor: unattributed gossip or leak
  - prediction: price/market forecast (inherently non-verifiable)
  - official_event: announced by issuer/exchange/regulator
  - market_data: on-chain or market statistics
  - exchange_incident: hack, outage, withdrawal freeze
  - regulatory: SEC/CFTC/government action
  - influencer_noise: influencer opinion presented as news
- tradability: should this affect trading?
  - none: no trading relevance (prediction, old news, noise)
  - context_only: useful background, not actionable alone
  - watch: may become actionable, monitor closely
  - actionable: clear market-moving event, act now
- source_quality: credibility tier of the primary source
  - official: exchange, regulator, project team announcement
  - mainstream_media: Reuters, Bloomberg, WSJ
  - crypto_media: CoinDesk, CoinTelegraph, The Block
  - influencer: crypto twitter personality
  - anonymous: no attributable source
  - unknown: cannot determine`;
```

Update the `verify()` method to parse the new fields (after line 75):
```typescript
      const parsed = JSON.parse(jsonMatch[0]);
      this.sourceHealth?.recordSuccess('grok-grounder');
      return {
        claim,
        verified: parsed.verified,
        confidence: parsed.confidence,
        summary: parsed.summary,
        sources: parsed.sources,
        contradictions: parsed.contradictions,
        tokensUsed,
        claimType: parsed.claim_type,
        tradability: parsed.tradability,
        sourceQuality: parsed.source_quality,
      };
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/news/grok-grounder.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/news/grok-grounder.ts tests/news/grok-grounder.test.ts
git commit -m "feat(grounder): enrich GroundingResult with claimType, tradability, sourceQuality"
```

---

### Task 3: News-Market Fusion builder — correlate signals with snapshots

**Files:**
- Create: `src/news/news-market-fusion.ts`
- Create: `tests/news/news-market-fusion.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/news/news-market-fusion.test.ts
import { describe, it, expect } from 'vitest';
import { buildNewsMarketFusion, type FusionEntry } from '../../src/news/news-market-fusion.js';
import type { NewsSignal } from '../../src/news/news-cache.js';
import type { GroundingResult } from '../../src/news/grok-grounder.js';
import type { DbMarketSnapshot } from '../../src/db/types.js';

function makeSignal(overrides: Partial<NewsSignal> = {}): NewsSignal {
  return {
    coins: ['BTC'],
    direction: 'bullish',
    importance: 8,
    timeframe: 'short',
    catalyst: 'ETF approval rumor',
    reasoning: 'Multiple sources report',
    price_impact: 'high',
    expires_hours: 24,
    source_count: 3,
    conflicting: false,
    ...overrides,
  };
}

function makeSnap(price: number, oi: number, ts: string): DbMarketSnapshot {
  return { pair: 'BTCUSDT', mark_price: price, open_interest: oi, created_at: ts };
}

describe('buildNewsMarketFusion', () => {
  it('produces fusion entries correlating signals with market reaction', () => {
    const signals = [makeSignal()];
    const groundingResults = new Map<string, GroundingResult>([
      ['ETF approval rumor', { claim: 'ETF approval rumor', verified: null, confidence: 0.4, summary: 'Unconfirmed', tokensUsed: 100, claimType: 'rumor', tradability: 'watch', sourceQuality: 'crypto_media' }],
    ]);
    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['BTCUSDT', [
        makeSnap(100000, 5e9, '2026-03-07T09:55:00Z'),
        makeSnap(101200, 5.3e9, '2026-03-07T10:10:00Z'),
      ]],
    ]);

    const result = buildNewsMarketFusion(signals, groundingResults, snapshots, '2026-03-07T10:00:00Z');
    expect(result.length).toBe(1);
    expect(result[0].signal.catalyst).toBe('ETF approval rumor');
    expect(result[0].grounding?.claimType).toBe('rumor');
    expect(result[0].marketReaction.verdict).toBe('CONFIRMS');
  });

  it('formats fusion block as prompt text', () => {
    const signals = [makeSignal({ importance: 9, catalyst: 'SEC halt' })];
    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['BTCUSDT', [
        makeSnap(100000, 5e9, '2026-03-07T09:55:00Z'),
        makeSnap(97000, 4.5e9, '2026-03-07T10:10:00Z'),
      ]],
    ]);

    const entries = buildNewsMarketFusion(signals, new Map(), snapshots, '2026-03-07T10:00:00Z');
    const text = formatFusionBlock(entries);
    expect(text).toContain('SEC halt');
    expect(text).toContain('FADES');
  });

  it('returns empty array when no high-importance signals', () => {
    const signals = [makeSignal({ importance: 3 })];
    const result = buildNewsMarketFusion(signals, new Map(), new Map(), '2026-03-07T10:00:00Z');
    expect(result.length).toBe(0);
  });
});

// import separately to test formatting
import { formatFusionBlock } from '../../src/news/news-market-fusion.js';
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/news/news-market-fusion.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/news/news-market-fusion.ts

import type { NewsSignal } from './news-cache.js';
import type { GroundingResult } from './grok-grounder.js';
import type { DbMarketSnapshot } from '../db/types.js';
import { computeMarketReaction, type MarketReaction } from './market-reaction.js';

export interface FusionEntry {
  signal: NewsSignal;
  grounding: GroundingResult | undefined;
  marketReaction: MarketReaction;
  pair: string;
}

const MIN_IMPORTANCE = 5;  // Only correlate signals importance >= 5

export function buildNewsMarketFusion(
  signals: NewsSignal[],
  groundingResults: Map<string, GroundingResult>,
  pairSnapshots: Map<string, DbMarketSnapshot[]>,
  newsAnalyzedAt: string,
): FusionEntry[] {
  const entries: FusionEntry[] = [];

  for (const signal of signals) {
    if (signal.importance < MIN_IMPORTANCE) continue;

    const grounding = groundingResults.get(signal.catalyst);

    // Check market reaction for each coin mentioned
    for (const coin of signal.coins) {
      const pair = coin.endsWith('USDT') ? coin : `${coin}USDT`;
      const snapshots = pairSnapshots.get(pair) ?? [];

      const marketReaction = computeMarketReaction(
        snapshots,
        newsAnalyzedAt,
        signal.direction,
      );

      entries.push({ signal, grounding, marketReaction, pair });
    }

    // If no coins specified, check BTC as proxy
    if (signal.coins.length === 0) {
      const snapshots = pairSnapshots.get('BTCUSDT') ?? [];
      const marketReaction = computeMarketReaction(snapshots, newsAnalyzedAt, signal.direction);
      entries.push({ signal, grounding, marketReaction, pair: 'BTCUSDT' });
    }
  }

  return entries;
}

export function formatFusionBlock(entries: FusionEntry[]): string {
  if (entries.length === 0) return '';

  let block = '## Event Impact (news + market correlation)\n';

  for (const entry of entries) {
    const { signal, grounding, marketReaction, pair } = entry;

    block += `\n- "${signal.catalyst}" (importance ${signal.importance}, ${signal.direction})`;
    if (grounding) {
      const type = grounding.claimType ?? 'unknown';
      const trad = grounding.tradability ?? '?';
      const src = grounding.sourceQuality ?? '?';
      const ver = grounding.verified === true ? 'VERIFIED' :
                  grounding.verified === false ? 'DEBUNKED' : 'UNVERIFIED';
      block += `\n  Grounding: ${ver} (${type}, tradability: ${trad}, source: ${src})`;
      if (grounding.summary) block += `\n  "${grounding.summary}"`;
    }
    block += `\n  ${pair} reaction: ${marketReaction.summary}`;

    // Actionable interpretation
    if (grounding?.tradability === 'none' || grounding?.claimType === 'prediction') {
      block += `\n  >> NON-TRADABLE: ${grounding.claimType} — ignore for positioning`;
    } else if (marketReaction.verdict === 'CONFIRMS' && (grounding?.verified !== false)) {
      block += `\n  >> MARKET CONFIRMS — consider ${signal.direction} bias`;
    } else if (marketReaction.verdict === 'FADES') {
      block += `\n  >> MARKET FADES this claim — do NOT follow the narrative`;
    } else if (marketReaction.verdict === 'IGNORES') {
      block += `\n  >> MARKET IGNORES — no edge yet, watch only`;
    }
  }

  block += '\n';
  return block;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/news/news-market-fusion.test.ts`
Expected: all 3 tests PASS

**Step 5: Commit**

```bash
git add src/news/news-market-fusion.ts tests/news/news-market-fusion.test.ts
git commit -m "feat(news): news-market fusion builder — correlates signals with market reaction"
```

---

### Task 4: Wire liquidation data into prompt

**Files:**
- Modify: `src/llm/prompts.ts` (EnrichedPromptData + buildEnrichedPrompt)
- Create: `tests/llm/liquidation-prompt.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/llm/liquidation-prompt.test.ts
import { describe, it, expect } from 'vitest';

// We test that the prompt includes liquidation context when provided
// by importing the formatLiquidationBlock helper
import { formatLiquidationBlock } from '../../src/llm/prompts.js';
import type { DbLiquidation } from '../../src/db/types.js';

describe('formatLiquidationBlock', () => {
  it('formats liquidation data as prompt text', () => {
    const liqs: DbLiquidation[] = [
      { pair: 'BTCUSDT', long_liquidations: 150, short_liquidations: 30, long_liq_usd: 2500000, short_liq_usd: 400000, spike_ratio: 3.2, created_at: '2026-03-07T10:05:00Z' },
    ];
    const result = formatLiquidationBlock(liqs);
    expect(result).toContain('BTCUSDT');
    expect(result).toContain('$2.5M long liquidated');
    expect(result).toContain('spike 3.2x');
    expect(result).toContain('LONG SQUEEZE');
  });

  it('returns empty string when no liquidations', () => {
    expect(formatLiquidationBlock([])).toBe('');
  });

  it('labels SHORT SQUEEZE when shorts dominate', () => {
    const liqs: DbLiquidation[] = [
      { pair: 'ETHUSDT', long_liquidations: 20, short_liquidations: 200, long_liq_usd: 300000, short_liq_usd: 3000000, spike_ratio: 2.5, created_at: '2026-03-07T10:05:00Z' },
    ];
    const result = formatLiquidationBlock(liqs);
    expect(result).toContain('SHORT SQUEEZE');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/llm/liquidation-prompt.test.ts`
Expected: FAIL — `formatLiquidationBlock` not exported from prompts

**Step 3: Add to `src/llm/prompts.ts`**

Add the `DbLiquidation` import at the top of the file (around line 8):
```typescript
import type { DbLiquidation } from '../db/types.js';
```

Add the helper function (after the existing helper functions, around line 200):
```typescript
export function formatLiquidationBlock(liqs: DbLiquidation[]): string {
  if (liqs.length === 0) return '';

  let block = '## Recent Liquidations (last 15min)\n';
  // Group by pair
  const byPair = new Map<string, DbLiquidation[]>();
  for (const l of liqs) {
    const arr = byPair.get(l.pair) ?? [];
    arr.push(l);
    byPair.set(l.pair, arr);
  }

  for (const [pair, pairLiqs] of byPair) {
    const totalLongUsd = pairLiqs.reduce((s, l) => s + l.long_liq_usd, 0);
    const totalShortUsd = pairLiqs.reduce((s, l) => s + l.short_liq_usd, 0);
    const maxSpike = Math.max(...pairLiqs.map(l => l.spike_ratio));
    const label = totalLongUsd > totalShortUsd * 2 ? 'LONG SQUEEZE'
                : totalShortUsd > totalLongUsd * 2 ? 'SHORT SQUEEZE'
                : 'MIXED';
    const fmtUsd = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`;
    block += `${pair}: ${fmtUsd(totalLongUsd)} long liquidated, ${fmtUsd(totalShortUsd)} short liquidated | spike ${maxSpike.toFixed(1)}x | ${label}\n`;
  }

  return block;
}
```

Add `liquidations` field to `EnrichedPromptData` interface (around line 156, after `recentDecisions`):
```typescript
  liquidations?: DbLiquidation[];
```

Add `newsMarketFusion` field to `EnrichedPromptData`:
```typescript
  newsMarketFusion?: string;  // Pre-formatted fusion block
```

In `buildEnrichedPrompt()`, add the liquidation block after the watchdog summary section (after line 284):
```typescript
  if (data.liquidations?.length) {
    prompt += formatLiquidationBlock(data.liquidations);
    prompt += '\n';
  }
```

Add the fusion block right after liquidations:
```typescript
  if (data.newsMarketFusion) {
    prompt += data.newsMarketFusion;
    prompt += '\n';
  }
```

**Step 4: Run tests**

Run: `npx vitest run tests/llm/liquidation-prompt.test.ts`
Expected: all 3 tests PASS

Run: `npx vitest run tests/` (full suite to check nothing breaks)

**Step 5: Commit**

```bash
git add src/llm/prompts.ts tests/llm/liquidation-prompt.test.ts
git commit -m "feat(prompt): add liquidation context + news-market fusion to LLM prompt"
```

---

### Task 5: Wire everything into TradingLoop

**Files:**
- Modify: `src/trading-loop.ts`

This is the integration task — no new tests, relies on existing module tests.

**Step 1: Add imports at top of `src/trading-loop.ts`**

Around the existing imports (near line 32):
```typescript
import { buildNewsMarketFusion, formatFusionBlock } from './news/news-market-fusion.js';
import type { GroundingResult } from './news/grok-grounder.js';
```

Also import `getRecentLiquidations` from repository (check if already imported, add if not):
```typescript
import { getRecentLiquidations } from './db/repository.js';
```

**Step 2: Collect grounding results into a Map**

In the grounding section (~line 436-462), change the grounding loop to also store results in a Map for fusion:

After line 442 (`const verifiedEntries: ...`), add:
```typescript
            const groundingMap = new Map<string, import('./news/grok-grounder.js').GroundingResult>();
```

Inside the for-loop, after `verifiedEntries.push(...)` (after line 457), add:
```typescript
              groundingMap.set(signal.catalyst, gResult);
```

Move the `groundingMap` declaration BEFORE the `if (this.deps.grokGrounder)` block so it's accessible outside:
```typescript
          const groundingMap = new Map<string, import('./news/grok-grounder.js').GroundingResult>();
```

**Step 3: Build fusion block after news + grounding completes**

After the grounding section (after line 463, before `const cacheState`), add:
```typescript
          // Build news-market fusion
          let newsMarketFusionText: string | undefined;
          if (analysis.top_signals?.length) {
            try {
              const pairSnaps = new Map<string, import('./db/types.js').DbMarketSnapshot[]>();
              for (const pair of this.deps.pairs) {
                const snaps = await getMarketSnapshotsSince(pair, 15);
                if (snaps.length > 0) pairSnaps.set(pair, snaps);
              }
              const fusionEntries = buildNewsMarketFusion(
                analysis.top_signals,
                groundingMap,
                pairSnaps,
                new Date().toISOString(),
              );
              if (fusionEntries.length > 0) {
                newsMarketFusionText = formatFusionBlock(fusionEntries);
                console.log(`[NewsMarketFusion] ${fusionEntries.length} events correlated`);
              }
            } catch (e: any) {
              console.error('[NewsMarketFusion] Error:', e.message);
            }
          }
```

Store `newsMarketFusionText` as an instance variable so it persists to prompt building:
```typescript
          this.lastNewsMarketFusion = newsMarketFusionText;
```

Add the instance variable to the TradingLoop class (near other instance vars):
```typescript
  private lastNewsMarketFusion?: string;
```

**Step 4: Fetch liquidations before LLM call**

In the section where watchdog summary is built (~line 587-603), add after the watchdog summary block:
```typescript
      // Fetch recent liquidations
      let liquidations: import('./db/types.js').DbLiquidation[] = [];
      try {
        for (const pair of this.deps.pairs) {
          const pairLiqs = await getRecentLiquidations(pair, 15);
          liquidations.push(...pairLiqs);
        }
      } catch { /* DB optional */ }
```

**Step 5: Pass to prompt builder**

Find where `buildEnrichedPrompt()` is called (search for `buildEnrichedPrompt` in trading-loop.ts). Add the new fields to the data object:

```typescript
        liquidations: liquidations.length > 0 ? liquidations : undefined,
        newsMarketFusion: this.lastNewsMarketFusion,
```

**Step 6: Handle the duplicate grounding block**

There's a duplicate grounding section at lines 900-926 (the `shouldRefreshNews` second path). Apply the same `groundingMap` + fusion logic there, OR refactor both into a shared method. Simplest: extract grounding + fusion into a private method:

```typescript
  private async runGroundingAndFusion(
    analysis: import('./news/news-cache.js').NewsAnalysis,
  ): Promise<string | undefined> {
    const groundingMap = new Map<string, import('./news/grok-grounder.js').GroundingResult>();

    if (this.deps.grokGrounder && analysis.top_signals?.length) {
      const cfg = this.deps.groundingConfig ?? { minImportance: 7, maxPerCycle: 2 };
      const toGround = analysis.top_signals
        .filter(s => s.needs_grounding && s.importance >= cfg.minImportance)
        .slice(0, cfg.maxPerCycle);

      const verifiedEntries: Array<{ claim: string; verified: boolean | null | undefined; confidence: number | undefined; summary: string | undefined; timestamp: string }> = [];
      for (const signal of toGround) {
        const gResult = await this.deps.grokGrounder.verify(signal.catalyst);
        if (gResult.summary) {
          signal.reasoning += ` [Grok: ${gResult.summary.slice(0, 150)}]`;
        }
        if (this.deps.sourceHealth) {
          this.deps.sourceHealth.recordGrokUsage(gResult.tokensUsed);
        }
        groundingMap.set(signal.catalyst, gResult);
        verifiedEntries.push({
          claim: gResult.claim,
          verified: gResult.verified,
          confidence: gResult.confidence,
          summary: gResult.summary,
          timestamp: new Date().toISOString(),
        });
      }

      if (verifiedEntries.length > 0 && this.deps.memoryKeeper) {
        this.deps.memoryKeeper.writeVerifiedIntel(verifiedEntries);
      }
    }

    // Build fusion
    if (analysis.top_signals?.length) {
      try {
        const pairSnaps = new Map<string, import('./db/types.js').DbMarketSnapshot[]>();
        for (const pair of this.deps.pairs) {
          const snaps = await getMarketSnapshotsSince(pair, 15);
          if (snaps.length > 0) pairSnaps.set(pair, snaps);
        }
        const entries = buildNewsMarketFusion(
          analysis.top_signals,
          groundingMap,
          pairSnaps,
          new Date().toISOString(),
        );
        if (entries.length > 0) {
          console.log(`[NewsMarketFusion] ${entries.length} events correlated`);
          return formatFusionBlock(entries);
        }
      } catch (e: any) {
        console.error('[NewsMarketFusion] Error:', e.message);
      }
    }
    return undefined;
  }
```

Then replace both grounding blocks (lines 436-463 and 900-926) with:
```typescript
          this.lastNewsMarketFusion = await this.runGroundingAndFusion(analysis);
```

**Step 7: Verify build compiles**

Run: `npm run build`
Expected: no errors

**Step 8: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

**Step 9: Commit**

```bash
git add src/trading-loop.ts
git commit -m "feat(loop): wire news-market fusion + liquidation data into LLM prompt"
```

---

### Task 6: Integration test — full fusion flow

**Files:**
- Create: `tests/news/fusion-integration.test.ts`

**Step 1: Write integration test**

```typescript
// tests/news/fusion-integration.test.ts
import { describe, it, expect } from 'vitest';
import { computeMarketReaction } from '../../src/news/market-reaction.js';
import { buildNewsMarketFusion, formatFusionBlock } from '../../src/news/news-market-fusion.js';
import type { NewsSignal } from '../../src/news/news-cache.js';
import type { GroundingResult } from '../../src/news/grok-grounder.js';
import type { DbMarketSnapshot } from '../../src/db/types.js';

describe('Full fusion pipeline', () => {
  it('end-to-end: fake pump claim + market ignores = NON-TRADABLE', () => {
    const signals: NewsSignal[] = [{
      coins: ['BTC'],
      direction: 'bullish',
      importance: 8,
      timeframe: 'short',
      catalyst: 'Bitcoin +20k tomorrow',
      reasoning: 'Influencer prediction',
      price_impact: 'high',
      expires_hours: 24,
      source_count: 1,
      conflicting: false,
    }];

    const groundingMap = new Map<string, GroundingResult>([
      ['Bitcoin +20k tomorrow', {
        claim: 'Bitcoin +20k tomorrow',
        verified: false,
        confidence: 0.9,
        summary: 'No credible source confirms. Clickbait.',
        sources: [],
        contradictions: ['No catalyst identified'],
        tokensUsed: 200,
        claimType: 'prediction',
        tradability: 'none',
        sourceQuality: 'influencer',
      }],
    ]);

    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['BTCUSDT', [
        { pair: 'BTCUSDT', mark_price: 104000, open_interest: 5e9, created_at: '2026-03-07T09:55:00Z' },
        { pair: 'BTCUSDT', mark_price: 104050, open_interest: 5e9, created_at: '2026-03-07T10:10:00Z' },
      ]],
    ]);

    const entries = buildNewsMarketFusion(signals, groundingMap, snapshots, '2026-03-07T10:00:00Z');
    expect(entries.length).toBe(1);
    expect(entries[0].grounding?.claimType).toBe('prediction');
    expect(entries[0].grounding?.tradability).toBe('none');
    expect(entries[0].marketReaction.verdict).toBe('IGNORES');

    const text = formatFusionBlock(entries);
    expect(text).toContain('NON-TRADABLE');
    expect(text).toContain('prediction');
    expect(text).toContain('IGNORES');
  });

  it('end-to-end: real hack + market confirms = MARKET CONFIRMS', () => {
    const signals: NewsSignal[] = [{
      coins: ['ETH'],
      direction: 'bearish',
      importance: 9,
      timeframe: 'short',
      catalyst: 'Major DEX exploit $200M drained',
      reasoning: 'Multiple sources confirm',
      price_impact: 'high',
      expires_hours: 48,
      source_count: 5,
      conflicting: false,
    }];

    const groundingMap = new Map<string, GroundingResult>([
      ['Major DEX exploit $200M drained', {
        claim: 'Major DEX exploit $200M drained',
        verified: true,
        confidence: 0.95,
        summary: 'Confirmed by @PeckShield and @SlowMist',
        sources: ['@PeckShield', '@SlowMist', '@zachxbt'],
        contradictions: [],
        tokensUsed: 300,
        claimType: 'exchange_incident',
        tradability: 'actionable',
        sourceQuality: 'official',
      }],
    ]);

    const snapshots = new Map<string, DbMarketSnapshot[]>([
      ['ETHUSDT', [
        { pair: 'ETHUSDT', mark_price: 3500, open_interest: 2e9, created_at: '2026-03-07T09:55:00Z' },
        { pair: 'ETHUSDT', mark_price: 3410, open_interest: 1.8e9, created_at: '2026-03-07T10:10:00Z' },
      ]],
    ]);

    const entries = buildNewsMarketFusion(signals, groundingMap, snapshots, '2026-03-07T10:00:00Z');
    const text = formatFusionBlock(entries);
    expect(text).toContain('MARKET CONFIRMS');
    expect(text).toContain('bearish');
    expect(text).toContain('actionable');
    expect(text).toContain('official');
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/news/fusion-integration.test.ts`
Expected: all 2 tests PASS

**Step 3: Commit**

```bash
git add tests/news/fusion-integration.test.ts
git commit -m "test(fusion): integration tests for full news-market fusion pipeline"
```

---

### Task 7: Final verification + compile + commit

**Step 1: Full build**

Run: `npm run build`
Expected: clean compile, no TS errors

**Step 2: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (existing + 3 new test files)

**Step 3: Review prompt output**

Check that `buildEnrichedPrompt` now includes these new sections in order:
1. Watchdog Summary (existing)
2. Recent Liquidations (new)
3. Event Impact / News-Market Fusion (new)
4. Expert Analysis Reports (existing)

This gives Chief Architect the full chain: market data → liquidation pressure → news-event correlation → expert analysis.

**Step 4: Final commit + tag**

```bash
git add -A
git commit -m "feat: news-market fusion pipeline — complete

- Market Reaction Checker: algorithmic price/OI/funding displacement after events
- Enriched Grounder: claimType, tradability, sourceQuality taxonomy
- News-Market Fusion: correlates news signals with watchdog snapshots
- Liquidation context: surfaces collected-but-unused liquidation data
- Refactored duplicate grounding logic into shared method"
```
