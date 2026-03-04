# Max Info Fetch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Maximize market data fed to the LLM — add MACD/Bollinger/Volume indicators, 15m candles, funding rate history, long/short ratio, order book imbalance, and OI delta tracking.

**Architecture:** All new indicators computed from existing candle data (zero new API calls for Task 1). Tasks 2–3 add Binance API calls in parallel with existing ones. Task 4 tracks OI delta in the trading loop across cycles. Task 5 rewrites the prompt to surface all signals clearly.

**Tech Stack:** TypeScript, `binance` npm SDK (USDMClient), existing `computeIndicators` pattern.

---

## What's already fetched (do NOT re-fetch)

- `candles1h` + `candles4h` (50 each) — includes OHLCV, volume field present but unused
- `markPrice` (includes `lastFundingRate`)
- `openInterest`
- Fear & Greed index
- News analysis (NewsAnalystAgent)

## What's NOT fetched (this plan adds)

| Data | Source | Task |
|---|---|---|
| MACD(12,26,9) | computed from closes | Task 1 |
| Bollinger Bands(20,2) | computed from closes | Task 1 |
| Volume ratio (current/avg20) | computed from volumes | Task 1 |
| VWAP (session) | computed from OHLCV | Task 1 |
| 15m candles (last 50) | Binance API | Task 2 |
| Funding rate history (8 periods) | Binance API | Task 2 |
| Global long/short ratio | Binance API | Task 3 |
| Order book imbalance (top 5) | Binance API | Task 3 |
| OI change % vs prev cycle | trading loop state | Task 4 |

---

## Task 1: New Technical Indicators (MACD, Bollinger, Volume, VWAP)

**Files:**
- Modify: `src/indicators/technical.ts`
- Modify: `src/llm/prompts.ts` (add to prompt output)
- Modify: `src/trading-loop.ts:73-76` (pass volumes to computeIndicators)
- Test: `tests/indicators/technical.test.ts`

### Step 1: Write failing tests

```typescript
// tests/indicators/technical.test.ts — add these test cases

import { computeMACD, computeBollingerBands, computeVolumeRatio, computeVWAP, computeIndicators } from '../../src/indicators/technical.js';

describe('computeMACD', () => {
  it('returns macd, signal, histogram', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const result = computeMACD(closes);
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('histogram');
    expect(typeof result.macd).toBe('number');
  });

  it('returns zeros when not enough data', () => {
    const result = computeMACD([100, 101]);
    expect(result).toEqual({ macd: 0, signal: 0, histogram: 0 });
  });
});

describe('computeBollingerBands', () => {
  it('returns upper, middle, lower bands', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
    const result = computeBollingerBands(closes);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
    expect(typeof result.bandwidth).toBe('number');
    expect(typeof result.percentB).toBe('number');
  });
});

describe('computeVolumeRatio', () => {
  it('returns ratio > 1 when last volume is high', () => {
    const volumes = [...Array(20).fill(1000), 3000];
    expect(computeVolumeRatio(volumes)).toBeGreaterThan(1);
  });

  it('returns 1 when only one candle', () => {
    expect(computeVolumeRatio([500])).toBe(1);
  });
});

describe('computeVWAP', () => {
  it('returns volume-weighted average price', () => {
    const highs =  [105, 110, 108];
    const lows =   [95,  90,  92];
    const closes = [100, 100, 100];
    const volumes = [1000, 2000, 1000];
    const vwap = computeVWAP(highs, lows, closes, volumes);
    expect(vwap).toBeGreaterThan(95);
    expect(vwap).toBeLessThan(110);
  });
});

describe('computeIndicators with volumes', () => {
  it('includes macd, bollinger, volumeRatio, vwap in output', () => {
    const n = 60;
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.3);
    const highs = closes.map(c => c + 2);
    const lows = closes.map(c => c - 2);
    const volumes = Array.from({ length: n }, () => 1000 + Math.random() * 500);
    const result = computeIndicators(closes, highs, lows, volumes);
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('bollingerUpper');
    expect(result).toHaveProperty('bollingerLower');
    expect(result).toHaveProperty('volumeRatio');
    expect(result).toHaveProperty('vwap');
  });
});
```

### Step 2: Run tests to verify they fail

```bash
npx vitest run tests/indicators/technical.test.ts
```
Expected: FAIL — `computeMACD is not a function` etc.

