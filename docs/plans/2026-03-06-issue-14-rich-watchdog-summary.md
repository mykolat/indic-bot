# Issue #14: Watchdog summary discards anomalies, funding, L/S ratio

## Problem

`buildWatchdogSummary()` in `src/watchdog-summary.ts` only extracts price delta and OI delta from the `DbMarketSnapshot[]` array. The database snapshots contain rich microstructure data that is thrown away:

**Currently used (lines 13-21):**
- `mark_price` (first vs last) -> price delta %
- `open_interest` (first vs last) -> OI delta %

**Available but discarded:**
- `funding_rate` — indicates leverage sentiment; extreme values (>0.05% or <-0.05%) signal crowded trades
- `long_short_ratio` — directional trader positioning
- `order_book_bid_pct` / `order_book_ask_pct` — order flow pressure
- `imbalance_pct` — net order book imbalance; flips signal regime change
- Anomaly events — no concept of anomalies in the summary at all

**Impact:** Brain's LLM gets a single line per pair like `BTCUSDT: +0.5% over 10m (10 snapshots) | OI +2.0%`. It has no idea about funding pressure, positioning shifts, order book flips, or anomaly spikes that Watchdog detected.

## Solution

1. Enrich the `WatchdogSummary` return type from `string` to a structured interface
2. Extract funding, L/S ratio, order book imbalance from snapshots
3. Flag anomaly events by detecting spikes within the snapshot window
4. Format a rich text summary for the LLM prompt
5. Keep backward compatibility — `buildWatchdogSummary()` still returns a string (richer now)

### Key Design Decisions

1. **Keep returning string** — The prompt builder (`src/llm/prompts.ts:267-268`) injects watchdog summary as raw text. A structured type would require prompt changes. Instead, we build a richer string. We also export a structured helper type for future use.
2. **Detect anomalies within snapshot window** — Rather than requiring Watchdog to persist anomaly events to DB, we re-derive them from the snapshot deltas (price, OI, imbalance). This is simpler and avoids a new DB table.
3. **Funding aggregation** — Show latest funding rate + trend (rising/falling/stable) across the window.
4. **L/S ratio** — Show latest value + direction of change.
5. **Order book** — Show latest bid/ask split + max imbalance swing in window.

## Files Changed

| File | Change |
|---|---|
| `src/watchdog-summary.ts` | Enrich `buildWatchdogSummary()` output with funding, L/S, order book, anomaly flags |
| `tests/watchdog-summary.test.ts` | New tests for all enriched fields |

---

## Step 1: Test funding rate in watchdog summary

### 1a. Write failing test

**File:** `tests/watchdog-summary.test.ts`

Add after the existing `'shows SL HIT'` test (line 36):

```typescript
  it('includes funding rate when available', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        funding_rate: 0.0001,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70200, open_interest: 50000,
        funding_rate: 0.0003,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('Funding');
    expect(summary).toContain('0.03%'); // 0.0003 * 100
  });
```

### 1b. Run and verify failure

```bash
npx vitest run tests/watchdog-summary.test.ts
```

Fails because current summary does not contain `'Funding'`.

### 1c. Implement

**File:** `src/watchdog-summary.ts`

Add funding rate to the summary string. After the OI delta block (line 22), add:

```typescript
  // Funding rate
  const lastFunding = Number(last.funding_rate);
  const firstFunding = Number(first.funding_rate);
  if (lastFunding && !isNaN(lastFunding)) {
    const fundingPct = (lastFunding * 100).toFixed(4);
    let fundingTrend = '';
    if (firstFunding && !isNaN(firstFunding)) {
      const delta = lastFunding - firstFunding;
      if (delta > 0.00005) fundingTrend = ' rising';
      else if (delta < -0.00005) fundingTrend = ' falling';
      else fundingTrend = ' stable';
    }
    summary += ` | Funding ${fundingPct}%${fundingTrend}`;
  }
```

### 1d. Run and verify pass

```bash
npx vitest run tests/watchdog-summary.test.ts
```

### 1e. Commit

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog-summary): include funding rate + trend"
```

---

## Step 2: Test long/short ratio in watchdog summary

### 2a. Write failing test

**File:** `tests/watchdog-summary.test.ts`

```typescript
  it('includes L/S ratio when available', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        funding_rate: 0.0001,
        long_short_ratio: 1.1,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70200, open_interest: 50000,
        funding_rate: 0.0001,
        long_short_ratio: 1.4,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('L/S');
    expect(summary).toContain('1.40');
  });

  it('shows L/S direction when ratio increased', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        long_short_ratio: 1.0,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        long_short_ratio: 1.5,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('long-biased');
  });

  it('shows L/S direction when ratio decreased below 1', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        long_short_ratio: 1.2,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        long_short_ratio: 0.7,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('short-biased');
  });
