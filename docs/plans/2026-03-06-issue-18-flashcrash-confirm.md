# Issue #18: FlashCrash Scanner -- Single LLM Call, No Confirmation

## Problem

The FlashCrashScanner makes **one single Grok LLM call**. If it returns "PANIC", the bot immediately closes **ALL open positions** -- no price validation, no volume confirmation, no cooldown. This is extremely dangerous:

1. **One hallucinated "PANIC" = close all positions at market price.** Grok could hallucinate panic from stale training data, a joke tweet going viral, or just a random failure mode.
2. **No price-action confirmation** -- the bot never checks if price actually dropped. A real flash crash shows up in candles (>3% drop in 5 min) and volume (>3x average).
3. **No cooldown** -- if the scanner fires PANIC twice in a row (e.g., due to a bug or persistent false positive), it will try to close already-closed positions, wasting API calls and potentially causing order errors.
4. **No logging of what triggered panic** -- the raw Grok response is discarded (`flash-crash.ts:13` only checks for the word "PANIC", throws away the reasoning).

### Current Flow (lines 136-156 in `src/trading-loop.ts`)

```
FlashCrashScanner.scan()
  -> grokClient.call(..., 'grok-4-1-fast-non-reasoning')
  -> if response includes "PANIC"
    -> close ALL positions immediately
    -> return (skip entire Brain cycle)
```

### Desired Flow

```
FlashCrashScanner.scan(pairs, marketData)
  -> grokClient.call(...) -> sentimentResult
  -> if sentimentResult is PANIC:
    -> confirmWithPrice(pairs, marketData): check 1m candles for >3% drop in 5min
    -> confirmWithVolume(pairs, marketData): check if volume > 3x recent average
    -> if 2 of 3 signals agree (grok + price + volume) -> CONFIRMED_PANIC
    -> else -> UNCONFIRMED (log warning, do NOT close)
  -> cooldown: ignore PANIC if last trigger was <15 min ago
  -> log the full Grok response for audit trail
```

## Files to Modify

| File | Change |
|------|--------|
| `src/news/flash-crash.ts` | Major rewrite: multi-signal confirmation, cooldown, logging |
| `src/trading-loop.ts` | Pass `marketData` to scanner, handle new result types |
| `tests/news/flash-crash.test.ts` | Full test rewrite for new confirmation logic |
| `tests/trading-loop.test.ts` | Update flash crash integration tests |

## Detailed Design

### FlashCrashResult (new type)

```typescript
export interface FlashCrashResult {
  verdict: 'PANIC' | 'UNCONFIRMED' | 'IGNORE';
  signals: {
    grok: boolean;        // Grok said PANIC
    priceDrop: boolean;   // >3% drop in any monitored pair in last 5 min
    volumeSpike: boolean; // volume > 3x 1h average in any pair
  };
  confirmedCount: number; // how many of 3 signals fired (need >= 2)
  grokReason?: string;    // raw Grok response for audit
  priceDropPct?: number;  // largest drop observed
  volumeRatio?: number;   // highest volume ratio observed
  cooldownActive?: boolean; // true if PANIC was suppressed by cooldown
}
```

### Price-Action Confirmation

Fetch 1-minute candles (last 5) via `client.getKlines({ symbol, interval: '1m', limit: 5 })`. Compare the close of the oldest candle to the close of the newest. If drop > 3%, price confirms.

We need `MarketDataFetcher` to expose a method for getting recent 1m candles, or we pass the Binance client directly. Best approach: add `getRecentCandles(pair, interval, limit)` to `MarketDataFetcher`.

### Volume Confirmation

Use the same 1m candles. Sum volume of last 5 candles. Compare to average volume of 1h candle (which represents ~60 min of volume). If 5-min volume > 3x (5/60 * avg_1h_volume), volume confirms.

Alternative (simpler): fetch last 12 1m candles. Compare last 5 to first 7. If ratio > 3x, volume confirms.

### Cooldown

`FlashCrashScanner` tracks `lastPanicAt: number | null`. If `Date.now() - lastPanicAt < cooldownMs`, return IGNORE with `cooldownActive: true`.

---

## TDD Implementation Steps

### Step 1: Define FlashCrashResult type and basic structure

**1a. Write failing test**