### Step 3: Implement new indicators in `src/indicators/technical.ts`

Replace entire file with:

```typescript
export interface MACDResult {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;  // (upper-lower)/middle * 100
  percentB: number;   // (price-lower)/(upper-lower) * 100
}

export interface Indicators {
  rsi: number;
  ema20: number;
  ema50: number;
  atr: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerBandwidth: number;
  bollingerPercentB: number;
  volumeRatio: number;
  vwap: number;
}

export function computeRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

export function computeEMA(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

export function computeATR(
  highs: number[], lows: number[], closes: number[], period = 14,
): number {
  if (highs.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  const slice = trs.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

export function computeMACD(closes: number[], fast = 12, slow = 26, signal = 9): MACDResult {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = computeEMA(closes, fast);
  const ema26 = computeEMA(closes, slow);
  const macdLine = ema12 - ema26;
  // Compute signal line: EMA(9) of MACD values over last (signal) periods
  const macdSeries: number[] = [];
  for (let i = slow + signal; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    macdSeries.push(computeEMA(slice, fast) - computeEMA(slice, slow));
  }
  const signalLine = computeEMA(macdSeries, signal);
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine - signalLine,
  };
}

export function computeBollingerBands(closes: number[], period = 20, stdDev = 2): BollingerResult {
  if (closes.length < period) {
    const p = closes[closes.length - 1] ?? 0;
    return { upper: p, middle: p, lower: p, bandwidth: 0, percentB: 50 };
  }
  const slice = closes.slice(-period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = middle + stdDev * sd;
  const lower = middle - stdDev * sd;
  const lastPrice = closes[closes.length - 1];
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;
  const percentB = upper !== lower ? ((lastPrice - lower) / (upper - lower)) * 100 : 50;
  return { upper, middle, lower, bandwidth, percentB };
}

export function computeVolumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < 2) return 1;
  const avgSlice = volumes.slice(-period - 1, -1);
  const avg = avgSlice.reduce((s, v) => s + v, 0) / avgSlice.length;
  if (avg === 0) return 1;
  return volumes[volumes.length - 1] / avg;
}

export function computeVWAP(
  highs: number[], lows: number[], closes: number[], volumes: number[],
): number {
  if (highs.length === 0) return 0;
  let tpv = 0;
  let totalVol = 0;
  for (let i = 0; i < highs.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    tpv += typical * volumes[i];
    totalVol += volumes[i];
  }
  return totalVol > 0 ? tpv / totalVol : closes[closes.length - 1];
}

export function computeIndicators(
  closes: number[], highs: number[], lows: number[], volumes: number[] = [],
): Indicators {
  const rsi = computeRSI(closes);
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const atr = computeATR(highs, lows, closes);
  const trend = ema20 > ema50 * 1.001 ? 'bullish' : ema20 < ema50 * 0.999 ? 'bearish' : 'neutral';
  const macdResult = computeMACD(closes);
  const bb = computeBollingerBands(closes);
  const volumeRatio = volumes.length > 0 ? computeVolumeRatio(volumes) : 1;
  const vwap = volumes.length > 0
    ? computeVWAP(highs, lows, closes, volumes)
    : closes[closes.length - 1];

  return {
    rsi, ema20, ema50, atr, trend,
    macd: macdResult.macd,
    macdSignal: macdResult.signal,
    macdHistogram: macdResult.histogram,
    bollingerUpper: bb.upper,
    bollingerMiddle: bb.middle,
    bollingerLower: bb.lower,
    bollingerBandwidth: bb.bandwidth,
    bollingerPercentB: bb.percentB,
    volumeRatio,
    vwap,
  };
}
```

### Step 4: Update `src/trading-loop.ts` — pass volumes

In `src/trading-loop.ts`, find the block at ~line 72–77 and replace:

```typescript
// OLD:
const closes = snap.candles1h.map(c => parseFloat(c.close));
const highs = snap.candles1h.map(c => parseFloat(c.high));
const lows = snap.candles1h.map(c => parseFloat(c.low));
indicators.set(snap.pair, computeIndicators(closes, highs, lows));

// NEW:
const closes = snap.candles1h.map(c => parseFloat(c.close));
const highs = snap.candles1h.map(c => parseFloat(c.high));
const lows = snap.candles1h.map(c => parseFloat(c.low));
const volumes = snap.candles1h.map(c => parseFloat(c.volume));
indicators.set(snap.pair, computeIndicators(closes, highs, lows, volumes));
```

