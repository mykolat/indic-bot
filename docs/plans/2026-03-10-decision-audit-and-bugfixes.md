# Decision Audit System & Bug Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 discovered bugs from session 2026-03-10, then build a CLI decision audit system for retrospective analysis of bot trading decisions and swarm debates.

**Architecture:** Three new npm scripts (`audit:decision`, `audit:swarm`, `audit:hindsight`) using direct PG queries following the existing `audit-db.ts` pattern. Bug fixes target `watchdog-summary.ts`, `regime-hysteresis.ts`, and prompt assembly in `prompts.ts`.

**Tech Stack:** TypeScript ESM, `pg` for DB, existing `src/db/types.ts` interfaces, `process.argv` for CLI args.

---

## Part A: Bug Fixes

### Task 1: Commit existing bug fixes (BUG 1 + BUG 2)

Two fixes are already in the working tree from the previous session. Verify and commit.

**Files:**
- Already modified: `src/llm/swarm-agent.ts` (volumeRatio fix)
- Already modified: `src/llm/prompts.ts` (headline age fix)

**Step 1: Run tests**

Run: `npx vitest run`
Expected: All tests pass.

**Step 2: Commit**

```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts
git commit -m "fix: volumeRatio source in swarm + headline age display

BUG 1: swarm-agent used data.snapshots[0]?.volumeRatio (always undefined).
Now uses data.indicators.get('BTCUSDT')?.volumeRatio.

BUG 2: Math.round(age_hours) rounded <0.5h to 0. Now shows Xm for <1h."
```

---

### Task 2: Fix PEPE NaN in watchdog-summary.ts (BUG 3)

**Root cause:** Division by zero when `first.mark_price` or `first.open_interest` is 0. Binance API failures for low-liquidity pairs (PEPE) cause fallback to `'0'`.

**Files:**
- Modify: `src/watchdog-summary.ts:14,21,33,48`
- Create test: `tests/watchdog-summary.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/watchdog-summary.test.ts
import { describe, it, expect } from 'vitest';
import { buildWatchdogSummary } from '../src/watchdog-summary.js';
import type { DbMarketSnapshot } from '../src/db/types.js';

function snap(overrides: Partial<DbMarketSnapshot> = {}): DbMarketSnapshot {
  return {
    pair: 'PEPEUSDT',
    mark_price: 0.0000085,
    open_interest: 1000000,
    funding_rate: 0.0001,
    long_short_ratio: 1.2,
    imbalance_pct: 5,
    created_at: '2026-03-10T09:00:00Z',
    ...overrides,
  };
}

describe('buildWatchdogSummary', () => {
  it('returns no-data for empty snapshots', () => {
    expect(buildWatchdogSummary('PEPEUSDT', [], undefined)).toContain('no data');
  });

  it('handles zero mark_price without NaN', () => {
    const result = buildWatchdogSummary('PEPEUSDT', [
      snap({ mark_price: 0, created_at: '2026-03-10T09:00:00Z' }),
      snap({ mark_price: 0.0000085, created_at: '2026-03-10T09:10:00Z' }),
    ], undefined);
    expect(result).not.toContain('NaN');
  });

  it('handles zero open_interest without NaN', () => {
    const result = buildWatchdogSummary('PEPEUSDT', [
      snap({ open_interest: 0, created_at: '2026-03-10T09:00:00Z' }),
      snap({ open_interest: 500000, created_at: '2026-03-10T09:10:00Z' }),
    ], undefined);
    expect(result).not.toContain('NaN');
  });

  it('handles null imbalance_pct without NaN', () => {
    const result = buildWatchdogSummary('PEPEUSDT', [
      snap({ imbalance_pct: undefined, created_at: '2026-03-10T09:00:00Z' }),
      snap({ imbalance_pct: undefined, created_at: '2026-03-10T09:10:00Z' }),
    ], undefined);
    expect(result).not.toContain('NaN');
  });

  it('computes correct price delta for normal snapshots', () => {
    const result = buildWatchdogSummary('BTCUSDT', [
      snap({ pair: 'BTCUSDT', mark_price: 69000, created_at: '2026-03-10T09:00:00Z' }),
      snap({ pair: 'BTCUSDT', mark_price: 69690, created_at: '2026-03-10T09:10:00Z' }),
    ], undefined);
    expect(result).toContain('+1.0%');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: "handles zero mark_price" and "handles zero open_interest" FAIL with NaN in output.

**Step 3: Fix watchdog-summary.ts**

Replace the priceDelta calculation (line 14):

```typescript
// OLD:
const priceDelta = ((Number(last.mark_price) - Number(first.mark_price)) / Number(first.mark_price) * 100).toFixed(1);

// NEW:
const firstPrice = Number(first.mark_price);
const lastPrice = Number(last.mark_price);
const priceDelta = firstPrice > 0
  ? ((lastPrice - firstPrice) / firstPrice * 100).toFixed(1)
  : '0.0';
```

Replace the OI delta calculation (line 21):

```typescript
// OLD:
const oiDelta = ((Number(last.open_interest) - Number(first.open_interest)) / Number(first.open_interest) * 100).toFixed(1);

// NEW:
const firstOI = Number(first.open_interest);
const lastOI = Number(last.open_interest);
const oiDelta = firstOI > 0
  ? ((lastOI - firstOI) / firstOI * 100).toFixed(1)
  : '0.0';