```

### 2b. Run and verify failure

```bash
npx vitest run tests/watchdog-summary.test.ts
```

Fails because summary does not contain `'L/S'`.

### 2c. Implement

**File:** `src/watchdog-summary.ts`

After the funding rate block, add:

```typescript
  // Long/Short ratio
  const lastLS = Number(last.long_short_ratio);
  const firstLS = Number(first.long_short_ratio);
  if (lastLS && !isNaN(lastLS)) {
    let lsBias = '';
    if (lastLS > 1.2) lsBias = ' long-biased';
    else if (lastLS < 0.8) lsBias = ' short-biased';
    let lsTrend = '';
    if (firstLS && !isNaN(firstLS)) {
      const delta = lastLS - firstLS;
      if (delta > 0.1) lsTrend = ' (rising)';
      else if (delta < -0.1) lsTrend = ' (falling)';
    }
    summary += ` | L/S ${lastLS.toFixed(2)}${lsBias}${lsTrend}`;
  }
```

### 2d. Run and verify pass

```bash
npx vitest run tests/watchdog-summary.test.ts
```

### 2e. Commit

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog-summary): include L/S ratio with directional bias"
```

---

## Step 3: Test order book imbalance in watchdog summary

### 3a. Write failing test

**File:** `tests/watchdog-summary.test.ts`

```typescript
  it('includes order book imbalance', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        order_book_bid_pct: 65, order_book_ask_pct: 35,
        imbalance_pct: 30,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70200, open_interest: 50000,
        order_book_bid_pct: 60, order_book_ask_pct: 40,
        imbalance_pct: 20,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('Book');
    expect(summary).toContain('60/40');
  });

  it('flags heavy imbalance > 25%', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        order_book_bid_pct: 80, order_book_ask_pct: 20,
        imbalance_pct: 60,
        created_at: new Date(Date.now() - 60000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        order_book_bid_pct: 78, order_book_ask_pct: 22,
        imbalance_pct: 56,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('HEAVY');
  });
```

### 3b. Run and verify failure

```bash
npx vitest run tests/watchdog-summary.test.ts
```

Fails because summary does not contain `'Book'`.

### 3c. Implement

**File:** `src/watchdog-summary.ts`

After the L/S ratio block, add:

```typescript
  // Order book imbalance
  const lastBid = Number(last.order_book_bid_pct);
  const lastAsk = Number(last.order_book_ask_pct);
  if (lastBid && lastAsk && !isNaN(lastBid)) {
    let bookLabel = `Book ${lastBid}/${lastAsk}`;
    const lastImb = Number(last.imbalance_pct);
    if (!isNaN(lastImb) && Math.abs(lastImb) > 25) {
      bookLabel += lastImb > 0 ? ' HEAVY BID' : ' HEAVY ASK';
    }
    summary += ` | ${bookLabel}`;
  }
```

### 3d. Run and verify pass

```bash
npx vitest run tests/watchdog-summary.test.ts
```