### Step 5: Update `src/llm/prompts.ts` — show new indicators

Find the block in `buildEnrichedPrompt` that shows indicators (~line 112–114) and replace:

```typescript
// OLD:
prompt += `RSI(14): ${ind.rsi.toFixed(1)} | EMA20: $${ind.ema20.toFixed(2)} | EMA50: $${ind.ema50.toFixed(2)} | ATR: $${ind.atr.toFixed(2)}\n`;
prompt += `Trend: ${ind.trend} (EMA20 ${ind.ema20 > ind.ema50 ? '>' : '<'} EMA50)\n`;

// NEW:
prompt += `RSI(14): ${ind.rsi.toFixed(1)} | EMA20: $${ind.ema20.toFixed(2)} | EMA50: $${ind.ema50.toFixed(2)} | ATR: $${ind.atr.toFixed(2)}\n`;
prompt += `Trend: ${ind.trend} | VWAP: $${ind.vwap.toFixed(2)} | Vol ratio: ${ind.volumeRatio.toFixed(2)}x\n`;
prompt += `MACD: ${ind.macd.toFixed(4)} | Signal: ${ind.macdSignal.toFixed(4)} | Hist: ${ind.macdHistogram >= 0 ? '+' : ''}${ind.macdHistogram.toFixed(4)}\n`;
prompt += `Bollinger: L=$${ind.bollingerLower.toFixed(2)} M=$${ind.bollingerMiddle.toFixed(2)} U=$${ind.bollingerUpper.toFixed(2)} | %B: ${ind.bollingerPercentB.toFixed(0)}% | BW: ${ind.bollingerBandwidth.toFixed(1)}%\n`;
```

### Step 6: Run tests

```bash
npx vitest run tests/indicators/technical.test.ts
```
Expected: All PASS (≥10 tests).

### Step 7: Commit

```bash
git add src/indicators/technical.ts src/trading-loop.ts src/llm/prompts.ts tests/indicators/technical.test.ts
git commit -m "feat: add MACD, Bollinger Bands, volume ratio, VWAP indicators"
```

---

## Task 2: Binance — 15m Candles + Funding Rate History

**Files:**
- Modify: `src/binance/market-data.ts`
- Modify: `src/llm/prompts.ts`
- Test: `tests/binance/market-data.test.ts`

**Why:**
- 15m candles = short-term momentum not visible in 1h
- Funding history = trend (is funding consistently positive → longs paying → crowded → fade)

### Step 1: Write failing test

```typescript
// tests/binance/market-data.test.ts — add to existing tests

it('getSnapshot includes candles15m and fundingHistory', async () => {
  const mockClient = {
    getKlines: vi.fn().mockResolvedValue([
      [1000, '100', '105', '95', '102', '5000', 1001, '', 10, '', '', ''],
    ]),
    getMarkPrice: vi.fn().mockResolvedValue({
      markPrice: '102.5',
      lastFundingRate: '0.0001',
    }),
    getOpenInterest: vi.fn().mockResolvedValue({ openInterest: '1234567' }),
    getFundingRateHistory: vi.fn().mockResolvedValue([
      { fundingRate: '0.0001', fundingTime: 1000 },
      { fundingRate: '0.0002', fundingTime: 2000 },
    ]),
  };

  const fetcher = new MarketDataFetcher(mockClient as any);
  const snapshot = await fetcher.getSnapshot('BTCUSDT');

  expect(snapshot.candles15m).toBeDefined();
  expect(snapshot.candles15m.length).toBeGreaterThan(0);
  expect(snapshot.fundingHistory).toBeDefined();
  expect(snapshot.fundingHistory.length).toBe(2);
  expect(snapshot.fundingHistory[0].rate).toBeCloseTo(0.0001);
});
```

### Step 2: Run to confirm failure

```bash
npx vitest run tests/binance/market-data.test.ts
```
Expected: FAIL — `candles15m` undefined.

### Step 3: Implement in `src/binance/market-data.ts`

Add to `MarketSnapshot` interface:

```typescript
export interface FundingRatePoint {
  rate: number;
  time: number;  // unix ms
}

export interface MarketSnapshot {
  pair: string;
  candles1h: CandleData[];
  candles4h: CandleData[];
  candles15m: CandleData[];           // NEW
  fundingRate: string;
  fundingHistory: FundingRatePoint[]; // NEW: last 8 periods (~8h)
  openInterest: string;
  markPrice: string;
}
```