```

Also guard `imbalance_pct` (line 33) — add `!isNaN(obi)` check:

```typescript
if (last.imbalance_pct != null) {
  const obi = Number(last.imbalance_pct);
  if (!isNaN(obi)) {
    const obiSignal = interpretOBI(obi);
    summary += ` | OBI ${obi >= 0 ? '+' : ''}${obi.toFixed(0)}%`;
    if (obiSignal.label !== 'BALANCED') {
      summary += ` (${obiSignal.label})`;
    }
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/watchdog-summary.test.ts`
Expected: All PASS.

**Step 5: Commit**

```bash
git add src/watchdog-summary.ts tests/watchdog-summary.test.ts
git commit -m "fix: guard NaN in watchdog summary for zero prices/OI (PEPE bug)"
```

---

### Task 3: Fix RegimeHysteresis Capitulation exit (BUG 5)

**Root cause:** Capitulation is in `BYPASS_REGIMES` — enters instantly but exits require 3 cycles of a new regime. With 30-60min cycle times, bot stays in stale Capitulation for 1.5-3 hours after conditions change.

**Files:**
- Modify: `src/market/regime-hysteresis.ts:11-16`
- Modify: `tests/market/regime-hysteresis.test.ts` (or create if missing)

**Step 1: Write the failing test**

```typescript
// tests/market/regime-hysteresis.test.ts
import { describe, it, expect } from 'vitest';
import { RegimeHysteresis } from '../../src/market/regime-hysteresis.js';
import { MarketRegime } from '../../src/market/regime-classifier.js';

describe('RegimeHysteresis', () => {
  it('enters Capitulation instantly (bypass)', () => {
    const h = new RegimeHysteresis(3);
    const result = h.update('BTCUSDT', MarketRegime.Capitulation);
    expect(result).toBe(MarketRegime.Capitulation);
  });

  it('exits Capitulation instantly when classifier disagrees', () => {
    const h = new RegimeHysteresis(3);
    h.update('BTCUSDT', MarketRegime.Capitulation);
    // Next cycle: classifier says BearTrend — should exit immediately
    const result = h.update('BTCUSDT', MarketRegime.BearTrend);
    expect(result).toBe(MarketRegime.BearTrend);
  });

  it('normal regime requires N cycles to change', () => {
    const h = new RegimeHysteresis(3);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    h.update('BTCUSDT', MarketRegime.BullTrend);
    // Now try to change — needs 3 cycles
    expect(h.update('BTCUSDT', MarketRegime.Range)).toBe(MarketRegime.BullTrend);
    expect(h.update('BTCUSDT', MarketRegime.Range)).toBe(MarketRegime.BullTrend);
    expect(h.update('BTCUSDT', MarketRegime.Range)).toBe(MarketRegime.Range); // 3rd cycle
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/market/regime-hysteresis.test.ts`
Expected: "exits Capitulation instantly" FAILS — returns Capitulation instead of BearTrend.

**Step 3: Fix regime-hysteresis.ts**

Add symmetric instant exit for BYPASS_REGIMES:

```typescript
update(pair: string, newRegime: MarketRegime): MarketRegime {
  // Instant entry for critical regimes
  if (BYPASS_REGIMES.has(newRegime)) {
    this.confirmed.set(pair, newRegime);
    this.pending.delete(pair);
    return newRegime;
  }

  const current = this.confirmed.get(pair) ?? MarketRegime.Range;

  // Instant exit from critical regimes (symmetric with instant entry)
  if (BYPASS_REGIMES.has(current) && newRegime !== current) {
    this.confirmed.set(pair, newRegime);
    this.pending.delete(pair);
    return newRegime;
  }

  if (newRegime === current) {
    this.pending.delete(pair);
    return current;
  }

  // ... rest unchanged (pending counter logic)
```

**Step 4: Run tests**

Run: `npx vitest run tests/market/regime-hysteresis.test.ts`
Expected: All PASS.

**Step 5: Commit**

```bash
git add src/market/regime-hysteresis.ts tests/market/regime-hysteresis.test.ts
git commit -m "fix: symmetric Capitulation exit in RegimeHysteresis

Capitulation entered instantly (BYPASS_REGIMES) but required 3 cycles
to exit. Now exits instantly too — prevents stale Capitulation with
low volume (BUG 5 from cycle 723)."
```

---

### Task 4: Add 4h_conflict context to prompt (BUG 4)

**Root cause investigation:** The pre-screener sets `warning: '4h_conflict'` on PASS verdicts — it does NOT block. The actual blocks are from standard filters (`low_volume`, `rsi_extreme`, `low_confluence`). The `4h_conflict` warning is not shown to the LLM.

The real issue: when 1h and 4h trends diverge, the LLM sees both indicator sets and often decides HOLD on its own. The linter already lowered the 4h confidence threshold in manager.ts from 80 to 65.

**Fix:** Add a soft prompt note when many pairs have 4h conflicts, encouraging the LLM to trade on 1h trend during transitions.

**Files:**
- Modify: `src/llm/prompts.ts` (in `buildEnrichedPrompt` near screenedOutPairs section)
- Modify: `src/trading-loop.ts` (pass 4h_conflict count to prompt data)

**Step 1: Add 4h conflict count to prompt data in trading-loop.ts**

Find where `screenedOutPairs` is assembled (around line 910) and add warnings from passed pairs:

```typescript
// After screenResult is computed (around line 830)
const conflictWarnings = screenResult?.passed
  .filter(v => v.warning === '4h_conflict')
  .map(v => v.pair) ?? [];
```

Pass it to enriched data (around line 910):

```typescript
screenedOutPairs: screenResult?.held.map(h => ({ pair: h.pair, reason: h.reason ?? 'unknown' })),
conflictWarningPairs: conflictWarnings,  // NEW
marginMode: screenResult?.marginMode,
```

**Step 2: Add prompt note in prompts.ts**

After the `screenedOutPairs` section (around line 361), add:

```typescript
if ((data as any).conflictWarningPairs?.length > 0) {
  const pairs = (data as any).conflictWarningPairs as string[];
  if (pairs.length >= 3) {
    prompt += `\n## NOTE: 1h/4h Trend Divergence (${pairs.length} pairs)\n`;
    prompt += `${pairs.join(', ')} show 1h vs 4h trend conflict. This is NORMAL during market transitions.\n`;
    prompt += `Trade on 1h trend if setup is strong. A 4h bearish trend during 1h recovery is an OPPORTUNITY, not a blocker.\n\n`;
  }
}
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All pass (no tests broken by adding optional prompt section).

**Step 4: Commit**

```bash
git add src/trading-loop.ts src/llm/prompts.ts
git commit -m "fix: add 4h conflict guidance to prompt during transitions

When 3+ pairs have 1h/4h trend divergence, add a note encouraging
the LLM to trade on 1h trend. Prevents bot passivity during
market transitions (BUG 4 from cycles 689, 707, 723)."
```

---

## Part B: Decision Audit System

### Task 5: Create `scripts/audit-decision.ts`

Deep-dive into a specific trade decision or recent decisions.

**Usage:**
```bash
npx tsx scripts/audit-decision.ts <id>          # by trade_decisions.id
npx tsx scripts/audit-decision.ts --last [n=5]  # last N action decisions
npx tsx scripts/audit-decision.ts --cycle <num> # all decisions in a cycle
```

**Files:**
- Create: `scripts/audit-decision.ts`

**Step 1: Create the script**

```typescript
/**
 * audit-decision.ts — deep audit of a specific trade decision
 * Usage:
 *   npx tsx scripts/audit-decision.ts <id>
 *   npx tsx scripts/audit-decision.ts --last [n=5]
 *   npx tsx scripts/audit-decision.ts --cycle <num>
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
});

// ── Arg parsing ──
const args = process.argv.slice(2);
let mode: 'id' | 'last' | 'cycle' = 'last';
let value: number = 5;

if (args.includes('--last')) {
  mode = 'last';
  const idx = args.indexOf('--last');
  value = parseInt(args[idx + 1] || '5', 10);
} else if (args.includes('--cycle')) {
  mode = 'cycle';
  const idx = args.indexOf('--cycle');
  value = parseInt(args[idx + 1] || '0', 10);
} else if (args[0] && !args[0].startsWith('--')) {
  mode = 'id';
  value = parseInt(args[0], 10);
}

function section(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function row(label: string, val: string | number | null | undefined) {
  if (val == null) return;
  console.log(`  ${String(label).padEnd(28)} ${val}`);
}

function pnlColor(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

try {
  // ── Fetch decisions ──
  let whereClause: string;
  let params: any[];

  if (mode === 'id') {
    whereClause = 'td.id = $1';
    params = [value];
  } else if (mode === 'cycle') {
    whereClause = 'td.cycle_id = $1';
    params = [value];
  } else {
    whereClause = "td.action IN ('LONG','SHORT','CLOSE')";
    params = [];
  }

  const limitClause = mode === 'last' ? `LIMIT ${value}` : '';

  const { rows: decisions } = await pool.query(`
    SELECT
      td.id, td.pair, td.action, td.confidence, td.leverage,
      td.stop_loss_pct, td.take_profit_pct, td.size_pct,
      td.reasoning, td.regime, td.regime_confidence,
      td.volume_ratio, td.confluence_score, td.confluence_factors,
      td.conversation_id, td.cycle_id, td.created_at,
      td.session, td.session_fit_score
    FROM trade_decisions td
    WHERE ${whereClause}
    ORDER BY td.created_at DESC
    ${limitClause}
  `, params);

  if (decisions.length === 0) {
    console.log('No decisions found.');
    process.exit(0);
  }

  for (const d of decisions) {
    const ts = new Date(d.created_at).toISOString().replace('T', ' ').slice(0, 19);
    section(`DECISION #${d.id}: ${d.pair} ${d.action} (${ts})`);

    // ── Decision details ──
    row('Confidence', `${d.confidence}%`);
    row('Leverage', `${d.leverage}x`);
    row('Size', `${d.size_pct}%`);
    row('SL', d.stop_loss_pct ? `${Number(d.stop_loss_pct).toFixed(1)}%` : null);
    row('TP', d.take_profit_pct ? `${Number(d.take_profit_pct).toFixed(1)}%` : null);
    row('Regime', d.regime ? `${d.regime} (${d.regime_confidence ?? '?'}%)` : null);
    row('Volume ratio', d.volume_ratio ? `${Number(d.volume_ratio).toFixed(2)}x` : null);
    row('Confluence', d.confluence_score ? `${d.confluence_score}/5 [${(d.confluence_factors || []).join(',')}]` : null);
    row('Session', d.session ?? null);
    row('Session fit', d.session_fit_score ?? null);
    if (d.reasoning) {
      console.log(`  Reasoning:  ${d.reasoning}`);
    }

    // ── Cycle context ──
    if (d.cycle_id) {
      const { rows: [cycle] } = await pool.query(
        `SELECT cycle_number, balance, session_pnl, regime, volume_ratio,
                confluence_score, fear_greed_value, layer, filter_warning
         FROM cycles WHERE id = $1`, [d.cycle_id]);
      if (cycle) {
        console.log(`\n  ── CYCLE #${cycle.cycle_number} ──`);
        row('Balance', `$${Number(cycle.balance).toFixed(2)}`);
        row('Session P&L', cycle.session_pnl != null ? pnlColor(Number(cycle.session_pnl)) : null);
        row('F&G', cycle.fear_greed_value);
        row('Layer', cycle.layer);
        row('Filter warning', cycle.filter_warning);
      }
    }

    // ── Risk validation ──
    const { rows: [rv] } = await pool.query(
      `SELECT passed, rejection_reason, checks, shutdown_triggered
       FROM risk_validations WHERE decision_id = $1`, [d.id]);
    if (rv) {
      console.log(`\n  ── RISK VALIDATION ──`);
      row('Passed', rv.passed ? '✓ YES' : '✗ NO');
      if (rv.rejection_reason) row('Rejection', rv.rejection_reason);
      if (rv.checks) {
        const checks = typeof rv.checks === 'string' ? JSON.parse(rv.checks) : rv.checks;
        const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
        if (failed.length > 0) row('Failed checks', failed.join(', '));
      }
      if (rv.shutdown_triggered) row('SHUTDOWN', '⚠ TRIGGERED');
    }

    // ── Execution ──
    const { rows: [exec] } = await pool.query(
      `SELECT id, fill_price, quantity, leverage, sl_price, tp_price,
              entry_thesis, was_swarm, regime_at_entry, confluence_at_entry,
              volume_ratio_at_entry, fear_greed_at_entry, commission_usd, opened_at
       FROM trade_executions WHERE decision_id = $1`, [d.id]);
    if (exec) {
      console.log(`\n  ── EXECUTION ──`);
      row('Fill price', `$${Number(exec.fill_price).toFixed(2)}`);
      row('Quantity', exec.quantity);
      row('Leverage', `${exec.leverage}x`);
      row('SL', exec.sl_price ? `$${Number(exec.sl_price).toFixed(2)}` : null);
      row('TP', exec.tp_price ? `$${Number(exec.tp_price).toFixed(2)}` : null);
      row('Commission', exec.commission_usd ? `$${Number(exec.commission_usd).toFixed(4)}` : null);
      row('Swarm', exec.was_swarm ? 'YES' : 'no');
      if (exec.entry_thesis) {
        console.log(`  Entry thesis: "${exec.entry_thesis}"`);
      }

      // ── Close ──
      const { rows: [close] } = await pool.query(
        `SELECT exit_price, exit_reason, pnl_usd, pnl_pct, held_hours,
                holding_time_minutes, regime_at_exit, closed_at
         FROM trade_closes WHERE execution_id = $1`, [exec.id]);
      if (close) {
        console.log(`\n  ── CLOSE ──`);
        row('Exit price', `$${Number(close.exit_price).toFixed(2)}`);
        row('Reason', close.exit_reason);
        row('P&L', `${pnlColor(Number(close.pnl_usd))} (${Number(close.pnl_pct).toFixed(1)}%)`);
        row('Held', close.held_hours ? `${Number(close.held_hours).toFixed(1)}h` : `${close.holding_time_minutes}m`);
        row('Regime at exit', close.regime_at_exit);
      } else {
        console.log('\n  ── STILL OPEN ──');
      }

      // ── Hindsight: price after decision ──
      console.log(`\n  ── HINDSIGHT ──`);
      const entryPrice = Number(exec.fill_price);
      const decisionTime = exec.opened_at || d.created_at;

      for (const [label, mins] of [['1h', 60], ['4h', 240], ['24h', 1440]] as const) {
        const { rows: [snap] } = await pool.query(`
          SELECT mark_price, created_at FROM market_snapshots
          WHERE pair = $1
            AND created_at >= $2::timestamptz + INTERVAL '${mins} minutes' - INTERVAL '5 minutes'
            AND created_at <= $2::timestamptz + INTERVAL '${mins} minutes' + INTERVAL '5 minutes'
          ORDER BY created_at ASC LIMIT 1
        `, [d.pair, decisionTime]);

        if (snap) {
          const futurePrice = Number(snap.mark_price);
          const delta = ((futurePrice - entryPrice) / entryPrice * 100).toFixed(2);
          const sign = Number(delta) >= 0 ? '+' : '';
          row(`Price +${label}`, `$${futurePrice.toFixed(2)} (${sign}${delta}%)`);
        } else {
          row(`Price +${label}`, 'no data (snapshot expired)');
        }
      }

      // Verdict
      if (close) {
        const pnl = Number(close.pnl_usd);
        const verdict = pnl > 0 ? '✓ CORRECT (profitable)' :
                        pnl > -2 ? '~ NEUTRAL (small loss)' :
                        '✗ INCORRECT (significant loss)';
        row('Verdict', verdict);
      }
    } else if (d.action !== 'HOLD') {
      console.log('\n  Not executed (risk rejected or order failed)');
    }

    // ── Trade story (if exists) ──
    if (exec) {
      const { rows: [story] } = await pool.query(
        `SELECT story, lesson FROM trade_stories WHERE execution_id = $1`, [exec.id]);
      if (story) {
        console.log(`\n  ── TRADE STORY ──`);
        if (story.story) console.log(`  ${story.story}`);
        if (story.lesson) console.log(`  Lesson: ${story.lesson}`);
      }
    }
  }

  console.log('\n');
} catch (err: any) {
  console.error('DB error:', err.message);
} finally {
  await pool.end();
}
```

**Step 2: Test locally**

Run: `npx tsx scripts/audit-decision.ts --last 3`
Expected: Console output showing recent decisions with context. (Requires DATABASE_URL.)

**Step 3: Add npm script to package.json**

Add to `scripts` section:

```json
"audit:decision": "tsx scripts/audit-decision.ts"
```

**Step 4: Commit**

```bash
git add scripts/audit-decision.ts package.json
git commit -m "feat: add audit:decision script for deep decision analysis

Usage: npm run audit:decision [id | --last N | --cycle N]
Shows: decision context, risk validation, execution, close, hindsight prices."
```

---

### Task 6: Create `scripts/audit-swarm.ts`

Deep-dive into a specific swarm debate — all personas, votes, blackboard state, judge verdict.

**Usage:**
```bash
npx tsx scripts/audit-swarm.ts <conversation_id>   # by llm_conversations.id
npx tsx scripts/audit-swarm.ts --last [n=1]         # last N debates
npx tsx scripts/audit-swarm.ts --cycle <num>        # debate from a cycle
```

**Files:**
- Create: `scripts/audit-swarm.ts`

**Step 1: Create the script**

```typescript
/**
 * audit-swarm.ts — deep audit of a swarm Blackboard debate
 * Usage:
 *   npx tsx scripts/audit-swarm.ts <conversation_id>
 *   npx tsx scripts/audit-swarm.ts --last [n=1]
 *   npx tsx scripts/audit-swarm.ts --cycle <num>
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
});

// ── Arg parsing ──
const args = process.argv.slice(2);
let mode: 'id' | 'last' | 'cycle' = 'last';
let value: number = 1;

if (args.includes('--last')) {
  mode = 'last';
  const idx = args.indexOf('--last');
  value = parseInt(args[idx + 1] || '1', 10);
} else if (args.includes('--cycle')) {
  mode = 'cycle';
  const idx = args.indexOf('--cycle');
  value = parseInt(args[idx + 1] || '0', 10);
} else if (args[0] && !args[0].startsWith('--')) {
  mode = 'id';
  value = parseInt(args[0], 10);
}

function section(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function row(label: string, val: string | number | null | undefined) {
  if (val == null) return;
  console.log(`  ${String(label).padEnd(28)} ${val}`);
}

try {
  // ── Fetch swarm conversations ──
  let whereClause: string;
  let params: any[];

  if (mode === 'id') {
    whereClause = 'lc.id = $1';
    params = [value];
  } else if (mode === 'cycle') {
    whereClause = 'lc.cycle_id = $1';
    params = [value];
  } else {
    whereClause = '1=1';
    params = [];
  }

  const limitClause = mode === 'last' ? `LIMIT ${value}` : '';

  const { rows: conversations } = await pool.query(`
    SELECT lc.id, lc.cycle_id, lc.session_id, lc.layer, lc.model, lc.method,
           lc.label, lc.tokens_in, lc.tokens_out, lc.latency_ms,
           lc.parsed_ok, lc.parse_error, lc.blackboard_state, lc.created_at,
           lc.raw_response
    FROM llm_conversations lc
    WHERE ${whereClause}
      AND lc.method = 'swarm_consensus'
    ORDER BY lc.created_at DESC
    ${limitClause}
  `, params);

  if (conversations.length === 0) {
    console.log('No swarm debates found.');
    process.exit(0);
  }

  for (const conv of conversations) {
    const ts = new Date(conv.created_at).toISOString().replace('T', ' ').slice(0, 19);
    section(`SWARM DEBATE conv#${conv.id} (${ts})`);

    // ── Blackboard state ──
    const bb = conv.blackboard_state;
    if (bb?.market) {
      console.log(`\n  ── MARKET CONTEXT ──`);
      row('Pairs', bb.market.pairs?.join(', '));
      row('Regime', bb.market.regime);
      row('F&G', bb.market.fearGreed);
      row('Volume ratio', bb.market.volumeRatio ? `${bb.market.volumeRatio}x` : null);
    }

    // ── Cycle context ──
    if (conv.cycle_id) {
      const { rows: [cycle] } = await pool.query(
        `SELECT cycle_number, balance, session_pnl, regime, volume_ratio,
                fear_greed_value, layer, filter_warning
         FROM cycles WHERE id = $1`, [conv.cycle_id]);
      if (cycle) {
        console.log(`\n  ── CYCLE #${cycle.cycle_number} ──`);
        row('Balance', `$${Number(cycle.balance).toFixed(2)}`);
        row('Session P&L', cycle.session_pnl != null ? `${Number(cycle.session_pnl) >= 0 ? '+' : ''}$${Number(cycle.session_pnl).toFixed(2)}` : null);
        row('Layer', cycle.layer);
      }
    }

    // ── Persona votes ──
    const { rows: personas } = await pool.query(`
      SELECT persona, model, vote, confidence, reasoning, phase,
             conflicts_with, signals, raw_response, tokens_in, tokens_out
      FROM swarm_personas
      WHERE conversation_id = $1
      ORDER BY phase ASC, persona ASC
    `, [conv.id]);

    if (personas.length > 0) {
      let currentPhase = 0;
      for (const p of personas) {
        if (p.phase !== currentPhase) {
          currentPhase = p.phase;
          console.log(`\n  ── ROUND ${currentPhase} ──`);
        }

        const code = p.persona.slice(0, 2).toUpperCase();
        const conf = p.confidence ? ` (c:${p.confidence}` : '';
        const prob = '';
        const confEnd = conf ? ')' : '';
        const voteStr = p.vote ? `${p.vote}${conf}${confEnd}` : 'NO VOTE';
        const model = p.model === 'grok' ? ' [Grok]' : '';

        console.log(`  ${code} ${p.persona}: ${voteStr}${model}`);
        if (p.reasoning) {
          console.log(`     ${p.reasoning.slice(0, 200)}`);
        }

        // Signals
        const sig = p.signals;
        if (sig) {
          const parts: string[] = [];
          if (sig.bullish?.length) parts.push(`▲ ${sig.bullish.join(', ')}`);
          if (sig.bearish?.length) parts.push(`▼ ${sig.bearish.join(', ')}`);
          if (parts.length > 0) console.log(`     Signals: ${parts.join(' | ')}`);
        }

        // Conflicts
        if (p.conflicts_with && Object.keys(p.conflicts_with).length > 0) {
          const conflicts = Object.entries(p.conflicts_with).map(([k, v]) => `${k}: ${v}`).join(', ');
          console.log(`     Conflicts: ${conflicts}`);
        }
      }
    }

    // ── Blackboard conflicts ──
    if (bb?.conflicts?.length > 0) {
      console.log(`\n  ── BLACKBOARD CONFLICTS ──`);
      for (const c of bb.conflicts) {
        console.log(`  ${c.between?.[0] ?? '?'} ↔ ${c.between?.[1] ?? '?'}: ${c.reason ?? ''} (${c.severity ?? 'unknown'})`);
      }
    }

    // ── Judge verdict ──
    console.log(`\n  ── JUDGE VERDICT ──`);
    row('Label', conv.label);
    row('Parsed OK', conv.parsed_ok ? 'YES' : 'NO');
    if (conv.parse_error) row('Parse error', conv.parse_error);
    row('Tokens', `in:${conv.tokens_in ?? '?'} out:${conv.tokens_out ?? '?'}`);
    row('Latency', conv.latency_ms ? `${conv.latency_ms}ms` : null);

    // Parse judge raw response for decisions
    let judgeResult: any;
    try {
      judgeResult = JSON.parse(conv.raw_response);
    } catch {
      const match = conv.raw_response?.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
      if (match) { try { judgeResult = JSON.parse(match[0]); } catch { /* */ } }
    }

    if (judgeResult) {
      row('Continue', judgeResult.continue ? 'YES' : 'NO');
      row('Verdict', judgeResult.verdict);
      row('Next check', judgeResult.next_check_minutes ? `${judgeResult.next_check_minutes} min` : null);

      if (judgeResult.decisions?.length > 0) {
        console.log(`\n  ── DECISIONS ──`);
        for (const dec of judgeResult.decisions) {
          const conf = dec.confidence ? `(${dec.confidence}%)` : '';
          const lev = dec.leverage ? `${dec.leverage}x` : '';
          const sl = dec.stop_loss_pct ? `SL:${dec.stop_loss_pct}%` : '';
          const tp = dec.take_profit_pct ? `TP:${dec.take_profit_pct}%` : '';
          console.log(`  ${dec.pair} ${dec.action} ${conf} ${lev} ${sl} ${tp}`);
          if (dec.reasoning) console.log(`     ${dec.reasoning.slice(0, 150)}`);
        }
      }
    }

    // ── Hindsight: what happened to the first pair ──
    if (judgeResult?.decisions?.length > 0 && bb?.market?.pairs?.length > 0) {
      console.log(`\n  ── HINDSIGHT ──`);
      const mainPair = bb.market.pairs[0]; // usually BTCUSDT

      // Get price at debate time
      const { rows: [atTime] } = await pool.query(`
        SELECT mark_price FROM market_snapshots
        WHERE pair = $1
          AND created_at <= $2::timestamptz + INTERVAL '2 minutes'
          AND created_at >= $2::timestamptz - INTERVAL '2 minutes'
        ORDER BY created_at DESC LIMIT 1
      `, [mainPair, conv.created_at]);

      const basePrice = atTime ? Number(atTime.mark_price) : 0;
      if (basePrice > 0) {
        row(`${mainPair} at debate`, `$${basePrice.toFixed(2)}`);

        for (const [label, mins] of [['1h', 60], ['4h', 240], ['24h', 1440]] as const) {
          const { rows: [snap] } = await pool.query(`
            SELECT mark_price FROM market_snapshots
            WHERE pair = $1
              AND created_at >= $2::timestamptz + INTERVAL '${mins} minutes' - INTERVAL '5 minutes'
              AND created_at <= $2::timestamptz + INTERVAL '${mins} minutes' + INTERVAL '5 minutes'
            ORDER BY created_at ASC LIMIT 1
          `, [mainPair, conv.created_at]);

          if (snap) {
            const futurePrice = Number(snap.mark_price);
            const delta = ((futurePrice - basePrice) / basePrice * 100).toFixed(2);
            const sign = Number(delta) >= 0 ? '+' : '';
            row(`  +${label}`, `$${futurePrice.toFixed(2)} (${sign}${delta}%)`);
          } else {
            row(`  +${label}`, 'no data');
          }
        }

        // Vote accuracy
        const mainDecision = judgeResult.decisions.find((d: any) => d.pair === mainPair);
        const { rows: [after4h] } = await pool.query(`
          SELECT mark_price FROM market_snapshots
          WHERE pair = $1
            AND created_at >= $2::timestamptz + INTERVAL '4 hours' - INTERVAL '5 minutes'
            AND created_at <= $2::timestamptz + INTERVAL '4 hours' + INTERVAL '5 minutes'
          ORDER BY created_at ASC LIMIT 1
        `, [mainPair, conv.created_at]);

        if (after4h && mainDecision) {
          const move4h = (Number(after4h.mark_price) - basePrice) / basePrice * 100;
          const wasRight = (mainDecision.action === 'LONG' && move4h > 0.5) ||
                           (mainDecision.action === 'SHORT' && move4h < -0.5) ||
                           (mainDecision.action === 'HOLD' && Math.abs(move4h) < 1);
          row('Decision accuracy', wasRight ? '✓ CORRECT (4h)' : `✗ WRONG (${mainPair} moved ${move4h.toFixed(2)}%)`);

          // Per-persona accuracy
          if (personas.length > 0) {
            console.log(`\n  ── PERSONA ACCURACY (4h) ──`);
            for (const p of personas) {
              if (!p.vote) continue;
              const right = (p.vote === 'LONG' && move4h > 0.5) ||
                            (p.vote === 'SHORT' && move4h < -0.5) ||
                            (p.vote === 'HOLD' && Math.abs(move4h) < 1);
              console.log(`  ${right ? '✓' : '✗'} ${p.persona}: ${p.vote} (price ${move4h >= 0 ? '+' : ''}${move4h.toFixed(2)}%)`);
            }
          }
        }
      }
    }
  }

  console.log('\n');
} catch (err: any) {
  console.error('DB error:', err.message);
} finally {
  await pool.end();
}
```

**Step 2: Test locally**

Run: `npx tsx scripts/audit-swarm.ts --last`
Expected: Shows last swarm debate with personas, votes, blackboard, hindsight.

**Step 3: Add npm script**

```json
"audit:swarm": "tsx scripts/audit-swarm.ts"
```

**Step 4: Commit**

```bash
git add scripts/audit-swarm.ts package.json
git commit -m "feat: add audit:swarm script for deep swarm debate analysis