File: `tests/news/flash-crash.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlashCrashScanner, type FlashCrashResult } from '../../src/news/flash-crash.js';

describe('FlashCrashScanner', () => {
  let mockGrok: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGrok = { call: vi.fn() };
  });

  it('returns IGNORE with signal breakdown when Grok says IGNORE', async () => {
    mockGrok.call.mockResolvedValue('IGNORE - markets are calm');

    const scanner = new FlashCrashScanner(mockGrok);
    const result: FlashCrashResult = await scanner.scan();

    expect(result.verdict).toBe('IGNORE');
    expect(result.signals.grok).toBe(false);
    expect(result.confirmedCount).toBe(0);
    expect(result.grokReason).toBe('IGNORE - markets are calm');
  });

  it('returns UNCONFIRMED when only Grok says PANIC (no price/volume data)', async () => {
    mockGrok.call.mockResolvedValue('PANIC - massive hack reported');

    // No marketData provided, so price and volume can't confirm
    const scanner = new FlashCrashScanner(mockGrok);
    const result: FlashCrashResult = await scanner.scan();

    expect(result.verdict).toBe('UNCONFIRMED');
    expect(result.signals.grok).toBe(true);
    expect(result.signals.priceDrop).toBe(false);
    expect(result.signals.volumeSpike).toBe(false);
    expect(result.confirmedCount).toBe(1);
    expect(result.grokReason).toContain('hack');
  });

  it('uses non-reasoning model for speed', async () => {
    mockGrok.call.mockResolvedValue('IGNORE');

    const scanner = new FlashCrashScanner(mockGrok);
    await scanner.scan();

    expect(mockGrok.call).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'grok-4-1-fast-non-reasoning',
    );
  });

  it('returns IGNORE when grokClient is null', async () => {
    const scanner = new FlashCrashScanner(null);
    const result = await scanner.scan();
    expect(result.verdict).toBe('IGNORE');
  });
});
```

**1b. Verify test fails**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

Expected: `FlashCrashResult` type doesn't exist, `scan()` returns string not object.

**1c. Implement**

File: `src/news/flash-crash.ts`

```typescript
import type { SourceHealthMonitor } from './source-health.js';

export interface FlashCrashSignals {
  grok: boolean;
  priceDrop: boolean;
  volumeSpike: boolean;
}

export interface FlashCrashResult {
  verdict: 'PANIC' | 'UNCONFIRMED' | 'IGNORE';
  signals: FlashCrashSignals;
  confirmedCount: number;
  grokReason?: string;
  priceDropPct?: number;
  volumeRatio?: number;
  cooldownActive?: boolean;
}

export class FlashCrashScanner {
  constructor(
    private grokClient: any,
    private sourceHealth?: SourceHealthMonitor,
  ) {}

  async scan(): Promise<FlashCrashResult> {
    const ignoreResult: FlashCrashResult = {
      verdict: 'IGNORE',
      signals: { grok: false, priceDrop: false, volumeSpike: false },
      confirmedCount: 0,
    };

    if (!this.grokClient) return ignoreResult;

    const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".
After the word, briefly explain why in one sentence.`;

    let grokPanic = false;
    let grokReason: string | undefined;

    try {
      const raw = await this.grokClient.call(
        sys,
        'Scan crypto X now.',
        'grok-4-1-fast-non-reasoning',
      );
      grokReason = raw;
      grokPanic = raw.trim().toUpperCase().startsWith('PANIC');
      this.sourceHealth?.recordSuccess('grok-flash-crash');
    } catch (e: any) {
      const msg = e?.message ?? 'unknown';
      console.warn(`[FlashCrash] Grok scan failed: ${msg}`);
      this.sourceHealth?.recordFailure('grok-flash-crash', msg);
      return ignoreResult;
    }

    if (!grokPanic) {
      return { ...ignoreResult, grokReason };
    }

    // Grok says PANIC but no price/volume confirmation available yet
    // (confirmation is added in Step 3)
    const confirmedCount = 1; // only grok
    return {
      verdict: confirmedCount >= 2 ? 'PANIC' : 'UNCONFIRMED',
      signals: { grok: true, priceDrop: false, volumeSpike: false },
      confirmedCount,
      grokReason,
    };
  }
}
```

**1d. Verify tests pass**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

**1e. Commit**

```bash
git add src/news/flash-crash.ts tests/news/flash-crash.test.ts
git commit -m "refactor(flash-crash): return FlashCrashResult with signal breakdown"
```

---

### Step 2: Add price-action confirmation

**2a. Write failing test**

Add to `tests/news/flash-crash.test.ts`:

```typescript
describe('price-action confirmation', () => {
  it('confirms PANIC when price dropped >3% in 5 min candles', async () => {
    mockGrok.call.mockResolvedValue('PANIC - huge crash');

    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue([
        { close: '70000', volume: '100' },  // 5 min ago
        { close: '69000', volume: '120' },
        { close: '68000', volume: '150' },
        { close: '67500', volume: '200' },
        { close: '67000', volume: '300' },  // now — 4.3% drop
      ]),
    };

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT'], mockMarketData as any);

    expect(result.signals.grok).toBe(true);
    expect(result.signals.priceDrop).toBe(true);
    expect(result.priceDropPct).toBeGreaterThan(3);
    // 2 of 3 signals = PANIC
    expect(result.confirmedCount).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe('PANIC');
  });

  it('does NOT confirm when price drop is <3%', async () => {
    mockGrok.call.mockResolvedValue('PANIC - FUD spreading');

    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue([
        { close: '70000', volume: '100' },
        { close: '69800', volume: '100' },
        { close: '69600', volume: '100' },
        { close: '69400', volume: '100' },
        { close: '69200', volume: '100' },  // 1.14% drop
      ]),
    };

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT'], mockMarketData as any);

    expect(result.signals.grok).toBe(true);
    expect(result.signals.priceDrop).toBe(false);
    expect(result.confirmedCount).toBe(1);
    expect(result.verdict).toBe('UNCONFIRMED');
  });

  it('checks multiple pairs and uses worst drop', async () => {
    mockGrok.call.mockResolvedValue('PANIC');

    const mockMarketData = {
      getRecentCandles: vi.fn()
        .mockResolvedValueOnce([
          { close: '70000', volume: '100' },
          { close: '69900', volume: '100' },
          { close: '69800', volume: '100' },
          { close: '69700', volume: '100' },
          { close: '69600', volume: '100' },  // BTC: 0.57% — minor
        ])
        .mockResolvedValueOnce([
          { close: '3500', volume: '1000' },
          { close: '3400', volume: '1200' },
          { close: '3300', volume: '1500' },
          { close: '3200', volume: '2000' },
          { close: '3100', volume: '3000' },  // ETH: 11.4% — crash
        ]),
    };

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT', 'ETHUSDT'], mockMarketData as any);

    expect(result.signals.priceDrop).toBe(true);
    expect(result.priceDropPct).toBeGreaterThan(10);
  });

  it('handles getRecentCandles failure gracefully (priceDrop = false)', async () => {
    mockGrok.call.mockResolvedValue('PANIC');

    const mockMarketData = {
      getRecentCandles: vi.fn().mockRejectedValue(new Error('Binance down')),
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT'], mockMarketData as any);

    expect(result.signals.priceDrop).toBe(false);
    expect(result.verdict).toBe('UNCONFIRMED');
    warnSpy.mockRestore();
  });
});
```

**2b. Verify test fails**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

Expected: `scan()` doesn't accept `pairs` and `marketData` arguments.

**2c. Implement**

First, add `getRecentCandles` to `MarketDataFetcher`:

File: `src/binance/market-data.ts` -- add method after `getQuickSnapshot`:

```typescript
async getRecentCandles(
  pair: string,
  interval: string = '1m',
  limit: number = 5,
): Promise<CandleData[]> {
  const raw = await this.client.getKlines({ symbol: pair, interval, limit });
  return this.parseCandles(raw);
}
```

Then update `src/news/flash-crash.ts`:

```typescript
import type { SourceHealthMonitor } from './source-health.js';