Update `getSnapshot` to fetch in parallel:

```typescript
async getSnapshot(pair: string): Promise<MarketSnapshot> {
  const [candles1h, candles4h, candles15m, markPrice, oi, fundingHist] = await Promise.all([
    this.client.getKlines({ symbol: pair, interval: '1h', limit: 50 }),
    this.client.getKlines({ symbol: pair, interval: '4h', limit: 50 }),
    this.client.getKlines({ symbol: pair, interval: '15m', limit: 50 }),
    this.client.getMarkPrice({ symbol: pair }),
    this.client.getOpenInterest({ symbol: pair }),
    this.client.getFundingRateHistory({ symbol: pair, limit: 8 }).catch(() => []),
  ]);

  return {
    pair,
    candles1h: this.parseCandles(candles1h),
    candles4h: this.parseCandles(candles4h),
    candles15m: this.parseCandles(candles15m),
    fundingRate: markPrice.lastFundingRate,
    fundingHistory: (fundingHist as any[]).map(f => ({
      rate: parseFloat(f.fundingRate),
      time: f.fundingTime,
    })),
    openInterest: oi.openInterest,
    markPrice: markPrice.markPrice,
  };
}
```

### Step 4: Update `src/llm/prompts.ts` — show 15m RSI + funding trend

In `buildEnrichedPrompt`, after the `ind` block, add 15m RSI and funding history:

```typescript
// After the existing indicators block:
const closes15m = snap.candles15m.map(c => parseFloat(c.close));
const rsi15m = closes15m.length > 15 ? computeRSI(closes15m) : null;
if (rsi15m !== null) {
  prompt += `RSI(14) 15m: ${rsi15m.toFixed(1)}\n`;
}

// Funding history summary:
if (snap.fundingHistory.length > 0) {
  const avg = snap.fundingHistory.reduce((s, f) => s + f.rate, 0) / snap.fundingHistory.length;
  const trend = snap.fundingHistory.length >= 2
    ? (snap.fundingHistory[snap.fundingHistory.length - 1].rate > snap.fundingHistory[0].rate ? '↑' : '↓')
    : '→';
  prompt += `Funding history (${snap.fundingHistory.length} periods): avg=${(avg * 100).toFixed(4)}% trend=${trend}\n`;
}
```

Also add `import { computeRSI } from '../indicators/technical.js';` at the top of prompts.ts.

### Step 5: Run tests

```bash
npx vitest run tests/binance/market-data.test.ts
```
Expected: PASS.

### Step 6: Commit

```bash
git add src/binance/market-data.ts src/llm/prompts.ts tests/binance/market-data.test.ts
git commit -m "feat: add 15m candles and funding rate history to market snapshot"
```

---

## Task 3: Binance — Long/Short Ratio + Order Book Imbalance

**Files:**
- Modify: `src/binance/market-data.ts`
- Modify: `src/llm/prompts.ts`
- Test: `tests/binance/market-data.test.ts`

**Why:**
- Long/short ratio = crowd positioning (contrarian signal: extreme longs → potential short squeeze)
- Order book imbalance = bid vs ask depth in top 5 levels → short-term price pressure direction

### Step 1: Write failing tests

```typescript
it('getSnapshot includes longShortRatio and orderBookImbalance', async () => {
  const mockClient = {
    // ... same mock as before, plus:
    getTopLongShortPositionRatio: vi.fn().mockResolvedValue([
      { longShortRatio: '1.23', longAccount: '0.55', shortAccount: '0.45', timestamp: 1000 },
    ]),
    getOrderBook: vi.fn().mockResolvedValue({
      bids: [['100', '5'], ['99', '10'], ['98', '8'], ['97', '3'], ['96', '2']],
      asks: [['101', '3'], ['102', '6'], ['103', '4'], ['104', '2'], ['105', '1']],
    }),
    // ... other mocks
  };

  const snapshot = await new MarketDataFetcher(mockClient as any).getSnapshot('BTCUSDT');

  expect(snapshot.longShortRatio).toBeCloseTo(1.23);
  expect(snapshot.orderBookBidPct).toBeGreaterThan(0);
  expect(snapshot.orderBookAskPct).toBeGreaterThan(0);
  expect(snapshot.orderBookBidPct + snapshot.orderBookAskPct).toBeCloseTo(100, 0);
});
```