Usage: npm run audit:swarm [id | --last N | --cycle N]
Shows: all personas, votes, signals, conflicts, blackboard state,
judge verdict, hindsight prices, per-persona accuracy."
```

---

### Task 7: Create `scripts/audit-hindsight.ts`

Batch analysis: find historically wrong decisions, missed opportunities, pattern detection.

**Usage:**
```bash
npx tsx scripts/audit-hindsight.ts [hours=48]
```

**Files:**
- Create: `scripts/audit-hindsight.ts`

**Step 1: Create the script**

```typescript
/**
 * audit-hindsight.ts — find historically wrong decisions and missed opportunities
 * Usage: npx tsx scripts/audit-hindsight.ts [hours=48]
 */
import 'dotenv/config';
import pg from 'pg';

const hours = parseInt(process.argv[2] || '48', 10);
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10_000,
});

function section(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

try {
  const since = `NOW() - INTERVAL '${hours} hours'`;

  // ── 1. Overview ──
  section(`HINDSIGHT ANALYSIS (last ${hours}h)`);

  const { rows: [overview] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM trade_executions WHERE opened_at > ${since}) as total_trades,
      (SELECT COUNT(*) FROM trade_closes WHERE closed_at > ${since}) as total_closes,
      (SELECT COALESCE(SUM(pnl_usd), 0) FROM trade_closes WHERE closed_at > ${since}) as total_pnl,
      (SELECT COUNT(*) FROM trade_closes WHERE closed_at > ${since} AND pnl_usd > 0) as wins,
      (SELECT COUNT(*) FROM trade_closes WHERE closed_at > ${since} AND pnl_usd <= 0) as losses
  `);

  const wins = Number(overview.wins);
  const losses = Number(overview.losses);
  const winRate = (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(0) : '0';

  console.log(`  Trades: ${overview.total_trades} opened, ${overview.total_closes} closed`);
  console.log(`  P&L: $${Number(overview.total_pnl).toFixed(2)} | Win rate: ${winRate}% (${wins}W/${losses}L)`);

  // ── 2. Worst trades ──
  section('WORST TRADES (biggest losses)');

  const { rows: worstTrades } = await pool.query(`
    SELECT tc.pair, tc.exit_reason, tc.pnl_usd, tc.pnl_pct, tc.held_hours,
           tc.regime_at_exit,
           te.fill_price, te.entry_thesis, te.regime_at_entry, te.was_swarm,
           td.confidence, td.reasoning
    FROM trade_closes tc
    JOIN trade_executions te ON tc.execution_id = te.id
    LEFT JOIN trade_decisions td ON te.decision_id = td.id
    WHERE tc.closed_at > ${since}
    ORDER BY tc.pnl_usd ASC
    LIMIT 5
  `);

  for (const t of worstTrades) {
    const pnl = Number(t.pnl_usd);
    if (pnl >= 0) break; // Only show losses
    console.log(`  ${t.pair} ${t.exit_reason}: $${pnl.toFixed(2)} (${Number(t.pnl_pct).toFixed(1)}%) held ${Number(t.held_hours).toFixed(1)}h`);
    console.log(`     Entry: $${Number(t.fill_price).toFixed(2)} | ${t.regime_at_entry} → ${t.regime_at_exit} | conf:${t.confidence}${t.was_swarm ? ' [swarm]' : ''}`);
    if (t.entry_thesis) console.log(`     Thesis: "${t.entry_thesis.slice(0, 120)}"`);
  }

  // ── 3. Missed opportunities (HOLDs during big moves) ──
  section('MISSED OPPORTUNITIES (HOLD during ≥2% moves)');

  const { rows: missedOps } = await pool.query(`
    WITH hold_decisions AS (
      SELECT td.pair, td.cycle_id, td.reasoning, td.created_at,
             c.regime, c.volume_ratio
      FROM trade_decisions td
      JOIN cycles c ON td.cycle_id = c.id
      WHERE td.created_at > ${since}
        AND td.action = 'HOLD'
        AND td.pair = 'BTCUSDT'
        AND td.confidence > 0
    )
    SELECT DISTINCT ON (hd.cycle_id)
      hd.pair, hd.reasoning, hd.created_at, hd.regime, hd.volume_ratio,
      ms_now.mark_price as price_at_hold,
      ms_4h.mark_price as price_4h_later
    FROM hold_decisions hd
    LEFT JOIN LATERAL (
      SELECT mark_price FROM market_snapshots
      WHERE pair = hd.pair
        AND created_at BETWEEN hd.created_at - INTERVAL '2 minutes' AND hd.created_at + INTERVAL '2 minutes'
      ORDER BY created_at DESC LIMIT 1
    ) ms_now ON true
    LEFT JOIN LATERAL (
      SELECT mark_price FROM market_snapshots
      WHERE pair = hd.pair
        AND created_at BETWEEN hd.created_at + INTERVAL '4 hours' - INTERVAL '5 minutes'
                          AND hd.created_at + INTERVAL '4 hours' + INTERVAL '5 minutes'
      ORDER BY created_at ASC LIMIT 1
    ) ms_4h ON true
    WHERE ms_now.mark_price IS NOT NULL
      AND ms_4h.mark_price IS NOT NULL
      AND ABS((ms_4h.mark_price - ms_now.mark_price) / ms_now.mark_price * 100) >= 2
    ORDER BY hd.cycle_id, ABS((ms_4h.mark_price - ms_now.mark_price) / ms_now.mark_price * 100) DESC
    LIMIT 10
  `);

  if (missedOps.length === 0) {
    console.log('  No missed opportunities found (no HOLDs before ≥2% moves).');
  } else {
    for (const m of missedOps) {
      const priceNow = Number(m.price_at_hold);
      const price4h = Number(m.price_4h_later);
      const move = ((price4h - priceNow) / priceNow * 100).toFixed(2);
      const ts = new Date(m.created_at).toISOString().slice(11, 19);
      const direction = Number(move) > 0 ? 'LONG' : 'SHORT';
      console.log(`  ${ts} ${m.pair} HOLD → missed ${direction} ${move}% (${m.regime} vol:${Number(m.volume_ratio).toFixed(2)}x)`);
      if (m.reasoning) console.log(`     Reason: "${m.reasoning.slice(0, 100)}"`);
    }
  }

  // ── 4. Risk rejections that would have profited ──
  section('PROFITABLE REJECTIONS (risk blocked but would have profited)');

  const { rows: profitableRejections } = await pool.query(`
    SELECT td.pair, td.action, td.confidence, td.leverage, td.reasoning,
           rv.rejection_reason,
           td.created_at,
           ms_now.mark_price as price_at_decision,
           ms_4h.mark_price as price_4h_later
    FROM trade_decisions td
    JOIN risk_validations rv ON rv.decision_id = td.id
    LEFT JOIN LATERAL (
      SELECT mark_price FROM market_snapshots
      WHERE pair = td.pair
        AND created_at BETWEEN td.created_at - INTERVAL '2 minutes' AND td.created_at + INTERVAL '2 minutes'
      ORDER BY created_at DESC LIMIT 1
    ) ms_now ON true
    LEFT JOIN LATERAL (
      SELECT mark_price FROM market_snapshots
      WHERE pair = td.pair
        AND created_at BETWEEN td.created_at + INTERVAL '4 hours' - INTERVAL '5 minutes'
                          AND td.created_at + INTERVAL '4 hours' + INTERVAL '5 minutes'
      ORDER BY created_at ASC LIMIT 1
    ) ms_4h ON true
    WHERE td.created_at > ${since}
      AND rv.passed = false
      AND td.action IN ('LONG', 'SHORT')
      AND ms_now.mark_price IS NOT NULL
      AND ms_4h.mark_price IS NOT NULL
    ORDER BY td.created_at DESC
    LIMIT 20
  `);

  let profitableCount = 0;
  let totalRejections = profitableRejections.length;

  for (const r of profitableRejections) {
    const priceNow = Number(r.price_at_decision);
    const price4h = Number(r.price_4h_later);
    const move = (price4h - priceNow) / priceNow * 100;
    const wouldHaveProfit = (r.action === 'LONG' && move > 0.5) ||
                             (r.action === 'SHORT' && move < -0.5);
    if (wouldHaveProfit) {
      profitableCount++;
      const ts = new Date(r.created_at).toISOString().slice(11, 19);
      console.log(`  ${ts} ${r.pair} ${r.action} conf:${r.confidence} → blocked: "${r.rejection_reason}"`);
      console.log(`     Would have: ${move >= 0 ? '+' : ''}${move.toFixed(2)}% in 4h`);
    }
  }

  if (profitableCount === 0) {
    console.log('  No profitable rejections found.');
  } else {
    console.log(`\n  ${profitableCount}/${totalRejections} rejected trades would have profited (${(profitableCount/totalRejections*100).toFixed(0)}%)`);
  }

  // ── 5. Win rate by regime ──
  section('WIN RATE BY REGIME');

  const { rows: regimeStats } = await pool.query(`
    SELECT te.regime_at_entry as regime,
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE tc.pnl_usd > 0) as wins,
           ROUND(AVG(tc.pnl_pct)::numeric, 1) as avg_pnl_pct,
           ROUND(SUM(tc.pnl_usd)::numeric, 2) as total_pnl
    FROM trade_closes tc
    JOIN trade_executions te ON tc.execution_id = te.id
    WHERE tc.closed_at > ${since}
    GROUP BY te.regime_at_entry
    ORDER BY total DESC
  `);

  if (regimeStats.length === 0) {
    console.log('  No closed trades with regime data.');
  } else {
    console.log(`  ${'Regime'.padEnd(16)} ${'Total'.padStart(5)} ${'Wins'.padStart(5)} ${'Rate'.padStart(6)} ${'Avg%'.padStart(6)} ${'P&L'.padStart(8)}`);
    console.log(`  ${'─'.repeat(50)}`);
    for (const r of regimeStats) {
      const total = Number(r.total);
      const winsCount = Number(r.wins);
      const rate = total > 0 ? `${(winsCount / total * 100).toFixed(0)}%` : '0%';
      const pnl = Number(r.total_pnl);
      console.log(`  ${(r.regime ?? 'unknown').padEnd(16)} ${String(total).padStart(5)} ${String(winsCount).padStart(5)} ${rate.padStart(6)} ${String(r.avg_pnl_pct ?? '0').padStart(6)}% ${(pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2).padStart(6)}`);
    }
  }

  // ── 6. Swarm vs Single LLM performance ──
  section('SWARM vs SINGLE LLM OUTCOMES');

  const { rows: swarmPerf } = await pool.query(`
    SELECT
      te.was_swarm,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE tc.pnl_usd > 0) as wins,
      ROUND(AVG(tc.pnl_pct)::numeric, 2) as avg_pnl_pct,
      ROUND(SUM(tc.pnl_usd)::numeric, 2) as total_pnl
    FROM trade_closes tc
    JOIN trade_executions te ON tc.execution_id = te.id
    WHERE tc.closed_at > ${since}
    GROUP BY te.was_swarm
  `);

  for (const s of swarmPerf) {
    const label = s.was_swarm ? 'Swarm' : 'Single LLM';
    const total = Number(s.total);
    const winsCount = Number(s.wins);
    const rate = total > 0 ? `${(winsCount / total * 100).toFixed(0)}%` : '0%';
    console.log(`  ${label.padEnd(14)} ${total} trades | ${rate} win | avg ${s.avg_pnl_pct}% | total $${s.total_pnl}`);
  }

  console.log('\n');
} catch (err: any) {
  console.error('DB error:', err.message);
} finally {
  await pool.end();
}
```

**Step 2: Test locally**

Run: `npx tsx scripts/audit-hindsight.ts 48`
Expected: Console output with worst trades, missed opportunities, pattern stats.

**Step 3: Add npm script**

```json
"audit:hindsight": "tsx scripts/audit-hindsight.ts"
```

**Step 4: Commit**

```bash
git add scripts/audit-hindsight.ts package.json
git commit -m "feat: add audit:hindsight script for retrospective decision analysis

Usage: npm run audit:hindsight [hours=48]
Shows: worst trades, missed opportunities, profitable rejections,
win rate by regime, swarm vs single LLM outcomes."
```

---

### Task 8: Final commit and verification

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 2: Verify build**

Run: `npm run build`
Expected: No TypeScript errors.

**Step 3: Verify all audit scripts have npm commands**

Check that `package.json` includes:
```json
"audit:decision": "tsx scripts/audit-decision.ts",
"audit:swarm": "tsx scripts/audit-swarm.ts",
"audit:hindsight": "tsx scripts/audit-hindsight.ts"
```

**Step 4: Final commit if needed**

If any fixes were needed, commit them. Otherwise, this step is a no-op.