export interface FlashCrashSignals {
  grok: boolean;
  priceDrop: boolean;
  volumeSpike: boolean;
}

export interface FlashCrashResult {
  verdict: 'PANIC' | 'UNCONFIRMED' | 'IGNORE';
  signals: FlashCrashSignals;
  confirmedCount: number;
  grokReason?: string;
  priceDropPct?: number;
  volumeRatio?: number;
  cooldownActive?: boolean;
}

/** Minimum drop in 5 1m candles to count as price-confirmed */
const PRICE_DROP_THRESHOLD_PCT = 3;
/** Volume must be this multiple of average to confirm */
const VOLUME_SPIKE_MULTIPLIER = 3;

export class FlashCrashScanner {
  constructor(
    private grokClient: any,
    private sourceHealth?: SourceHealthMonitor,
  ) {}

  async scan(
    pairs?: string[],
    marketData?: { getRecentCandles: (pair: string, interval: string, limit: number) => Promise<any[]> },
  ): Promise<FlashCrashResult> {
    const ignoreResult: FlashCrashResult = {
      verdict: 'IGNORE',
      signals: { grok: false, priceDrop: false, volumeSpike: false },
      confirmedCount: 0,
    };

    if (!this.grokClient) return ignoreResult;

    // --- Signal 1: Grok sentiment ---
    const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".
After the word, briefly explain why in one sentence.`;

    let grokPanic = false;
    let grokReason: string | undefined;

    try {
      const raw = await this.grokClient.call(
        sys,
        'Scan crypto X now.',
        'grok-4-1-fast-non-reasoning',
      );
      grokReason = raw;
      grokPanic = raw.trim().toUpperCase().startsWith('PANIC');
      this.sourceHealth?.recordSuccess('grok-flash-crash');
    } catch (e: any) {
      const msg = e?.message ?? 'unknown';
      console.warn(`[FlashCrash] Grok scan failed: ${msg}`);
      this.sourceHealth?.recordFailure('grok-flash-crash', msg);
      return ignoreResult;
    }

    if (!grokPanic) {
      return { ...ignoreResult, grokReason };
    }

    // Grok says PANIC -- now check price and volume for confirmation
    let priceDrop = false;
    let volumeSpike = false;
    let maxDropPct = 0;
    let maxVolumeRatio = 0;

    if (pairs?.length && marketData) {
      const priceVolumeResults = await this.checkPriceAndVolume(pairs, marketData);
      priceDrop = priceVolumeResults.priceDrop;
      volumeSpike = priceVolumeResults.volumeSpike;
      maxDropPct = priceVolumeResults.maxDropPct;
      maxVolumeRatio = priceVolumeResults.maxVolumeRatio;
    }

    const signals = { grok: true, priceDrop, volumeSpike };
    const confirmedCount = [signals.grok, signals.priceDrop, signals.volumeSpike].filter(Boolean).length;

    return {
      verdict: confirmedCount >= 2 ? 'PANIC' : 'UNCONFIRMED',
      signals,
      confirmedCount,
      grokReason,
      priceDropPct: maxDropPct || undefined,
      volumeRatio: maxVolumeRatio || undefined,
    };
  }

  private async checkPriceAndVolume(
    pairs: string[],
    marketData: { getRecentCandles: (pair: string, interval: string, limit: number) => Promise<any[]> },
  ): Promise<{ priceDrop: boolean; volumeSpike: boolean; maxDropPct: number; maxVolumeRatio: number }> {
    let maxDropPct = 0;
    let maxVolumeRatio = 0;

    const results = await Promise.allSettled(
      pairs.map(pair => marketData.getRecentCandles(pair, '1m', 12)),
    );

    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value?.length) continue;
      const candles = res.value;

      // Price: compare oldest close to newest close in last 5 candles
      const recent = candles.slice(-5);
      if (recent.length >= 2) {
        const oldPrice = parseFloat(recent[0].close);
        const newPrice = parseFloat(recent[recent.length - 1].close);
        if (oldPrice > 0) {
          const dropPct = ((oldPrice - newPrice) / oldPrice) * 100;
          if (dropPct > maxDropPct) maxDropPct = dropPct;
        }
      }

      // Volume: compare last 5 candles avg to first 7 candles avg
      if (candles.length >= 12) {
        const baseCandles = candles.slice(0, 7);
        const recentCandles = candles.slice(7);
        const baseAvgVol = baseCandles.reduce((s: number, c: any) => s + parseFloat(c.volume), 0) / baseCandles.length;
        const recentAvgVol = recentCandles.reduce((s: number, c: any) => s + parseFloat(c.volume), 0) / recentCandles.length;
        if (baseAvgVol > 0) {
          const ratio = recentAvgVol / baseAvgVol;
          if (ratio > maxVolumeRatio) maxVolumeRatio = ratio;
        }
      }
    }

    for (const res of results) {
      if (res.status === 'rejected') {
        console.warn(`[FlashCrash] Failed to fetch candles for confirmation: ${res.reason?.message ?? res.reason}`);
      }
    }

    return {
      priceDrop: maxDropPct >= PRICE_DROP_THRESHOLD_PCT,
      volumeSpike: maxVolumeRatio >= VOLUME_SPIKE_MULTIPLIER,
      maxDropPct,
      maxVolumeRatio,
    };
  }
}
```

**2d. Write test for `getRecentCandles`**

File: `tests/binance/market-data.test.ts` -- add:

```typescript
it('getRecentCandles fetches and parses 1m candles', async () => {
  mockClient.getKlines.mockResolvedValue([
    [1700000000000, '70000', '70500', '69500', '70200', '150'],
    [1700000060000, '70200', '70300', '69800', '70100', '120'],
  ]);

  const candles = await fetcher.getRecentCandles('BTCUSDT', '1m', 2);

  expect(candles).toHaveLength(2);
  expect(candles[0].close).toBe('70200');
  expect(candles[1].close).toBe('70100');
  expect(mockClient.getKlines).toHaveBeenCalledWith({
    symbol: 'BTCUSDT',
    interval: '1m',
    limit: 2,
  });
});
```

**2e. Verify all tests pass**

```bash
npx vitest run tests/news/flash-crash.test.ts tests/binance/market-data.test.ts
```

**2f. Commit**

```bash
git add src/news/flash-crash.ts src/binance/market-data.ts tests/news/flash-crash.test.ts tests/binance/market-data.test.ts
git commit -m "feat(flash-crash): add price-action + volume confirmation (2/3 required)"
```

---

### Step 3: Add volume confirmation tests

**3a. Write failing test**

Add to `tests/news/flash-crash.test.ts`:

```typescript
describe('volume confirmation', () => {
  it('confirms volume spike when recent volume is 3x+ base', async () => {
    mockGrok.call.mockResolvedValue('PANIC - crash incoming');

    // 12 candles: first 7 have low volume, last 5 have high volume
    const candles = [
      ...Array.from({ length: 7 }, (_, i) => ({ close: '70000', volume: '100' })),    // base: avg 100
      ...Array.from({ length: 5 }, (_, i) => ({ close: '67000', volume: '500' })),     // recent: avg 500 = 5x
    ];

    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue(candles),
    };

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT'], mockMarketData as any);

    expect(result.signals.volumeSpike).toBe(true);
    expect(result.volumeRatio).toBeGreaterThanOrEqual(3);
    // grok + price (4.3% drop) + volume = 3/3
    expect(result.verdict).toBe('PANIC');
  });

  it('does NOT confirm volume when ratio is below 3x', async () => {
    mockGrok.call.mockResolvedValue('PANIC');

    const candles = [
      ...Array.from({ length: 7 }, (_, i) => ({ close: '70000', volume: '100' })),
      ...Array.from({ length: 5 }, (_, i) => ({ close: '69900', volume: '150' })), // 1.5x — not enough
    ];

    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue(candles),
    };

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT'], mockMarketData as any);

    expect(result.signals.volumeSpike).toBe(false);
    // Only grok confirmed, price didn't drop either
    expect(result.verdict).toBe('UNCONFIRMED');
  });

  it('PANIC requires at least 2 of 3 signals', async () => {
    mockGrok.call.mockResolvedValue('PANIC');

    // Price drops >3% but volume is normal
    const candles = [
      ...Array.from({ length: 7 }, (_, i) => ({ close: '70000', volume: '100' })),
      ...Array.from({ length: 5 }, (_, i) => ({ close: '67500', volume: '110' })), // price: -3.6%, vol: 1.1x
    ];

    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue(candles),
    };

    const scanner = new FlashCrashScanner(mockGrok);
    const result = await scanner.scan(['BTCUSDT'], mockMarketData as any);

    // grok=true, priceDrop=true, volumeSpike=false => 2/3 => PANIC
    expect(result.signals.grok).toBe(true);
    expect(result.signals.priceDrop).toBe(true);
    expect(result.signals.volumeSpike).toBe(false);
    expect(result.confirmedCount).toBe(2);
    expect(result.verdict).toBe('PANIC');
  });
});
```

**3b. Verify tests pass** (these should pass with the Step 2 implementation)

```bash
npx vitest run tests/news/flash-crash.test.ts
```

**3c. Commit**

```bash
git add tests/news/flash-crash.test.ts
git commit -m "test(flash-crash): add volume confirmation test cases"
```

---

### Step 4: Add cooldown logic

**4a. Write failing test**

Add to `tests/news/flash-crash.test.ts`:

```typescript
describe('cooldown', () => {
  it('suppresses PANIC if last trigger was within cooldown period', async () => {
    mockGrok.call.mockResolvedValue('PANIC - still crashing');

    // Build candles that would confirm (price drop + volume)
    const candles = [
      ...Array.from({ length: 7 }, () => ({ close: '70000', volume: '100' })),
      ...Array.from({ length: 5 }, () => ({ close: '66000', volume: '500' })),
    ];
    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue(candles),
    };

    const scanner = new FlashCrashScanner(mockGrok, undefined, 15 * 60_000); // 15 min cooldown

    // First scan: should trigger PANIC
    const result1 = await scanner.scan(['BTCUSDT'], mockMarketData as any);
    expect(result1.verdict).toBe('PANIC');

    // Second scan immediately after: should be suppressed
    const result2 = await scanner.scan(['BTCUSDT'], mockMarketData as any);
    expect(result2.verdict).toBe('IGNORE');
    expect(result2.cooldownActive).toBe(true);
  });

  it('allows PANIC after cooldown expires', async () => {
    mockGrok.call.mockResolvedValue('PANIC');

    const candles = [
      ...Array.from({ length: 7 }, () => ({ close: '70000', volume: '100' })),
      ...Array.from({ length: 5 }, () => ({ close: '66000', volume: '500' })),
    ];
    const mockMarketData = {
      getRecentCandles: vi.fn().mockResolvedValue(candles),
    };

    const scanner = new FlashCrashScanner(mockGrok, undefined, 100); // 100ms cooldown for test

    const result1 = await scanner.scan(['BTCUSDT'], mockMarketData as any);
    expect(result1.verdict).toBe('PANIC');

    // Wait for cooldown to expire
    await new Promise(resolve => setTimeout(resolve, 150));

    const result2 = await scanner.scan(['BTCUSDT'], mockMarketData as any);
    expect(result2.verdict).toBe('PANIC');
    expect(result2.cooldownActive).toBeUndefined();
  });

  it('does not set cooldown on UNCONFIRMED result', async () => {
    mockGrok.call.mockResolvedValue('PANIC - FUD only');

    // No market data = no confirmation = UNCONFIRMED
    const scanner = new FlashCrashScanner(mockGrok, undefined, 15 * 60_000);

    const result1 = await scanner.scan();
    expect(result1.verdict).toBe('UNCONFIRMED');

    // Second scan should NOT be suppressed (cooldown only triggers on confirmed PANIC)
    mockGrok.call.mockResolvedValue('IGNORE');
    const result2 = await scanner.scan();
    expect(result2.verdict).toBe('IGNORE');
    expect(result2.cooldownActive).toBeUndefined();
  });
});
```

**4b. Verify test fails**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

Expected: constructor doesn't accept cooldown parameter.

**4c. Implement**

Update `src/news/flash-crash.ts` constructor and `scan()`:

```typescript
import type { SourceHealthMonitor } from './source-health.js';

export interface FlashCrashSignals {
  grok: boolean;
  priceDrop: boolean;
  volumeSpike: boolean;
}

export interface FlashCrashResult {
  verdict: 'PANIC' | 'UNCONFIRMED' | 'IGNORE';
  signals: FlashCrashSignals;
  confirmedCount: number;
  grokReason?: string;
  priceDropPct?: number;
  volumeRatio?: number;
  cooldownActive?: boolean;
}

const PRICE_DROP_THRESHOLD_PCT = 3;
const VOLUME_SPIKE_MULTIPLIER = 3;
const DEFAULT_COOLDOWN_MS = 15 * 60_000; // 15 minutes

export class FlashCrashScanner {
  private lastPanicAt: number | null = null;

  constructor(
    private grokClient: any,
    private sourceHealth?: SourceHealthMonitor,
    private cooldownMs: number = DEFAULT_COOLDOWN_MS,
  ) {}

  async scan(
    pairs?: string[],
    marketData?: { getRecentCandles: (pair: string, interval: string, limit: number) => Promise<any[]> },
  ): Promise<FlashCrashResult> {
    const ignoreResult: FlashCrashResult = {
      verdict: 'IGNORE',
      signals: { grok: false, priceDrop: false, volumeSpike: false },
      confirmedCount: 0,
    };

    if (!this.grokClient) return ignoreResult;

    // Check cooldown
    if (this.lastPanicAt && Date.now() - this.lastPanicAt < this.cooldownMs) {
      return { ...ignoreResult, cooldownActive: true };
    }

    // --- Signal 1: Grok sentiment ---
    const sys = `You are a real-time crypto X/Twitter sentiment scanner.
Respond with EXACTLY ONE WORD: "PANIC" if crypto twitter is currently freaking out about a hack, SEC, or massive crash right now. Otherwise, respond "IGNORE".
After the word, briefly explain why in one sentence.`;

    let grokPanic = false;
    let grokReason: string | undefined;

    try {
      const raw = await this.grokClient.call(
        sys,
        'Scan crypto X now.',
        'grok-4-1-fast-non-reasoning',
      );
      grokReason = raw;
      grokPanic = raw.trim().toUpperCase().startsWith('PANIC');
      this.sourceHealth?.recordSuccess('grok-flash-crash');
    } catch (e: any) {
      const msg = e?.message ?? 'unknown';
      console.warn(`[FlashCrash] Grok scan failed: ${msg}`);
      this.sourceHealth?.recordFailure('grok-flash-crash', msg);
      return ignoreResult;
    }

    if (!grokPanic) {
      return { ...ignoreResult, grokReason };
    }

    // --- Signals 2 & 3: Price + Volume ---
    let priceDrop = false;
    let volumeSpike = false;
    let maxDropPct = 0;
    let maxVolumeRatio = 0;

    if (pairs?.length && marketData) {
      const pv = await this.checkPriceAndVolume(pairs, marketData);
      priceDrop = pv.priceDrop;
      volumeSpike = pv.volumeSpike;
      maxDropPct = pv.maxDropPct;
      maxVolumeRatio = pv.maxVolumeRatio;
    }

    const signals = { grok: true, priceDrop, volumeSpike };
    const confirmedCount = [signals.grok, signals.priceDrop, signals.volumeSpike].filter(Boolean).length;

    const verdict = confirmedCount >= 2 ? 'PANIC' : 'UNCONFIRMED';

    // Only set cooldown on confirmed PANIC
    if (verdict === 'PANIC') {
      this.lastPanicAt = Date.now();
    }

    console.log(
      `[FlashCrash] verdict=${verdict} signals=[grok=${signals.grok}, price=${priceDrop}(${maxDropPct.toFixed(1)}%), vol=${volumeSpike}(${maxVolumeRatio.toFixed(1)}x)] confirmed=${confirmedCount}/3`,
    );

    return {
      verdict,
      signals,
      confirmedCount,
      grokReason,
      priceDropPct: maxDropPct || undefined,
      volumeRatio: maxVolumeRatio || undefined,
    };
  }

  private async checkPriceAndVolume(
    pairs: string[],
    marketData: { getRecentCandles: (pair: string, interval: string, limit: number) => Promise<any[]> },
  ): Promise<{ priceDrop: boolean; volumeSpike: boolean; maxDropPct: number; maxVolumeRatio: number }> {
    let maxDropPct = 0;
    let maxVolumeRatio = 0;

    const results = await Promise.allSettled(
      pairs.map(pair => marketData.getRecentCandles(pair, '1m', 12)),
    );

    for (const res of results) {
      if (res.status !== 'fulfilled' || !res.value?.length) continue;
      const candles = res.value;

      // Price: compare oldest to newest in last 5 candles
      const recent = candles.slice(-5);
      if (recent.length >= 2) {
        const oldPrice = parseFloat(recent[0].close);
        const newPrice = parseFloat(recent[recent.length - 1].close);
        if (oldPrice > 0) {
          const dropPct = ((oldPrice - newPrice) / oldPrice) * 100;
          if (dropPct > maxDropPct) maxDropPct = dropPct;
        }
      }

      // Volume: compare last 5 avg to first 7 avg
      if (candles.length >= 12) {
        const baseCandles = candles.slice(0, 7);
        const recentCandles = candles.slice(7);
        const baseAvgVol =
          baseCandles.reduce((s: number, c: any) => s + parseFloat(c.volume), 0) / baseCandles.length;
        const recentAvgVol =
          recentCandles.reduce((s: number, c: any) => s + parseFloat(c.volume), 0) / recentCandles.length;
        if (baseAvgVol > 0) {
          const ratio = recentAvgVol / baseAvgVol;
          if (ratio > maxVolumeRatio) maxVolumeRatio = ratio;
        }
      }
    }

    for (const res of results) {
      if (res.status === 'rejected') {
        console.warn(
          `[FlashCrash] Failed to fetch candles for confirmation: ${res.reason?.message ?? res.reason}`,
        );
      }
    }

    return {
      priceDrop: maxDropPct >= PRICE_DROP_THRESHOLD_PCT,
      volumeSpike: maxVolumeRatio >= VOLUME_SPIKE_MULTIPLIER,
      maxDropPct,
      maxVolumeRatio,
    };
  }
}
```

**4d. Verify tests pass**

```bash
npx vitest run tests/news/flash-crash.test.ts
```

**4e. Commit**

```bash
git add src/news/flash-crash.ts tests/news/flash-crash.test.ts
git commit -m "feat(flash-crash): add 15-min cooldown after confirmed PANIC"
```

---

### Step 5: Update TradingLoop to use new FlashCrashResult

**5a. Write failing test**

Update `tests/trading-loop.test.ts` flash crash test:

```typescript
it('closes all positions on confirmed PANIC from FlashCrashScanner', async () => {
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 1000, sessionPnl: 0, drawdownPct: 0,
    positions: [
      { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -2, heldHours: 1 },
    ],
  });
  mockOrders.close.mockResolvedValue({ success: true });

  const loopWithScanner = new TradingLoop({
    pairs: ['BTCUSDT'],
    marketData: mockMarketData,
    llm: mockLlm,
    orders: mockOrders,
    riskManager: mockRisk,
    signalBuffer: mockSignalBuffer,
    logger: mockLogger,
    memory: mockSessionMemory,
    newsCache: loop['deps'].newsCache,
    newsAnalyst: loop['deps'].newsAnalyst,
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    churnCooldownMs: 900000,
    tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    flashCrashScanner: {
      scan: vi.fn().mockResolvedValue({
        verdict: 'PANIC',
        signals: { grok: true, priceDrop: true, volumeSpike: false },
        confirmedCount: 2,
        grokReason: 'PANIC - exchange hack',
      }),
    } as any,
  });

  await loopWithScanner.runOnce();

  expect(mockOrders.close).toHaveBeenCalledWith('BTCUSDT', 'LONG');
  expect(mockLogger.logTrade).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'EMERGENCY_CLOSE' }),
  );
  expect(mockLlm.analyze).not.toHaveBeenCalled();
});

it('does NOT close positions on UNCONFIRMED panic (logs warning, continues cycle)', async () => {
  mockMarketData.getPortfolioState.mockResolvedValue({
    balanceUsd: 1000, sessionPnl: 0, drawdownPct: 0,
    positions: [
      { pair: 'BTCUSDT', side: 'LONG', sizeUsd: 500, leverage: 5, entryPrice: 70000, unrealizedPnlPct: -2, heldHours: 1 },
    ],
  });

  const scanMock = vi.fn().mockResolvedValue({
    verdict: 'UNCONFIRMED',
    signals: { grok: true, priceDrop: false, volumeSpike: false },
    confirmedCount: 1,
    grokReason: 'PANIC - FUD rumor',
  });

  const loopWithScanner = new TradingLoop({
    pairs: ['BTCUSDT'],
    marketData: mockMarketData,
    llm: mockLlm,
    orders: mockOrders,
    riskManager: mockRisk,
    signalBuffer: mockSignalBuffer,
    logger: mockLogger,
    memory: mockSessionMemory,
    newsCache: loop['deps'].newsCache,
    newsAnalyst: loop['deps'].newsAnalyst,
    newsConfig: { refreshIntervalH: 12, maxItems: 100 },
    churnCooldownMs: 900000,
    tradingConfig: { targetReturnPct: 100, minTakeProfitPct: 5, maxLeverage: 20, maxPositionPct: 50, maxStopLossPct: 5 },
    flashCrashScanner: { scan: scanMock } as any,
  });

  await loopWithScanner.runOnce();

  // Should NOT close positions
  expect(mockOrders.close).not.toHaveBeenCalled();
  // Should log warning
  expect(mockLogger.logError).toHaveBeenCalledWith(
    'FLASH_CRASH_UNCONFIRMED',
    expect.stringContaining('FUD rumor'),
  );
  // Should continue with normal cycle
  expect(mockLlm.analyze).toHaveBeenCalled();
});
```

**5b. Verify test fails**

```bash
npx vitest run tests/trading-loop.test.ts
```

Expected: TradingLoop still checks for string `'PANIC'` instead of `result.verdict`.

**5c. Implement**

Update `src/trading-loop.ts` lines 136-156:

```typescript
// Replace the existing flash crash block (lines 136-156)
if (this.deps.flashCrashScanner) {
  const crashResult = await this.deps.flashCrashScanner.scan(pairs, marketData);

  if (crashResult.verdict === 'PANIC') {
    console.warn(
      `[Loop] FlashCrashScanner CONFIRMED PANIC (${crashResult.confirmedCount}/3 signals). Emergency closing all positions.`,
    );
    logger.logError(
      'FLASH_CRASH_CONFIRMED',
      `${crashResult.confirmedCount}/3 signals: grok=${crashResult.signals.grok}, price=${crashResult.signals.priceDrop}(${crashResult.priceDropPct?.toFixed(1) ?? '?'}%), vol=${crashResult.signals.volumeSpike}(${crashResult.volumeRatio?.toFixed(1) ?? '?'}x). Grok: ${crashResult.grokReason?.slice(0, 200) ?? 'n/a'}`,
    );

    try {
      const portfolio = await marketData.getPortfolioState();
      for (const pos of portfolio.positions) {
        const result = await orders.close(pos.pair, pos.side);
        if (result.success) {
          logger.logTrade({ type: 'EMERGENCY_CLOSE', pair: pos.pair, reason: 'flash_crash_panic' });
          this.lastClosedAt.set(pos.pair, Date.now());
        }
      }
    } catch (err: any) {
      logger.logError('FLASH_CRASH_CLOSE_FAILED', err.message ?? 'unknown');
    }
    return undefined;
  }

  if (crashResult.verdict === 'UNCONFIRMED') {
    console.warn(
      `[Loop] FlashCrashScanner UNCONFIRMED panic (${crashResult.confirmedCount}/3). Continuing cycle with caution.`,
    );
    logger.logError(
      'FLASH_CRASH_UNCONFIRMED',
      `Grok said PANIC but only ${crashResult.confirmedCount}/3 confirmed. Grok: ${crashResult.grokReason?.slice(0, 200) ?? 'n/a'}`,
    );
    // Continue with normal cycle -- do NOT close positions
  }
}
```

**5d. Verify tests pass**

```bash
npx vitest run tests/trading-loop.test.ts
```

**5e. Commit**

```bash
git add src/trading-loop.ts tests/trading-loop.test.ts
git commit -m "feat(trading-loop): use multi-signal FlashCrashResult, only close on confirmed PANIC"
```

---

### Step 6: Update index.ts to pass pairs and marketData to scanner

**6a. No new test needed** -- this is wiring only. The scanner's `scan()` method already accepts optional `pairs` and `marketData`. The TradingLoop already has access to both.

**6b. Verify** -- The scanner is called inside `TradingLoop.runOnce()` which already has `pairs` and `marketData` in scope (from `this.deps`). The implementation in Step 5c already passes them:

```typescript
const crashResult = await this.deps.flashCrashScanner.scan(pairs, marketData);
```

No `index.ts` changes needed -- the scanner receives `marketData` at call time, not at construction time.

**6c. Commit** (if any wiring adjustment needed)

```bash
git add src/index.ts
git commit -m "wire(flash-crash): pass pairs + marketData to scanner at call site"
```

---

## Final Verification

Run all tests:

```bash
npx vitest run
```

Run specific test suites that were modified:

```bash
npx vitest run tests/news/flash-crash.test.ts tests/trading-loop.test.ts tests/binance/market-data.test.ts
```

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Binance getKlines for 1m fails | `Promise.allSettled` -- fails gracefully, priceDrop=false |
| Real flash crash with slow Binance API | Grok alone cannot trigger close (UNCONFIRMED); reduces false positives but adds 1-2s latency for true positives |
| Grok API down during real crash | scan() returns IGNORE; watchdog anomaly detection (>2% price spike) still fires but doesn't close positions. Layer 3 rule-based SL/TP on Binance still protects. |
| Cooldown blocks legitimate second crash | 15 min cooldown is a tradeoff; positions are already closed after first PANIC. Configurable via constructor. |

## Summary of Changes

| Component | Before | After |
|-----------|--------|-------|
| `FlashCrashScanner.scan()` | Returns `'PANIC' \| 'IGNORE'` string | Returns `FlashCrashResult` with signal breakdown |
| Panic trigger | 1 Grok LLM call | 2 of 3 required: Grok + price drop >3% + volume >3x |
| Error handling | `catch (e) { /* ignore */ }` | Logs warning, tracks in sourceHealth |
| Cooldown | None | 15 min after confirmed PANIC |
| Grok response | Discarded after checking for "PANIC" | Preserved in `grokReason` for audit |
| TradingLoop | Checks `=== 'PANIC'` string | Checks `result.verdict`, handles UNCONFIRMED |
| UNCONFIRMED panic | N/A (didn't exist) | Logged as warning, cycle continues normally |
| MarketDataFetcher | No 1m candle access | New `getRecentCandles()` method |