### Step 2: Run to confirm failure

```bash
npx vitest run tests/binance/market-data.test.ts
```

### Step 3: Implement in `src/binance/market-data.ts`

Add to `MarketSnapshot` interface:

```typescript
export interface MarketSnapshot {
  // ... existing fields
  longShortRatio: number | null;  // global accounts L/S ratio, null if API fails
  orderBookBidPct: number;        // % of top-5 depth that is bids
  orderBookAskPct: number;        // % of top-5 depth that is asks
}
```

Update `getSnapshot`:

```typescript
async getSnapshot(pair: string): Promise<MarketSnapshot> {
  const [candles1h, candles4h, candles15m, markPrice, oi, fundingHist, lsRatio, orderBook] =
    await Promise.all([
      this.client.getKlines({ symbol: pair, interval: '1h', limit: 50 }),
      this.client.getKlines({ symbol: pair, interval: '4h', limit: 50 }),
      this.client.getKlines({ symbol: pair, interval: '15m', limit: 50 }),
      this.client.getMarkPrice({ symbol: pair }),
      this.client.getOpenInterest({ symbol: pair }),
      this.client.getFundingRateHistory({ symbol: pair, limit: 8 }).catch(() => []),
      this.client.getTopLongShortPositionRatio({ symbol: pair, period: '1h', limit: 1 }).catch(() => null),
      this.client.getOrderBook({ symbol: pair, limit: 5 }),
    ]);

  // Order book imbalance
  const bids = (orderBook.bids as [string, string][]).reduce((s, [, qty]) => s + parseFloat(qty), 0);
  const asks = (orderBook.asks as [string, string][]).reduce((s, [, qty]) => s + parseFloat(qty), 0);
  const totalDepth = bids + asks;

  // Long/short ratio
  const lsData = Array.isArray(lsRatio) && lsRatio.length > 0 ? lsRatio[0] : null;

  return {
    pair,
    candles1h: this.parseCandles(candles1h),
    candles4h: this.parseCandles(candles4h),
    candles15m: this.parseCandles(candles15m),
    fundingRate: markPrice.lastFundingRate,
    fundingHistory: (fundingHist as any[]).map(f => ({
      rate: parseFloat(f.fundingRate),
      time: f.fundingTime,
    })),
    openInterest: oi.openInterest,
    markPrice: markPrice.markPrice,
    longShortRatio: lsData ? parseFloat(lsData.longShortRatio) : null,
    orderBookBidPct: totalDepth > 0 ? (bids / totalDepth) * 100 : 50,
    orderBookAskPct: totalDepth > 0 ? (asks / totalDepth) * 100 : 50,
  };
}
```

### Step 4: Update `src/llm/prompts.ts`

Add after funding history line:

```typescript
// Long/short ratio
if (snap.longShortRatio !== null) {
  const lsLabel = snap.longShortRatio > 1.5 ? ' (crowded longs ⚠)' :
                  snap.longShortRatio < 0.7 ? ' (crowded shorts ⚠)' : '';
  prompt += `L/S ratio: ${snap.longShortRatio.toFixed(2)}${lsLabel}\n`;
}

// Order book
prompt += `Order book depth: ${snap.orderBookBidPct.toFixed(0)}% bids / ${snap.orderBookAskPct.toFixed(0)}% asks\n`;
```

### Step 5: Run tests

```bash
npx vitest run tests/binance/market-data.test.ts
```
Expected: PASS.

### Step 6: Commit

```bash
git add src/binance/market-data.ts src/llm/prompts.ts tests/binance/market-data.test.ts
git commit -m "feat: add long/short ratio and order book imbalance to market snapshot"
```

---

## Task 4: OI Delta Tracking (cross-cycle)

**Files:**
- Modify: `src/trading-loop.ts`
- Modify: `src/binance/market-data.ts` (add `openInterestNum` to snapshot)
- Modify: `src/llm/prompts.ts`
- Test: `tests/trading-loop.test.ts`

**Why:** OI rising with price = trend confirmation. OI falling with price = potential reversal. Single snapshot OI number means nothing without the delta.

### Step 1: Write failing test