### 3e. Commit

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog-summary): include order book bid/ask split + heavy imbalance flag"
```

---

## Step 4: Test anomaly detection within snapshot window

### 4a. Write failing test

**File:** `tests/watchdog-summary.test.ts`

```typescript
  it('flags price spike anomaly within snapshot window', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70100, open_interest: 50000,
        created_at: new Date(Date.now() - 540000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 71600, open_interest: 50000,  // +2.1% from previous
        created_at: new Date(Date.now() - 480000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 71800, open_interest: 50000,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('SPIKE');
  });

  it('flags OI spike anomaly within snapshot window', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        created_at: new Date(Date.now() - 300000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70100, open_interest: 56000,  // +12% OI jump
        created_at: new Date(Date.now() - 240000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70200, open_interest: 56500,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('OI_SPIKE');
  });

  it('no anomaly flags when changes are gradual', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70200, open_interest: 50100,
        created_at: new Date(Date.now() - 300000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70400, open_interest: 50200,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).not.toContain('SPIKE');
    expect(summary).not.toContain('OI_SPIKE');
  });
```

### 4b. Run and verify failure

```bash
npx vitest run tests/watchdog-summary.test.ts
```

Fails because summary does not contain `'SPIKE'` or `'OI_SPIKE'` strings.

### 4c. Implement

**File:** `src/watchdog-summary.ts`

Add anomaly detection function and integrate it. Before `buildWatchdogSummary`, add:

```typescript
interface AnomalyFlag {
  type: 'PRICE_SPIKE' | 'OI_SPIKE' | 'IMBALANCE_FLIP';
  detail: string;
}

function detectAnomalies(snapshots: DbMarketSnapshot[]): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];

    // Price spike > 2% between consecutive snapshots
    const prevPrice = Number(prev.mark_price);
    const currPrice = Number(curr.mark_price);
    if (prevPrice > 0) {
      const priceDelta = Math.abs(currPrice - prevPrice) / prevPrice * 100;
      if (priceDelta > 2) {
        flags.push({
          type: 'PRICE_SPIKE',
          detail: `${priceDelta.toFixed(1)}% between snapshots`,
        });
      }
    }

    // OI spike > 10% between consecutive snapshots
    const prevOI = Number(prev.open_interest);
    const currOI = Number(curr.open_interest);
    if (prevOI > 0 && currOI > 0) {
      const oiDelta = Math.abs(currOI - prevOI) / prevOI * 100;
      if (oiDelta > 10) {
        flags.push({
          type: 'OI_SPIKE',
          detail: `${oiDelta.toFixed(1)}% between snapshots`,
        });
      }
    }

    // Imbalance flip > 40pp
    const prevImb = Number(prev.imbalance_pct);
    const currImb = Number(curr.imbalance_pct);
    if (!isNaN(prevImb) && !isNaN(currImb)) {
      const imbDelta = Math.abs(currImb - prevImb);
      if (imbDelta > 40) {
        flags.push({
          type: 'IMBALANCE_FLIP',
          detail: `${imbDelta.toFixed(0)}pp shift`,
        });
      }
    }
  }
  return flags;
}
```

At the end of `buildWatchdogSummary`, before `return summary`, add:

```typescript
  // Anomaly flags within the snapshot window
  const anomalies = detectAnomalies(snapshots);
  if (anomalies.length > 0) {
    const uniqueTypes = [...new Set(anomalies.map(a => a.type))];
    summary += ` | !! ${uniqueTypes.join(', ')} detected`;
  }
```

### 4d. Run and verify pass

```bash
npx vitest run tests/watchdog-summary.test.ts
```

### 4e. Commit

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog-summary): detect and flag anomalies within snapshot window"
```

---

## Step 5: Test funding extremes get flagged

### 5a. Write failing test

**File:** `tests/watchdog-summary.test.ts`

```typescript
  it('flags extreme positive funding rate', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        funding_rate: 0.0008,
        created_at: new Date(Date.now() - 60000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70100, open_interest: 50000,
        funding_rate: 0.001,  // 0.1% — extreme positive
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('Funding');
    expect(summary).toContain('EXTREME');
  });

  it('flags extreme negative funding rate', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        funding_rate: -0.0003,
        created_at: new Date(Date.now() - 60000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70100, open_interest: 50000,
        funding_rate: -0.0008,  // -0.08% — extreme negative
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).toContain('EXTREME');
  });

  it('does not flag normal funding rate', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000, open_interest: 50000,
        funding_rate: 0.0001,
        created_at: new Date(Date.now() - 60000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70100, open_interest: 50000,
        funding_rate: 0.00015,
        created_at: new Date().toISOString(),
      },
    ];

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);

    expect(summary).not.toContain('EXTREME');
  });
```

### 5b. Run and verify failure

```bash
npx vitest run tests/watchdog-summary.test.ts
```

Fails because summary does not contain `'EXTREME'` for extreme funding.

### 5c. Implement

**File:** `src/watchdog-summary.ts`

Modify the funding rate block (from Step 1) to add extreme flag:

```typescript
  // Funding rate
  const lastFunding = Number(last.funding_rate);
  const firstFunding = Number(first.funding_rate);
  if (lastFunding && !isNaN(lastFunding)) {
    const fundingPct = (lastFunding * 100).toFixed(4);
    let fundingTrend = '';
    if (firstFunding && !isNaN(firstFunding)) {
      const delta = lastFunding - firstFunding;
      if (delta > 0.00005) fundingTrend = ' rising';
      else if (delta < -0.00005) fundingTrend = ' falling';
      else fundingTrend = ' stable';
    }
    const extreme = Math.abs(lastFunding) >= 0.0005 ? ' EXTREME' : '';
    summary += ` | Funding ${fundingPct}%${fundingTrend}${extreme}`;
  }
```

