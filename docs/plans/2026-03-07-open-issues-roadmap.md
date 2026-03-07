# Open Issues Roadmap — Implementation Plans

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement all 11 open GitHub issues (#21-#31) in priority order P0→P5.

**Architecture:** Each issue is an independent task touching different parts of the codebase. Most modify `src/risk/manager.ts`, `src/trading-loop.ts`, `src/watchdog-summary.ts`, or `src/watchdog.ts`. Dashboard changes go to `dashboard/src/`. All changes follow existing patterns: TypeScript ESM (.js imports), Vitest tests, fire-and-forget DB writes.

**Tech Stack:** TypeScript, Vitest, Binance USDM Futures API (`binance` npm), Supabase PostgreSQL, React + Supabase JS (dashboard)

---

## Priority Map

| Priority | Issues | Risk Level |
|----------|--------|------------|
| P0 | #22 Beta-adjusted exposure | Blowup prevention |
| P1 | #30 Surface imbalancePct, #23 Regime hysteresis | Quick wins |
| P2 | #24 Weekend leverage, #28 Liquidation feed | Risk reduction |
| P3 | #25 Funding rate signal, #26 OI divergence | Signal enhancement |
| P4 | #27 OBI signal, #29 Dashboard quant metrics | Medium effort |
| P5 | #31 Limit orders, #21 EPIC Tiered Intelligence v3 | Future/scale |

---

## Task 1: Beta-Adjusted Exposure (#22) — P0

**Files:**
- Modify: `src/risk/manager.ts:145-152` (exposure check)
- Modify: `src/risk/manager.ts:1-11` (add beta map export)
- Test: `tests/risk/manager.test.ts`

**Step 1: Write the failing tests**

Add to `tests/risk/manager.test.ts`:

```typescript
describe('beta-adjusted exposure', () => {
  it('rejects correlated long positions exceeding beta-adjusted exposure', () => {
    const rm = new RiskManager({
      maxLeverage: 20, maxPositionPct: 60, maxExposurePct: 50,
      maxStopLossPct: 5, maxLossUsd: 30, maxLossPct: 0, maxDrawdownPct: 15,
    });
    const portfolio: PortfolioState = {
      balanceUsd: 1000, positions: [
        { pair: 'SOLUSDT', sizeUsd: 200, leverage: 5, side: 'LONG', entryPrice: 150, unrealizedPnlPct: 0, heldHours: 1 },
        // SOL beta=1.8 → effective margin = (200/5) * 1.8 = 72
      ],
      sessionPnl: 0, drawdownPct: 0,
    };
    // New DOGE LONG: size_pct=30% → $300 margin. DOGE beta=2.0 → effective = 300*2.0 = 600
    // Total beta-adjusted: 72 + 600 = 672 → 67.2% > 50%
    const decision: TradeDecision = {
      pair: 'DOGEUSDT', action: 'LONG', size_pct: 30, leverage: 1,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test', confidence: 70,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('beta-adjusted');
  });

  it('allows opposing positions (hedged) with reduced effective exposure', () => {
    const rm = new RiskManager({
      maxLeverage: 20, maxPositionPct: 60, maxExposurePct: 100,
      maxStopLossPct: 5, maxLossUsd: 30, maxLossPct: 0, maxDrawdownPct: 15,
    });
    const portfolio: PortfolioState = {
      balanceUsd: 1000, positions: [
        { pair: 'BTCUSDT', sizeUsd: 500, leverage: 10, side: 'LONG', entryPrice: 70000, unrealizedPnlPct: 0, heldHours: 1 },
        // BTC LONG: margin=50, beta=1.0, direction=+1 → effective = +50
      ],
      sessionPnl: 0, drawdownPct: 0,
    };
    // New ETH SHORT: size_pct=20% → $200 margin. ETH beta=1.3, direction=-1 → effective = -260
    // Net = |50 - 260| = 210 → but we use absolute sum of same-direction groups
    // Actually: sum longs = 50, sum shorts = 200*1.3 = 260 → max(50, 260) or net
    const decision: TradeDecision = {
      pair: 'ETHUSDT', action: 'SHORT', size_pct: 20, leverage: 1,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test', confidence: 70,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true);
  });

  it('uses beta=1.0 for unknown pairs', () => {
    const rm = new RiskManager({
      maxLeverage: 20, maxPositionPct: 60, maxExposurePct: 50,
      maxStopLossPct: 5, maxLossUsd: 30, maxLossPct: 0, maxDrawdownPct: 15,
    });
    const portfolio: PortfolioState = {
      balanceUsd: 1000, positions: [],
      sessionPnl: 0, drawdownPct: 0,
    };
    const decision: TradeDecision = {
      pair: 'NEWCOINUSDT', action: 'LONG', size_pct: 30, leverage: 1,
      stop_loss_pct: 2, take_profit_pct: 4, reasoning: 'test', confidence: 70,
    };
    const result = rm.validate(decision, portfolio);
    expect(result.approved).toBe(true); // 30% * 1.0 = 30% < 50%
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: FAIL — no beta-adjusted logic exists yet

**Step 3: Implement beta-adjusted exposure**

In `src/risk/manager.ts`, add beta map after the interfaces (line ~58):

```typescript
export const BETA_TO_BTC: Record<string, number> = {
  BTCUSDT: 1.0, ETHUSDT: 1.3, SOLUSDT: 1.8,
  BNBUSDT: 1.1, XRPUSDT: 1.5, DOGEUSDT: 2.0,
  ADAUSDT: 1.5, AVAXUSDT: 1.7,
};
```

Replace the exposure check block (lines 145-152) with:

```typescript
    // Beta-adjusted exposure: accounts for BTC correlation
    const getBeta = (pair: string) => BETA_TO_BTC[pair] ?? 1.0;
    const directionSign = (side: 'LONG' | 'SHORT') => side === 'LONG' ? 1 : -1;

    let longExposure = 0;
    let shortExposure = 0;
    for (const p of portfolio.positions) {
      const margin = p.sizeUsd / p.leverage;
      const betaMargin = margin * getBeta(p.pair);
      if (p.side === 'LONG') longExposure += betaMargin;
      else shortExposure += betaMargin;
    }

    const newMargin = (decision.size_pct / 100) * portfolio.balanceUsd;
    const newBetaMargin = newMargin * getBeta(decision.pair);
    if (decision.action === 'LONG') longExposure += newBetaMargin;
    else shortExposure += newBetaMargin;

    // Net exposure: opposing positions partially cancel
    const netExposure = Math.abs(longExposure - shortExposure);
    // Gross exposure: total risk regardless of direction
    const grossExposure = longExposure + shortExposure;
    // Use the higher of net and 50% of gross as effective exposure
    const effectiveExposure = Math.max(netExposure, grossExposure * 0.5);
    const totalExposurePct = (effectiveExposure / portfolio.balanceUsd) * 100;

    if (totalExposurePct > this.config.maxExposurePct) {
      return { approved: false, reason: `beta-adjusted exposure ${totalExposurePct.toFixed(1)}% exceeds max ${this.config.maxExposurePct}%` };
    }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts
git commit -m "feat(risk): beta-adjusted exposure — correlated liquidation protection (#22)"
```

---

## Task 2: Surface imbalancePct in Watchdog Summary (#30) — P1

**Files:**
- Modify: `src/watchdog-summary.ts:17-22` (add imbalance line)
- Test: `tests/watchdog-summary.test.ts`

**Step 1: Write the failing test**

Add to `tests/watchdog-summary.test.ts`:

```typescript
it('includes order book imbalance in summary', () => {
  const snapshots = [
    { mark_price: 70000, open_interest: 50000, imbalance_pct: 5, created_at: new Date(Date.now() - 60000).toISOString() },
    { mark_price: 70100, open_interest: 50000, imbalance_pct: 15, created_at: new Date().toISOString() },
  ];
  const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
  expect(summary).toContain('OBI +15%');
});

it('shows negative OBI for ask-heavy book', () => {
  const snapshots = [
    { mark_price: 70000, open_interest: 50000, imbalance_pct: -20, created_at: new Date(Date.now() - 60000).toISOString() },
    { mark_price: 69800, open_interest: 50000, imbalance_pct: -25, created_at: new Date().toISOString() },
  ];
  const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
  expect(summary).toContain('OBI -25%');
});

it('omits OBI when imbalance_pct is null', () => {
  const snapshots = [
    { mark_price: 70000, open_interest: 50000, created_at: new Date(Date.now() - 60000).toISOString() },
    { mark_price: 70100, open_interest: 50000, created_at: new Date().toISOString() },
  ];
  const summary = buildWatchdogSummary('BTCUSDT', snapshots as any, undefined);
  expect(summary).not.toContain('OBI');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: FAIL — OBI not in summary

**Step 3: Add imbalancePct to watchdog summary**

In `src/watchdog-summary.ts`, after the OI block (after line 22), add:

```typescript
  // Order Book Imbalance
  if (last.imbalance_pct != null) {
    const obi = Number(last.imbalance_pct);
    summary += ` | OBI ${obi >= 0 ? '+' : ''}${obi.toFixed(0)}%`;
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "feat(watchdog): surface imbalancePct (OBI) in Brain summary (#30)"
```

---

## Task 3: Regime Hysteresis (#23) — P1

**Files:**
- Modify: `src/trading-loop.ts:439-464` (regime classification section)
- Create: `src/market/regime-hysteresis.ts`
- Test: `tests/market/regime-hysteresis.test.ts`

**Step 1: Write the failing tests**

Create `tests/market/regime-hysteresis.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { RegimeHysteresis } from '../../src/market/regime-hysteresis.js';
import { MarketRegime } from '../../src/market/regime-classifier.js';

describe('RegimeHysteresis', () => {
  it('does not switch regime until stable for N cycles', () => {
    const h = new RegimeHysteresis(3);

    // Start with Range (default)
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.Range);
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.Range);
    // 3rd consecutive BullTrend → switch
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.BullTrend);
  });

  it('resets counter on regime change', () => {
    const h = new RegimeHysteresis(3);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    // Interrupted by Range
    h.update('BTCUSDT', MarketRegime.Range);
    // Back to BullTrend — counter resets
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.Range);
  });

  it('switches immediately to Capitulation (bypass hysteresis)', () => {
    const h = new RegimeHysteresis(3);
    expect(h.update('BTCUSDT', MarketRegime.Capitulation)).toBe(MarketRegime.Capitulation);
  });

  it('tracks pairs independently', () => {
    const h = new RegimeHysteresis(2);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('ETHUSDT', MarketRegime.BearTrend);
    // BTC needs 1 more, ETH needs 1 more
    expect(h.update('BTCUSDT', MarketRegime.BullTrend)).toBe(MarketRegime.BullTrend);
    expect(h.update('ETHUSDT', MarketRegime.BearTrend)).toBe(MarketRegime.BearTrend);
  });

  it('returns current confirmed regime via get()', () => {
    const h = new RegimeHysteresis(2);
    expect(h.get('BTCUSDT')).toBe(MarketRegime.Range);
    h.update('BTCUSDT', MarketRegime.Breakout);
    h.update('BTCUSDT', MarketRegime.Breakout);
    expect(h.get('BTCUSDT')).toBe(MarketRegime.Breakout);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/regime-hysteresis.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement RegimeHysteresis**

Create `src/market/regime-hysteresis.ts`:

```typescript
import { MarketRegime } from './regime-classifier.js';

const BYPASS_REGIMES = new Set([MarketRegime.Capitulation]);

export class RegimeHysteresis {
  private confirmed = new Map<string, MarketRegime>();
  private pending = new Map<string, { regime: MarketRegime; count: number }>();

  constructor(private requiredCycles: number = 3) {}

  update(pair: string, newRegime: MarketRegime): MarketRegime {
    // Capitulation bypasses hysteresis — react immediately
    if (BYPASS_REGIMES.has(newRegime)) {
      this.confirmed.set(pair, newRegime);
      this.pending.delete(pair);
      return newRegime;
    }

    const current = this.confirmed.get(pair) ?? MarketRegime.Range;
    if (newRegime === current) {
      this.pending.delete(pair);
      return current;
    }

    const p = this.pending.get(pair);
    if (p && p.regime === newRegime) {
      p.count++;
      if (p.count >= this.requiredCycles) {
        this.confirmed.set(pair, newRegime);
        this.pending.delete(pair);
        return newRegime;
      }
    } else {
      this.pending.set(pair, { regime: newRegime, count: 1 });
    }

    return current;
  }

  get(pair: string): MarketRegime {
    return this.confirmed.get(pair) ?? MarketRegime.Range;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/market/regime-hysteresis.test.ts`
Expected: ALL PASS

**Step 5: Wire into TradingLoop**

In `src/trading-loop.ts`:

1. Add import (top of file):
```typescript
import { RegimeHysteresis } from './market/regime-hysteresis.js';
```

2. Add instance property in `TradingLoop` class:
```typescript
private regimeHysteresis = new RegimeHysteresis(3);
```

3. Replace lines 448-453 (inside the `for (const snap of snapshots)` loop):
```typescript
        if (ind) {
          const raw = classifyRegime(ind, parseFloat(snap.markPrice), fearGreed);
          const confirmedRegime = this.regimeHysteresis.update(snap.pair, raw.regime);
          pairRegimes.set(snap.pair, {
            regime: confirmedRegime,
            confidence: raw.confidence,
            profile: getFilterProfile(confirmedRegime),
          });
        }
```

**Step 6: Run full test suite**

Run: `npx vitest run tests/market/ tests/trading-loop.test.ts`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/market/regime-hysteresis.ts tests/market/regime-hysteresis.test.ts src/trading-loop.ts
git commit -m "feat(market): regime hysteresis — prevent strategy churn (#23)"
```

---

## Task 4: Weekend Leverage Reduction (#24) — P2

**Files:**
- Modify: `src/trading-loop.ts:1067-1073` (after profile leverage multiplier)
- Modify: `config.yaml` (add weekendLeverageMultiplier)
- Modify: `src/config.ts` (add field to Config)
- Test: `tests/trading-loop.test.ts`

**Step 1: Write the failing test**

Add to `tests/trading-loop.test.ts` (or a new focused test file `tests/market/weekend-leverage.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';

describe('weekend leverage reduction', () => {
  it('applies 0.5x multiplier on Saturday (UTC day 6)', () => {
    const leverage = 10;
    const dayOfWeek = 6; // Saturday
    const weekendMultiplier = 0.5;
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const adjusted = isWeekend
      ? Math.max(1, Math.round(leverage * weekendMultiplier))
      : leverage;
    expect(adjusted).toBe(5);
  });

  it('applies 0.5x multiplier on Sunday (UTC day 0)', () => {
    const leverage = 10;
    const dayOfWeek = 0; // Sunday
    const weekendMultiplier = 0.5;
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const adjusted = isWeekend
      ? Math.max(1, Math.round(leverage * weekendMultiplier))
      : leverage;
    expect(adjusted).toBe(5);
  });

  it('does not reduce on weekday', () => {
    const leverage = 10;
    const dayOfWeek = 3; // Wednesday
    const weekendMultiplier = 0.5;
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const adjusted = isWeekend
      ? Math.max(1, Math.round(leverage * weekendMultiplier))
      : leverage;
    expect(adjusted).toBe(10);
  });

  it('never reduces below 1x', () => {
    const leverage = 1;
    const weekendMultiplier = 0.5;
    const adjusted = Math.max(1, Math.round(leverage * weekendMultiplier));
    expect(adjusted).toBe(1);
  });
});
```

**Step 2: Run test — should pass (pure logic test)**

Run: `npx vitest run tests/market/weekend-leverage.test.ts`
Expected: PASS (logic is standalone)

**Step 3: Add weekend multiplier to config**

In `config.yaml`, add under `trading:`:
```yaml
  weekendLeverageMultiplier: 0.5
```

In `src/config.ts`, add to trading config parsing (where other trading fields are read):
```typescript
weekendLeverageMultiplier: yaml.trading?.weekendLeverageMultiplier ?? 0.5,
```

**Step 4: Apply in TradingLoop**

In `src/trading-loop.ts`, after the profile leverage multiplier (after line 1073), add:

```typescript
          // Weekend leverage reduction
          const isWeekend = [0, 6].includes(new Date().getUTCDay());
          if (isWeekend) {
            const weekendMult = this.deps.tradingConfig.weekendLeverageMultiplier ?? 0.5;
            decision.leverage = Math.max(1, Math.round(decision.leverage * weekendMult));
            console.log(`[Weekend] Reduced ${decision.pair} leverage to ${decision.leverage}x`);
          }
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/trading-loop.ts src/config.ts config.yaml tests/market/weekend-leverage.test.ts
git commit -m "feat(risk): weekend leverage reduction — 0.5x on Sat/Sun (#24)"
```

---

## Task 5: Liquidation Feed via Binance WS (#28) — P2

**Files:**
- Create: `src/binance/liquidation-feed.ts`
- Modify: `src/db/types.ts` (add DbLiquidation interface)
- Modify: `src/db/repository.ts` (add insert/query methods)
- Modify: `src/watchdog-summary.ts` (add liquidation spike to summary)
- Modify: `src/index.ts` (wire feed startup)
- Migration: `supabase/migrations/xxx_create_liquidations.sql`
- Test: `tests/binance/liquidation-feed.test.ts`

**Step 1: Write the failing tests**

Create `tests/binance/liquidation-feed.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { LiquidationAggregator } from '../../src/binance/liquidation-feed.js';

describe('LiquidationAggregator', () => {
  it('aggregates liquidation events into 1-minute buckets', () => {
    const agg = new LiquidationAggregator();

    agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.5, price: 70000, timestamp: Date.now() });
    agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.3, price: 69500, timestamp: Date.now() });
    agg.addEvent({ pair: 'BTCUSDT', side: 'BUY', quantity: 0.1, price: 71000, timestamp: Date.now() });

    const snapshot = agg.flush('BTCUSDT');
    expect(snapshot.longLiquidations).toBe(2);      // SELL = long got liquidated
    expect(snapshot.shortLiquidations).toBe(1);      // BUY = short got liquidated
    expect(snapshot.longLiqUsd).toBeCloseTo(0.5 * 70000 + 0.3 * 69500);
    expect(snapshot.shortLiqUsd).toBeCloseTo(0.1 * 71000);
  });

  it('returns zero snapshot when no events', () => {
    const agg = new LiquidationAggregator();
    const snapshot = agg.flush('BTCUSDT');
    expect(snapshot.longLiquidations).toBe(0);
    expect(snapshot.shortLiquidations).toBe(0);
  });

  it('detects spike when count exceeds rolling average by 5x', () => {
    const agg = new LiquidationAggregator();
    // Simulate low baseline: 2 events per flush for 10 flushes
    for (let i = 0; i < 10; i++) {
      agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.1, price: 70000, timestamp: Date.now() });
      agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.1, price: 70000, timestamp: Date.now() });
      agg.flush('BTCUSDT');
    }
    // Spike: 15 events
    for (let i = 0; i < 15; i++) {
      agg.addEvent({ pair: 'BTCUSDT', side: 'SELL', quantity: 0.5, price: 70000, timestamp: Date.now() });
    }
    const snapshot = agg.flush('BTCUSDT');
    expect(snapshot.spikeRatio).toBeGreaterThan(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/binance/liquidation-feed.test.ts`
Expected: FAIL — module does not exist

**Step 3: Create LiquidationAggregator**

Create `src/binance/liquidation-feed.ts`:

```typescript
export interface LiquidationEvent {
  pair: string;
  side: 'BUY' | 'SELL'; // BUY = short liq, SELL = long liq
  quantity: number;
  price: number;
  timestamp: number;
}

export interface LiquidationSnapshot {
  longLiquidations: number;
  shortLiquidations: number;
  longLiqUsd: number;
  shortLiqUsd: number;
  spikeRatio: number;
}

const ROLLING_WINDOW = 20;

export class LiquidationAggregator {
  private buffer = new Map<string, LiquidationEvent[]>();
  private history = new Map<string, number[]>(); // rolling count history

  addEvent(event: LiquidationEvent): void {
    const buf = this.buffer.get(event.pair) ?? [];
    buf.push(event);
    this.buffer.set(event.pair, buf);
  }

  flush(pair: string): LiquidationSnapshot {
    const events = this.buffer.get(pair) ?? [];
    this.buffer.set(pair, []);

    let longLiquidations = 0, shortLiquidations = 0;
    let longLiqUsd = 0, shortLiqUsd = 0;

    for (const e of events) {
      const usd = e.quantity * e.price;
      if (e.side === 'SELL') {
        longLiquidations++;
        longLiqUsd += usd;
      } else {
        shortLiquidations++;
        shortLiqUsd += usd;
      }
    }

    // Rolling average for spike detection
    const hist = this.history.get(pair) ?? [];
    const totalCount = longLiquidations + shortLiquidations;
    hist.push(totalCount);
    if (hist.length > ROLLING_WINDOW) hist.shift();
    this.history.set(pair, hist);

    const avg = hist.length > 1
      ? hist.slice(0, -1).reduce((a, b) => a + b, 0) / (hist.length - 1)
      : totalCount;
    const spikeRatio = avg > 0 ? totalCount / avg : 0;

    return { longLiquidations, shortLiquidations, longLiqUsd, shortLiqUsd, spikeRatio };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/binance/liquidation-feed.test.ts`
Expected: ALL PASS

**Step 5: Add DB types and migration**

Add to `src/db/types.ts`:

```typescript
export interface DbLiquidation {
  id?: number;
  session_id?: string;
  pair: string;
  long_liquidations: number;
  short_liquidations: number;
  long_liq_usd: number;
  short_liq_usd: number;
  spike_ratio: number;
  created_at?: string;
}
```

Apply Supabase migration:

```sql
CREATE TABLE liquidations (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID,
  pair TEXT NOT NULL,
  long_liquidations INT NOT NULL DEFAULT 0,
  short_liquidations INT NOT NULL DEFAULT 0,
  long_liq_usd NUMERIC NOT NULL DEFAULT 0,
  short_liq_usd NUMERIC NOT NULL DEFAULT 0,
  spike_ratio NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_liquidations_pair_time ON liquidations(pair, created_at DESC);
```

Add repository methods in `src/db/repository.ts`:

```typescript
export async function insertLiquidation(l: Omit<DbLiquidation, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await query(
    `INSERT INTO liquidations (session_id, pair, long_liquidations, short_liquidations, long_liq_usd, short_liq_usd, spike_ratio)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [l.session_id, l.pair, l.long_liquidations, l.short_liquidations, l.long_liq_usd, l.short_liq_usd, l.spike_ratio],
  );
  return rows[0].id;
}

export async function getRecentLiquidations(pair: string, sinceMinutes: number): Promise<DbLiquidation[]> {
  const { rows } = await query(
    `SELECT * FROM liquidations WHERE pair = $1 AND created_at > NOW() - INTERVAL '1 minute' * $2 ORDER BY created_at ASC`,
    [pair, sinceMinutes],
  );
  return rows;
}
```

**Step 6: Wire Binance WS forceOrder into Watchdog**

Add WebSocket connection in `src/binance/liquidation-feed.ts`:

```typescript
import WebSocket from 'ws';

export function startLiquidationFeed(
  pairs: string[],
  aggregator: LiquidationAggregator,
): WebSocket {
  // Binance combined stream for all pairs
  const streams = pairs.map(p => `${p.toLowerCase()}@forceOrder`).join('/');
  const ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      const order = msg.data?.o;
      if (!order) return;
      aggregator.addEvent({
        pair: order.s,     // symbol
        side: order.S,     // BUY or SELL
        quantity: parseFloat(order.q),
        price: parseFloat(order.p),
        timestamp: order.T,
      });
    } catch { /* ignore parse errors */ }
  });

  ws.on('error', (err) => console.error('[LiqFeed] WS error:', err.message));
  ws.on('close', () => {
    console.log('[LiqFeed] WS closed, reconnecting in 5s...');
    setTimeout(() => startLiquidationFeed(pairs, aggregator), 5000);
  });

  return ws;
}
```

**Step 7: Wire into index.ts and Watchdog tick**

In `src/index.ts`, after watchdog start:

```typescript
import { LiquidationAggregator, startLiquidationFeed } from './binance/liquidation-feed.js';
import { insertLiquidation } from './db/repository.js';

const liqAggregator = new LiquidationAggregator();
startLiquidationFeed(config.trading.pairs, liqAggregator);
```

In `src/watchdog.ts`, add liquidation flush per pair in `processPair()` — pass aggregator via deps, flush each tick, insert to DB.

**Step 8: Surface in watchdog summary**

In `src/watchdog-summary.ts`, accept optional liquidation data and add:

```typescript
  if (liqSnapshot && liqSnapshot.spikeRatio > 1) {
    const totalLiq = liqSnapshot.longLiqUsd + liqSnapshot.shortLiqUsd;
    const dominant = liqSnapshot.longLiqUsd > liqSnapshot.shortLiqUsd ? 'LONG' : 'SHORT';
    summary += ` | Liq $${(totalLiq / 1000).toFixed(0)}K (${dominant}) ${liqSnapshot.spikeRatio > 5 ? 'SPIKE' : ''}`;
  }
```

**Step 9: Commit**

```bash
git add src/binance/liquidation-feed.ts src/db/types.ts src/db/repository.ts \
        src/watchdog-summary.ts src/watchdog.ts src/index.ts \
        tests/binance/liquidation-feed.test.ts
git commit -m "feat(data): liquidation feed via Binance WS forceOrder (#28)"
```

---

## Task 6: Funding Rate Signal (#25) — P3

**Files:**
- Create: `src/market/signals.ts` (shared signal utilities)
- Modify: `src/watchdog-summary.ts` (add funding interpretation)
- Modify: `src/trading-loop.ts` (add funding signal to confluence)
- Test: `tests/market/signals.test.ts`

**Step 1: Write the failing tests**

Create `tests/market/signals.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { interpretFundingRate, FundingSignal } from '../../src/market/signals.js';

describe('interpretFundingRate', () => {
  it('returns OVERCROWDED_LONGS for funding > 0.05%', () => {
    const signal = interpretFundingRate(0.0008);
    expect(signal.label).toBe('OVERCROWDED_LONGS');
    expect(signal.direction).toBe('bearish');
  });

  it('returns OVERCROWDED_SHORTS for funding < -0.05%', () => {
    const signal = interpretFundingRate(-0.0006);
    expect(signal.label).toBe('OVERCROWDED_SHORTS');
    expect(signal.direction).toBe('bullish');
  });

  it('returns NEUTRAL for normal funding', () => {
    const signal = interpretFundingRate(0.0002);
    expect(signal.label).toBe('NEUTRAL');
    expect(signal.direction).toBe('neutral');
  });

  it('returns EXTREME_LONGS for funding > 0.1%', () => {
    const signal = interpretFundingRate(0.0015);
    expect(signal.label).toBe('EXTREME_LONGS');
    expect(signal.direction).toBe('bearish');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/signals.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement funding rate signal**

Create `src/market/signals.ts`:

```typescript
export interface FundingSignal {
  label: 'NEUTRAL' | 'OVERCROWDED_LONGS' | 'OVERCROWDED_SHORTS' | 'EXTREME_LONGS' | 'EXTREME_SHORTS';
  direction: 'bullish' | 'bearish' | 'neutral';
  raw: number;
}

export function interpretFundingRate(rate: number): FundingSignal {
  const pct = rate * 100; // Convert to percentage (0.0001 → 0.01%)

  if (pct > 0.1) return { label: 'EXTREME_LONGS', direction: 'bearish', raw: rate };
  if (pct > 0.05) return { label: 'OVERCROWDED_LONGS', direction: 'bearish', raw: rate };
  if (pct < -0.1) return { label: 'EXTREME_SHORTS', direction: 'bullish', raw: rate };
  if (pct < -0.05) return { label: 'OVERCROWDED_SHORTS', direction: 'bullish', raw: rate };
  return { label: 'NEUTRAL', direction: 'neutral', raw: rate };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/market/signals.test.ts`
Expected: ALL PASS

**Step 5: Add funding interpretation to watchdog summary**

In `src/watchdog-summary.ts`, after the existing funding bps line (line ~33), add:

```typescript
    // Funding signal interpretation
    if (Math.abs(fr1 * 100) > 0.05) {
      const { interpretFundingRate } = await import('./market/signals.js');
      const signal = interpretFundingRate(fr1);
      summary += ` (${signal.label})`;
    }
```

Note: Since `buildWatchdogSummary` is sync, either make it async or import at top level. Prefer top-level import:

```typescript
import { interpretFundingRate } from './market/signals.js';
```

Then inline after funding bps:
```typescript
      const signal = interpretFundingRate(fr1);
      if (signal.label !== 'NEUTRAL') {
        summary += ` (${signal.label})`;
      }
```

**Step 6: Commit**

```bash
git add src/market/signals.ts tests/market/signals.test.ts src/watchdog-summary.ts
git commit -m "feat(signals): funding rate interpretation — overcrowded detection (#25)"
```

---

## Task 7: OI Divergence Signal (#26) — P3

**Files:**
- Modify: `src/market/signals.ts` (add OI divergence)
- Modify: `src/watchdog-summary.ts` (add OI divergence label)
- Test: `tests/market/signals.test.ts`

**Step 1: Write the failing tests**

Add to `tests/market/signals.test.ts`:

```typescript
import { interpretOIDivergence, OIDivergenceSignal } from '../../src/market/signals.js';

describe('interpretOIDivergence', () => {
  it('returns TREND_CONTINUATION for price up + OI up', () => {
    const signal = interpretOIDivergence(2.0, 3.0);
    expect(signal.label).toBe('TREND_CONTINUATION');
  });

  it('returns SHORT_SQUEEZE for price up + OI down', () => {
    const signal = interpretOIDivergence(1.5, -2.0);
    expect(signal.label).toBe('SHORT_SQUEEZE');
    expect(signal.direction).toBe('bearish'); // reversal risk
  });

  it('returns NEW_SHORTS for price down + OI up', () => {
    const signal = interpretOIDivergence(-1.5, 2.0);
    expect(signal.label).toBe('NEW_SHORTS');
    expect(signal.direction).toBe('bearish');
  });

  it('returns LONG_CAPITULATION for price down + OI down', () => {
    const signal = interpretOIDivergence(-2.0, -3.0);
    expect(signal.label).toBe('LONG_CAPITULATION');
    expect(signal.direction).toBe('bullish'); // potential bottom
  });

  it('returns NEUTRAL for small changes', () => {
    const signal = interpretOIDivergence(0.1, 0.2);
    expect(signal.label).toBe('NEUTRAL');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/signals.test.ts`
Expected: FAIL — `interpretOIDivergence` not found

**Step 3: Implement OI divergence**

Add to `src/market/signals.ts`:

```typescript
export interface OIDivergenceSignal {
  label: 'TREND_CONTINUATION' | 'SHORT_SQUEEZE' | 'NEW_SHORTS' | 'LONG_CAPITULATION' | 'NEUTRAL';
  direction: 'bullish' | 'bearish' | 'neutral';
}

const OI_THRESHOLD = 0.5; // minimum % change to trigger signal

export function interpretOIDivergence(priceDeltaPct: number, oiDeltaPct: number): OIDivergenceSignal {
  if (Math.abs(priceDeltaPct) < OI_THRESHOLD && Math.abs(oiDeltaPct) < OI_THRESHOLD) {
    return { label: 'NEUTRAL', direction: 'neutral' };
  }

  const priceUp = priceDeltaPct > OI_THRESHOLD;
  const priceDown = priceDeltaPct < -OI_THRESHOLD;
  const oiUp = oiDeltaPct > OI_THRESHOLD;
  const oiDown = oiDeltaPct < -OI_THRESHOLD;

  if (priceUp && oiUp) return { label: 'TREND_CONTINUATION', direction: 'bullish' };
  if (priceUp && oiDown) return { label: 'SHORT_SQUEEZE', direction: 'bearish' };
  if (priceDown && oiUp) return { label: 'NEW_SHORTS', direction: 'bearish' };
  if (priceDown && oiDown) return { label: 'LONG_CAPITULATION', direction: 'bullish' };

  return { label: 'NEUTRAL', direction: 'neutral' };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/market/signals.test.ts`
Expected: ALL PASS

**Step 5: Surface in watchdog summary**

In `src/watchdog-summary.ts`, after OI delta (line ~22), add:

```typescript
    if (first.open_interest && last.open_interest) {
      const oiDeltaNum = Number(oiDelta);
      const priceDeltaNum = Number(priceDelta);
      const divergence = interpretOIDivergence(priceDeltaNum, oiDeltaNum);
      if (divergence.label !== 'NEUTRAL') {
        summary += ` (${divergence.label})`;
      }
    }
```

**Step 6: Commit**

```bash
git add src/market/signals.ts tests/market/signals.test.ts src/watchdog-summary.ts
git commit -m "feat(signals): OI divergence detection — squeeze and capitulation signals (#26)"
```

---

## Task 8: OBI Signal (#27) — P4

**Files:**
- Modify: `src/market/signals.ts` (add OBI interpretation)
- Modify: `src/watchdog-summary.ts` (enhance existing OBI output)
- Test: `tests/market/signals.test.ts`

**Step 1: Write the failing tests**

Add to `tests/market/signals.test.ts`:

```typescript
import { interpretOBI } from '../../src/market/signals.js';

describe('interpretOBI', () => {
  it('returns BID_HEAVY for imbalance > 20%', () => {
    const signal = interpretOBI(25);
    expect(signal.label).toBe('BID_HEAVY');
    expect(signal.direction).toBe('bullish');
  });

  it('returns ASK_HEAVY for imbalance < -20%', () => {
    const signal = interpretOBI(-30);
    expect(signal.label).toBe('ASK_HEAVY');
    expect(signal.direction).toBe('bearish');
  });

  it('returns BALANCED for small imbalance', () => {
    const signal = interpretOBI(5);
    expect(signal.label).toBe('BALANCED');
  });

  it('returns EXTREME_BID for imbalance > 40%', () => {
    const signal = interpretOBI(45);
    expect(signal.label).toBe('EXTREME_BID');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/signals.test.ts`
Expected: FAIL

**Step 3: Implement OBI interpretation**

Add to `src/market/signals.ts`:

```typescript
export interface OBISignal {
  label: 'BALANCED' | 'BID_HEAVY' | 'ASK_HEAVY' | 'EXTREME_BID' | 'EXTREME_ASK';
  direction: 'bullish' | 'bearish' | 'neutral';
}

export function interpretOBI(imbalancePct: number): OBISignal {
  if (imbalancePct > 40) return { label: 'EXTREME_BID', direction: 'bullish' };
  if (imbalancePct > 20) return { label: 'BID_HEAVY', direction: 'bullish' };
  if (imbalancePct < -40) return { label: 'EXTREME_ASK', direction: 'bearish' };
  if (imbalancePct < -20) return { label: 'ASK_HEAVY', direction: 'bearish' };
  return { label: 'BALANCED', direction: 'neutral' };
}
```

**Step 4: Run tests — PASS**

Run: `npx vitest run tests/market/signals.test.ts`

**Step 5: Enhance watchdog summary OBI output**

In `src/watchdog-summary.ts`, update the OBI block to add interpretation:

```typescript
  if (last.imbalance_pct != null) {
    const obi = Number(last.imbalance_pct);
    const obiSignal = interpretOBI(obi);
    summary += ` | OBI ${obi >= 0 ? '+' : ''}${obi.toFixed(0)}%`;
    if (obiSignal.label !== 'BALANCED') {
      summary += ` (${obiSignal.label})`;
    }
  }
```

**Step 6: Commit**

```bash
git add src/market/signals.ts tests/market/signals.test.ts src/watchdog-summary.ts
git commit -m "feat(signals): OBI interpretation — bid/ask pressure detection (#27)"
```

---

## Task 9: Dashboard Quant Metrics (#29) — P4

**Files:**
- Create: `dashboard/src/hooks/useQuantMetrics.ts`
- Modify: `dashboard/src/pages/Overview.tsx` (add metrics cards)
- Test: Manual (dashboard is React, no Vitest tests)

**Step 1: Create useQuantMetrics hook**

Create `dashboard/src/hooks/useQuantMetrics.ts`:

```typescript
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface QuantMetrics {
  sharpeRatio: number | null;
  maxDrawdownPct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  tradeCount: number;
}

export function useQuantMetrics(): { metrics: QuantMetrics | null; loading: boolean } {
  const [metrics, setMetrics] = useState<QuantMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: closes } = await supabase
        .from('trade_closes')
        .select('pnl_usd, pnl_pct, closed_at')
        .order('closed_at', { ascending: true });

      if (!closes || closes.length < 5) {
        setMetrics({ sharpeRatio: null, maxDrawdownPct: null, profitFactor: null, expectancy: null, tradeCount: closes?.length ?? 0 });
        setLoading(false);
        return;
      }

      const returns = closes.map(c => c.pnl_pct);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length);

      // Sharpe (annualized, ~3 trades/day assumption)
      const sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(365 * 3) : null;

      // Max Drawdown
      let peak = 0;
      let maxDd = 0;
      let cumulative = 0;
      for (const c of closes) {
        cumulative += c.pnl_usd;
        if (cumulative > peak) peak = cumulative;
        const dd = peak > 0 ? (peak - cumulative) / peak * 100 : 0;
        if (dd > maxDd) maxDd = dd;
      }

      // Profit Factor
      const grossProfit = closes.filter(c => c.pnl_usd > 0).reduce((s, c) => s + c.pnl_usd, 0);
      const grossLoss = Math.abs(closes.filter(c => c.pnl_usd < 0).reduce((s, c) => s + c.pnl_usd, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

      // Expectancy
      const winRate = closes.filter(c => c.pnl_usd > 0).length / closes.length;
      const avgWin = grossProfit / Math.max(1, closes.filter(c => c.pnl_usd > 0).length);
      const avgLoss = grossLoss / Math.max(1, closes.filter(c => c.pnl_usd < 0).length);
      const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

      setMetrics({
        sharpeRatio: closes.length >= 30 ? sharpeRatio : null,
        maxDrawdownPct: maxDd,
        profitFactor: closes.length >= 20 ? profitFactor : null,
        expectancy: closes.length >= 30 ? expectancy : null,
        tradeCount: closes.length,
      });
      setLoading(false);
    })();
  }, []);

  return { metrics, loading };
}
```

**Step 2: Add metrics cards to Overview page**

In `dashboard/src/pages/Overview.tsx`, import and use:

```typescript
import { useQuantMetrics } from '../hooks/useQuantMetrics';
```

Add a new section after existing stats cards:

```tsx
const { metrics } = useQuantMetrics();

{metrics && (
  <div className="grid grid-cols-4 gap-4">
    <StatCard label="Sharpe Ratio" value={metrics.sharpeRatio?.toFixed(2) ?? `Need ${30 - metrics.tradeCount} more trades`} />
    <StatCard label="Max Drawdown" value={metrics.maxDrawdownPct != null ? `${metrics.maxDrawdownPct.toFixed(1)}%` : '—'} />
    <StatCard label="Profit Factor" value={metrics.profitFactor?.toFixed(2) ?? `Need ${20 - metrics.tradeCount} more trades`} />
    <StatCard label="Expectancy" value={metrics.expectancy != null ? `$${metrics.expectancy.toFixed(2)}` : '—'} />
  </div>
)}
```

**Step 3: Commit**

```bash
git add dashboard/src/hooks/useQuantMetrics.ts dashboard/src/pages/Overview.tsx
git commit -m "feat(dashboard): quant metrics — Sharpe, drawdown, profit factor, expectancy (#29)"
```

---

## Task 10: Limit Order Entry (#31) — P5

**Files:**
- Modify: `src/binance/orders.ts` (add limit order with fallback)
- Modify: `config.yaml` (add useLimitEntry flag)
- Test: `tests/binance/orders.test.ts`

**Step 1: Write the failing test**

Add to `tests/binance/orders.test.ts`:

```typescript
describe('limit order entry', () => {
  it('places LIMIT order and falls back to MARKET on timeout', async () => {
    // This test validates the flow logic
    // Mock Binance client to simulate unfilled LIMIT order
    const mockClient = {
      submitNewOrder: vi.fn()
        .mockResolvedValueOnce({ orderId: 1, status: 'NEW' })  // LIMIT placed
        .mockResolvedValueOnce({ orderId: 2, status: 'FILLED', fills: [{ price: '70000', qty: '0.001', commission: '0.01', commissionAsset: 'USDT' }] }),  // MARKET fallback
      getOrder: vi.fn().mockResolvedValue({ status: 'NEW' }),  // Not filled
      cancelOrder: vi.fn().mockResolvedValue({}),
      // ... other required methods
    };
    // Test that after limit timeout, market order executes
    // Exact implementation depends on how the flow is structured
  });
});
```

**Step 2: Implement limit entry with market fallback**

In `src/binance/orders.ts`, modify `execute()`:

```typescript
  private async attemptLimitEntry(
    pair: string, side: string, quantity: number, price: number,
  ): Promise<{ filled: boolean; order?: any }> {
    const order = await this.client.submitNewOrder({
      symbol: pair,
      side: side as any,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: String(quantity),
      price: this.formatPrice(pair, price),
    });

    // Wait up to 3 seconds for fill
    await new Promise(r => setTimeout(r, 3000));

    const status = await this.client.getOrder({ symbol: pair, orderId: order.orderId });
    if (status.status === 'FILLED') {
      return { filled: true, order: status };
    }

    // Cancel unfilled limit order
    await this.client.cancelOrder({ symbol: pair, orderId: order.orderId }).catch(() => {});
    return { filled: false };
  }
```

In `execute()`, add before MARKET order:

```typescript
    if (this.useLimitEntry) {
      const ticker = await this.client.getSymbolPriceTicker({ symbol: decision.pair });
      const limitPrice = decision.action === 'LONG'
        ? parseFloat(ticker.price)       // bid side
        : parseFloat(ticker.price);      // ask side
      const attempt = await this.attemptLimitEntry(decision.pair, side, quantity, limitPrice);
      if (attempt.filled) {
        // Use limit fill data
        // ... extract fill price, commission
        // Continue to SL/TP placement
      }
      // If not filled, fall through to MARKET
    }
```

**Step 3: Add config flag**

In `config.yaml`:
```yaml
  useLimitEntry: false  # Enable at balance > $5K
```

**Step 4: Commit**

```bash
git add src/binance/orders.ts config.yaml tests/binance/orders.test.ts
git commit -m "feat(orders): limit order entry with market fallback (#31)"
```

---

## Task 11: EPIC Tiered Intelligence v3 (#21) — P5

This is a large EPIC. See existing design doc at `docs/plans/2026-03-06-tiered-intelligence-design.md` for full architecture.

**Sub-tasks (each is a separate plan):**

### 11a: DB Schema — Daily Directives & Hourly Plans

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/repository.ts`
- Migration: `supabase/migrations/xxx_create_tiered_sessions.sql`

```sql
CREATE TABLE daily_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id),
  allowed_pairs TEXT[] NOT NULL,
  pair_bias JSONB NOT NULL DEFAULT '{}',
  max_exposure_pct NUMERIC NOT NULL DEFAULT 150,
  risk_appetite TEXT NOT NULL DEFAULT 'normal',
  banned_pairs TEXT[] DEFAULT '{}',
  key_levels JSONB DEFAULT '{}',
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE hourly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  directive_id UUID REFERENCES daily_directives(id),
  session_id UUID REFERENCES sessions(id),
  watchlist TEXT[] NOT NULL,
  entry_zones JSONB DEFAULT '{}',
  position_notes JSONB DEFAULT '{}',
  escalate_daily BOOLEAN DEFAULT FALSE,
  reasoning TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE expert_calls (
  id BIGSERIAL PRIMARY KEY,
  cycle_id UUID,
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

### 11b: StrategicSession Class

**Files:**
- Create: `src/sessions/strategic-session.ts`
- Create: `src/sessions/types.ts`
- Test: `tests/sessions/strategic-session.test.ts`

Runs 3x/day + on restart. Full expert panel (GPT + Grok). Outputs `DailyDirective`.

### 11c: TacticalSession Class

**Files:**
- Create: `src/sessions/tactical-session.ts`
- Test: `tests/sessions/tactical-session.test.ts`

Runs 1x/hour. Works within DailyDirective constraints. Outputs `HourlyPlan`.

### 11d: Constraint Injection into Brain

**Files:**
- Modify: `src/trading-loop.ts` (read latest directive + plan, inject into prompt)
- Modify: `src/llm/prompts.ts` (add directive/plan sections)

### 11e: Session Scheduler

**Files:**
- Create: `src/sessions/scheduler.ts`
- Modify: `src/index.ts` (wire scheduler)

Each sub-task should be planned in detail when ready for implementation. Create separate plan files per sub-task.

**Step 1: Start with 11a (DB schema) when ready**

```bash
git commit -m "feat(sessions): DB schema for tiered intelligence — directives, plans, expert_calls (#21)"
```

---

## File Overlap Matrix

| File | Tasks that modify it |
|------|---------------------|
| `src/risk/manager.ts` | #22 |
| `src/watchdog-summary.ts` | #30, #25, #26, #27, #28 |
| `src/trading-loop.ts` | #23, #24 |
| `src/market/signals.ts` | #25, #26, #27 (create then extend) |
| `src/db/types.ts` | #28, #21 |
| `src/db/repository.ts` | #28, #21 |
| `config.yaml` | #24, #31 |
| `src/config.ts` | #24, #31 |
| `src/index.ts` | #28 |
| `dashboard/src/pages/Overview.tsx` | #29 |

**Parallel execution safe groups (no file overlap):**
- Group A: #22 (risk) + #30 (summary) + #29 (dashboard)
- Group B: #23 + #24 (both touch trading-loop — sequential)
- Group C: #25 → #26 → #27 (all extend signals.ts — sequential)
- Group D: #28 (standalone, many files)
- Group E: #31 + #21 (future, independent)

---

## Execution Order (Recommended)

1. **Parallel batch 1:** Task 1 (#22) + Task 2 (#30) + Task 9 (#29)
2. **Sequential:** Task 3 (#23) → Task 4 (#24)
3. **Sequential:** Task 6 (#25) → Task 7 (#26) → Task 8 (#27)
4. **Independent:** Task 5 (#28)
5. **Deferred:** Task 10 (#31) + Task 11 (#21)