```typescript
// tests/trading-loop.test.ts — add to existing mocks
it('tracks OI delta across cycles', async () => {
  // snapshot returns OI=1000 first cycle, 1200 second cycle
  let callCount = 0;
  mockMarketData.getSnapshot = vi.fn().mockImplementation(() => ({
    ...baseSnapshot,
    openInterest: callCount++ === 0 ? '1000' : '1200',
  }));

  await loop.runOnce(); // cycle 1
  await loop.runOnce(); // cycle 2

  const calls = mockLLM.analyze.mock.calls;
  const secondCallSnapshots = calls[1][0].snapshots;
  expect(secondCallSnapshots[0].openInterestDelta).toBeCloseTo(20); // 20% increase
});
```

### Step 2: Run to confirm failure

```bash
npx vitest run tests/trading-loop.test.ts
```

### Step 3: Implement in `src/trading-loop.ts`

Add private state:
```typescript
private lastOI = new Map<string, number>(); // pair → OI value from previous cycle
```

In `runOnce()`, after snapshots are fetched, compute delta and attach:
```typescript
// After: const snapshots = await Promise.all(...)
const snapshotsWithDelta = snapshots.map(snap => {
  const oiNum = parseFloat(snap.openInterest);
  const prevOI = this.lastOI.get(snap.pair);
  const oiDeltaPct = prevOI ? ((oiNum - prevOI) / prevOI) * 100 : 0;
  this.lastOI.set(snap.pair, oiNum);
  return { ...snap, openInterestDelta: oiDeltaPct };
});
// Replace snapshots with snapshotsWithDelta for LLM call
```

Add `openInterestDelta?: number` to `MarketSnapshot` interface in `market-data.ts`.

### Step 4: Update `src/llm/prompts.ts`

```typescript
// Replace: prompt += `Funding: ${snap.fundingRate} | OI: ${snap.openInterest}\n`;
const oiDelta = (snap as any).openInterestDelta;
const oiDeltaStr = oiDelta !== undefined && oiDelta !== 0
  ? ` (${oiDelta >= 0 ? '+' : ''}${oiDelta.toFixed(1)}% vs prev)` : '';
prompt += `Funding: ${snap.fundingRate} | OI: ${snap.openInterest}${oiDeltaStr}\n`;
```

### Step 5: Run tests

```bash
npx vitest run tests/trading-loop.test.ts
npx vitest run
```
Expected: All PASS.

### Step 6: Commit

```bash
git add src/trading-loop.ts src/binance/market-data.ts src/llm/prompts.ts tests/trading-loop.test.ts
git commit -m "feat: track OI delta across cycles for trend confirmation"
```

---

## Task 5: System Prompt Update — Mark as LIVE account

**Files:**
- Modify: `src/llm/prompts.ts` (system prompt)

**Why:** The system prompt still says "This is a TESTNET account. Be aggressive." — the bot now trades real money. This needs to change to reduce unnecessary risk-taking.

### Step 1: Update system prompt in `buildSystemPrompt`

Find and replace in `src/llm/prompts.ts`:

```typescript
// OLD:
`- This is a TESTNET account. Be aggressive. Take positions when you see a setup.`

// NEW:
`- This is a LIVE account with real money. Be selective — only trade high-confidence setups.
- Prefer confluence: enter when RSI + MACD + volume + news all align
- Avoid entries when order book is heavily one-sided (>70% bids or asks) — potential trap`
```

### Step 2: Run all tests to confirm nothing broke

```bash
npx vitest run
```
Expected: All PASS (no test checks for this exact string).

### Step 3: Commit

```bash
git add src/llm/prompts.ts
git commit -m "fix: update system prompt from testnet to live account mode"
```

---

## Final verification

```bash
npx vitest run
npm run build
```

Both should succeed with no errors.

---

## Summary of what LLM will now receive per pair

```
### BTCUSDT
Price: $72500 | 24h: +2.3%
RSI(14): 58.2 | EMA20: $71800 | EMA50: $70500 | ATR: $850
Trend: bullish | VWAP: $71950 | Vol ratio: 1.45x
MACD: 120.50 | Signal: 95.30 | Hist: +25.20
Bollinger: L=$70200 M=$71500 U=$72800 | %B: 72% | BW: 3.6%
RSI(14) 15m: 63.1
Funding history (8 periods): avg=0.0082% trend=↑
L/S ratio: 1.34
Order book depth: 58% bids / 42% asks
OI: 85432.5 (+3.2% vs prev)
```