The threshold `0.0005` (0.05%) is standard for identifying crowded trades on Binance perpetuals.

### 5d. Run and verify pass

```bash
npx vitest run tests/watchdog-summary.test.ts
```

### 5e. Commit

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog-summary): flag extreme funding rates (>0.05%)"
```

---

## Step 6: Full integration test — verify complete enriched summary format

### 6a. Write test

**File:** `tests/watchdog-summary.test.ts`

```typescript
  it('produces fully enriched summary with all fields', () => {
    const snapshots = [
      {
        pair: 'BTCUSDT',
        mark_price: 70000,
        open_interest: 50000,
        funding_rate: 0.0001,
        long_short_ratio: 1.1,
        order_book_bid_pct: 55,
        order_book_ask_pct: 45,
        imbalance_pct: 10,
        created_at: new Date(Date.now() - 600000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70300,
        open_interest: 51000,
        funding_rate: 0.00015,
        long_short_ratio: 1.3,
        order_book_bid_pct: 58,
        order_book_ask_pct: 42,
        imbalance_pct: 16,
        created_at: new Date(Date.now() - 300000).toISOString(),
      },
      {
        pair: 'BTCUSDT',
        mark_price: 70500,
        open_interest: 51500,
        funding_rate: 0.0002,
        long_short_ratio: 1.4,
        order_book_bid_pct: 60,
        order_book_ask_pct: 40,
        imbalance_pct: 20,
        created_at: new Date().toISOString(),
      },
    ];
    const posCtx = { sl_price: 69000, tp_price: 73000, fill_price: 70000, side: 'BUY' };

    const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, posCtx as any);

    // Price movement
    expect(summary).toMatch(/BTCUSDT.*\+0\.7%.*10m/);
    // OI delta
    expect(summary).toContain('OI');
    // Funding
    expect(summary).toContain('Funding');
    expect(summary).toContain('rising');
    // L/S ratio
    expect(summary).toContain('L/S');
    expect(summary).toContain('1.40');
    expect(summary).toContain('long-biased');
    // Order book
    expect(summary).toContain('Book 60/40');
    // SL/TP
    expect(summary).toContain('SL $69000 NOT hit');
    expect(summary).toContain('TP $73000 NOT hit');
    // No anomalies (gradual changes)
    expect(summary).not.toContain('SPIKE');
  });
```

### 6b. Run and verify

```bash
npx vitest run tests/watchdog-summary.test.ts
```

This should pass if all previous steps are implemented correctly. If it fails, it reveals integration issues between the enriched blocks.

### 6c. Commit

```bash
git add tests/watchdog-summary.test.ts
git commit -m "test: full integration test for enriched watchdog summary"
```

---

## Final `buildWatchdogSummary` Implementation

For reference, here is the complete final state of `src/watchdog-summary.ts` after all steps:

```typescript
import type { DbMarketSnapshot } from './db/types.js';
import type { OpenPositionContext } from './db/repository.js';

interface AnomalyFlag {
  type: 'PRICE_SPIKE' | 'OI_SPIKE' | 'IMBALANCE_FLIP';
  detail: string;
}

function detectAnomalies(snapshots: DbMarketSnapshot[]): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const curr = snapshots[i];

    // Price spike > 2% between consecutive snapshots
    const prevPrice = Number(prev.mark_price);
    const currPrice = Number(curr.mark_price);
    if (prevPrice > 0) {
      const priceDelta = Math.abs(currPrice - prevPrice) / prevPrice * 100;
      if (priceDelta > 2) {
        flags.push({
          type: 'PRICE_SPIKE',
          detail: `${priceDelta.toFixed(1)}% between snapshots`,
        });
      }
    }

    // OI spike > 10% between consecutive snapshots
    const prevOI = Number(prev.open_interest);
    const currOI = Number(curr.open_interest);
    if (prevOI > 0 && currOI > 0) {
      const oiDelta = Math.abs(currOI - prevOI) / prevOI * 100;
      if (oiDelta > 10) {
        flags.push({
          type: 'OI_SPIKE',
          detail: `${oiDelta.toFixed(1)}% between snapshots`,
        });
      }
    }

    // Imbalance flip > 40pp
    const prevImb = Number(prev.imbalance_pct);
    const currImb = Number(curr.imbalance_pct);
    if (!isNaN(prevImb) && !isNaN(currImb)) {
      const imbDelta = Math.abs(currImb - prevImb);
      if (imbDelta > 40) {
        flags.push({
          type: 'IMBALANCE_FLIP',
          detail: `${imbDelta.toFixed(0)}pp shift`,
        });
      }
    }
  }
  return flags;
}

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
  const lastFunding = Number(last.funding_rate);
  const firstFunding = Number(first.funding_rate);
  if (lastFunding && !isNaN(lastFunding)) {
    const fundingPct = (lastFunding * 100).toFixed(4);
    let fundingTrend = '';
    if (firstFunding && !isNaN(firstFunding)) {
      const delta = lastFunding - firstFunding;
      if (delta > 0.00005) fundingTrend = ' rising';
      else if (delta < -0.00005) fundingTrend = ' falling';
      else fundingTrend = ' stable';
    }
    const extreme = Math.abs(lastFunding) >= 0.0005 ? ' EXTREME' : '';
    summary += ` | Funding ${fundingPct}%${fundingTrend}${extreme}`;
  }

  // Long/Short ratio
  const lastLS = Number(last.long_short_ratio);
  const firstLS = Number(first.long_short_ratio);
  if (lastLS && !isNaN(lastLS)) {
    let lsBias = '';
    if (lastLS > 1.2) lsBias = ' long-biased';
    else if (lastLS < 0.8) lsBias = ' short-biased';
    let lsTrend = '';
    if (firstLS && !isNaN(firstLS)) {
      const delta = lastLS - firstLS;
      if (delta > 0.1) lsTrend = ' (rising)';
      else if (delta < -0.1) lsTrend = ' (falling)';
    }
    summary += ` | L/S ${lastLS.toFixed(2)}${lsBias}${lsTrend}`;
  }

  // Order book imbalance
  const lastBid = Number(last.order_book_bid_pct);
  const lastAsk = Number(last.order_book_ask_pct);
  if (lastBid && lastAsk && !isNaN(lastBid)) {
    let bookLabel = `Book ${lastBid}/${lastAsk}`;
    const lastImb = Number(last.imbalance_pct);
    if (!isNaN(lastImb) && Math.abs(lastImb) > 25) {
      bookLabel += lastImb > 0 ? ' HEAVY BID' : ' HEAVY ASK';
    }
    summary += ` | ${bookLabel}`;
  }

  // SL/TP status for open positions
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

  // Anomaly flags within the snapshot window
  const anomalies = detectAnomalies(snapshots);
  if (anomalies.length > 0) {
    const uniqueTypes = [...new Set(anomalies.map(a => a.type))];
    summary += ` | !! ${uniqueTypes.join(', ')} detected`;
  }

  return summary;
}
```

---

## Example Output (before vs after)

**Before:**
```
BTCUSDT: +0.5% over 10m (10 snapshots) | OI +2.0% | SL $69000 NOT hit | TP $73000 NOT hit
```

**After:**
```
BTCUSDT: +0.5% over 10m (10 snapshots) | OI +2.0% | Funding 0.0100% rising | L/S 1.40 long-biased (rising) | Book 60/40 | SL $69000 NOT hit | TP $73000 NOT hit
```

**After (with anomalies):**
```
BTCUSDT: +3.2% over 10m (10 snapshots) | OI +12.5% | Funding 0.0800% rising EXTREME | L/S 0.65 short-biased (falling) | Book 35/65 HEAVY ASK | SL $69000 NOT hit | TP $73000 NOT hit | !! PRICE_SPIKE, OI_SPIKE detected
```

---

## Summary

| Step | What | Files |
|------|-------|-------|
| 1 | Add funding rate + trend to summary | `src/watchdog-summary.ts`, `tests/watchdog-summary.test.ts` |
| 2 | Add L/S ratio with directional bias | `src/watchdog-summary.ts`, `tests/watchdog-summary.test.ts` |
| 3 | Add order book bid/ask split + heavy imbalance flag | `src/watchdog-summary.ts`, `tests/watchdog-summary.test.ts` |
| 4 | Detect and flag anomalies within snapshot window | `src/watchdog-summary.ts`, `tests/watchdog-summary.test.ts` |
| 5 | Flag extreme funding rates (>0.05%) | `src/watchdog-summary.ts`, `tests/watchdog-summary.test.ts` |
| 6 | Full integration test for enriched summary | `tests/watchdog-summary.test.ts` |

**Total new tests:** 12
**Files changed:** 2 (`src/watchdog-summary.ts`, `tests/watchdog-summary.test.ts`)
**Backward compatibility:** Full — function signature unchanged, returns string, no changes needed in `src/trading-loop.ts` or `src/llm/prompts.ts`
**No DB migration needed** — all data already exists in `market_snapshots` table, just not extracted by the summary builder
