# Bot Passivity Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove 7 cascading filters that block 90%+ of trades, making the bot passive even in high-opportunity markets.

**Architecture:** Each bottleneck is an independent fix (no inter-dependencies). Changes span pre-screener, filter-profiles, risk manager, config, prompts. A diagnostic script (`scripts/pipeline-audit.ts`) reads DB to verify before/after.

**Tech Stack:** TypeScript, Vitest, PostgreSQL (Supabase)

---

### Task 1: Pre-Screener — 4h_conflict from block → warn

**Problem:** `4h_conflict` blocks 12/13 pairs in choppy markets. In reality, 1h/4h alignment is rare — this kills almost all opportunities.

**Fix:** Instead of returning `hold`, return `pass` with a `warning` field. The LLM sees the warning as context and decides.

**Files:**
- Modify: `src/market/pre-screener.ts:4-17` (ScreenVerdict interface) and `:55-57` (4h_conflict check)
- Modify: `tests/market/pre-screener.test.ts:28-38` (update test expectations)
- Verify: `tests/market/pre-screener.test.ts` (all existing tests still pass)

**Step 1: Update the ScreenVerdict interface**

In `src/market/pre-screener.ts`, add `warning` field:

```typescript
export interface ScreenVerdict {
  pair: string;
  verdict: 'pass' | 'hold' | 'manage';
  reason?: string;
  warning?: string;  // advisory, not blocking
}
```

**Step 2: Change 4h_conflict from block to warn**

In `src/market/pre-screener.ts:55-57`, replace:

```typescript
if (ind4h && ind1h.trend !== 'neutral' && ind4h.trend !== 'neutral' && ind1h.trend !== ind4h.trend) {
  return { pair, verdict: 'hold', reason: '4h_conflict' };
}
```

with:

```typescript
let warning: string | undefined;
if (ind4h && ind1h.trend !== 'neutral' && ind4h.trend !== 'neutral' && ind1h.trend !== ind4h.trend) {
  warning = '4h_conflict';
}
```

And at the end of `screen()` (line 71), change:

```typescript
return { pair, verdict: 'pass' };
```

to:

```typescript
return { pair, verdict: 'pass', warning };
```

**Step 3: Update test expectations**

In `tests/market/pre-screener.test.ts`, change the test at line 28:

```typescript
it('warns (not blocks) when 1h and 4h trends conflict', () => {
  const result = screener.screen({
    pair: 'ETHUSDT',
    ind1h: makeInd({ trend: 'bearish' }),
    ind4h: makeInd({ trend: 'bullish' }),
    regime: 'BearTrend',
    confluence: 3,
    hasPosition: false,
  });
  expect(result.verdict).toBe('pass');
  expect(result.warning).toBe('4h_conflict');
});
```

**Step 4: Run tests**

Run: `npx vitest run tests/market/pre-screener.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/market/pre-screener.ts tests/market/pre-screener.test.ts
git commit -m "fix(pre-screener): 4h_conflict warns instead of blocking"
```

---

### Task 2: Filter Profiles — Lower Blocking Thresholds

**Problem:** Scalping minConfidence=72 is unreachable. Breakout volumeMin=1.2x blocks early breakouts.

**Files:**
- Modify: `src/market/filter-profiles.ts:41-49` (Breakout) and `:59-67` (Scalping)
- Test: `tests/market/pre-screener.test.ts` (existing tests cover these profiles)

**Step 1: Write a test for the new thresholds**

Add to `tests/market/pre-screener.test.ts`:

```typescript
it('passes pair in Scalping with moderate confidence setup', () => {
  const result = screener.screen({
    pair: 'ETHUSDT',
    ind1h: makeInd({ trend: 'bullish', volumeRatio: 0.2, rsi: 55 }),
    ind4h: makeInd({ trend: 'bullish' }),
    regime: 'Scalping',
    confluence: 1,
    hasPosition: false,
  });
  expect(result.verdict).toBe('pass');
});

it('passes pair in Breakout with sub-1x volume', () => {
  const result = screener.screen({
    pair: 'SOLUSDT',
    ind1h: makeInd({ trend: 'bullish', volumeRatio: 0.7, rsi: 60 }),
    ind4h: makeInd({ trend: 'bullish' }),
    regime: 'Breakout',
    confluence: 2,
    hasPosition: false,
  });
  expect(result.verdict).toBe('pass');
});
```

**Step 2: Run tests to see them fail**

Run: `npx vitest run tests/market/pre-screener.test.ts`
Expected: FAIL — Breakout volumeMin=1.2 blocks 0.7x, Breakout confluenceMin=3 blocks 2

**Step 3: Update filter profiles**

In `src/market/filter-profiles.ts`, change Breakout (lines 41-49):

```typescript
[MarketRegime.Breakout]: {
    rsiRange: [0, 100],  // any RSI
    volumeMin: 0.6,
    confluenceMin: 2,
    leverageMultiplier: 1,
    minConfidence: 55,
    slStyle: 'atr',
    tpStyle: 'momentum',
},
```

Change Scalping (lines 59-67):

```typescript
[MarketRegime.Scalping]: {
    rsiRange: [30, 70],
    volumeMin: 0.15,
    confluenceMin: 1,
    leverageMultiplier: 0.5,
    minConfidence: 50,
    slStyle: 'fixed',
    tpStyle: 'fixed',
},
```

**Step 4: Run tests**

Run: `npx vitest run tests/market/pre-screener.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/market/filter-profiles.ts tests/market/pre-screener.test.ts
git commit -m "fix(filters): lower Breakout volumeMin 1.2→0.6 and Scalping minConfidence 72→50"
```

---

### Task 3: RiskManager — Regime-Aware Confidence + Lower 4h Override

**Problem:** Global minConfidence=55 overrides regime's 45 (Capitulation). 4h override requires 80 — nearly impossible.

**Fix:** RiskManager reads regime-specific minConfidence from FilterProfile (passed via ValidationContext). 4h override threshold drops 80→65.

**Files:**
- Modify: `src/risk/manager.ts:84-89` (ValidationContext) and `:171-178` (confidence check) and `:271-281` (4h override)
- Modify: `tests/risk/manager.test.ts` (update + add regime confidence tests)

**Step 1: Add `regimeMinConfidence` to ValidationContext**

In `src/risk/manager.ts:84-89`, add field:

```typescript
export interface ValidationContext {
  indicators4h?: Map<string, { trend: string }>;
  indicators1h?: Map<string, { atr: number; trend: string }>;
  fearGreed?: { value: number };
  fearGreedLeverageCap?: number;
  regimeMinConfidence?: number;  // from FilterProfile, overrides global
}
```

**Step 2: Write failing tests**

Add to `tests/risk/manager.test.ts`:

```typescript
it('uses regime minConfidence when lower than global', () => {
  const rm = new RiskManager({ ...config, minConfidence: 55 });
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'SHORT', size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'capitulation short',
    confidence: 48,
  };
  const portfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };
  // Capitulation profile has minConfidence=45 — should approve confidence=48
  const ctx = { regimeMinConfidence: 45 };
  const result = rm.validate(decision, portfolio, ctx);
  expect(result.approved).toBe(true);
});

it('allows LONG against 4h bearish if confidence >= 65', () => {
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 68,
  };
  const portfolio: PortfolioState = { balanceUsd: 1000, positions: [], sessionPnl: 0, drawdownPct: 0 };
  const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
  const result = rm.validate(decision, portfolio, ctx);
  expect(result.approved).toBe(true);
});
```

**Step 3: Run tests to see them fail**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: FAIL — confidence=48 < global 55, confidence=68 < 80

**Step 4: Update confidence check (lines 171-178)**

Replace:

```typescript
// Confidence check (only when minConfidence is configured)
if (this.config.minConfidence != null) {
  const confidence = decision.confidence ?? 50;
  const minConf = this.config.minConfidence;
  if (confidence < minConf) {
    return { approved: false, reason: `Low confidence: ${confidence} < ${minConf}` };
  }
}
```

with:

```typescript
// Confidence check — regime-specific overrides global
{
  const confidence = decision.confidence ?? 50;
  const minConf = ctx?.regimeMinConfidence ?? this.config.minConfidence ?? 55;
  if (confidence < minConf) {
    return { approved: false, reason: `Low confidence: ${confidence} < ${minConf}` };
  }
}
```

**Step 5: Lower 4h override threshold (lines 275, 278)**

Replace `confidence < 80` with `confidence < 65` in both lines:

```typescript
if (decision.action === 'LONG' && trend4h === 'bearish' && confidence < 65) {
  return { approved: false, reason: `4h trend bearish — need confidence >=65 (got ${confidence})` };
}
if (decision.action === 'SHORT' && trend4h === 'bullish' && confidence < 65) {
  return { approved: false, reason: `4h trend bullish — need confidence >=65 (got ${confidence})` };
}
```

**Step 6: Update existing test expectations**

In `tests/risk/manager.test.ts`, the test "rejects LONG when 4h bearish and confidence < 80" (line 228) — update:

```typescript
it('rejects LONG when 4h bearish and confidence < 65', () => {
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 60,
  };
  const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
  const result = rm.validate(decision, basePortfolio, ctx);
  expect(result.approved).toBe(false);
  expect(result.reason).toContain('4h trend bearish');
});

it('allows LONG against 4h if confidence >= 65', () => {
  const decision: TradeDecision = {
    pair: 'BTCUSDT', action: 'LONG', size_pct: 10, leverage: 5,
    stop_loss_pct: 2, take_profit_pct: 10, reasoning: 'test', confidence: 68,
  };
  const ctx = { indicators4h: new Map([['BTCUSDT', { trend: 'bearish' }]]) };
  const result = rm.validate(decision, basePortfolio, ctx);
  expect(result.approved).toBe(true);
});
```

**Step 7: Run tests**

Run: `npx vitest run tests/risk/manager.test.ts`
Expected: All PASS

**Step 8: Wire regimeMinConfidence in TradingLoop**

In `src/trading-loop.ts`, find where `riskManager.validate()` is called (around line 1173) and ensure the `ValidationContext` includes `regimeMinConfidence` from the current regime's FilterProfile.

Search for where `validationCtx` is built (look for `indicators4h` assignment). Add:

```typescript
import { getFilterProfile } from '../market/filter-profiles.js';
import { MarketRegime } from '../market/regime-classifier.js';
```

Where `validationCtx` is constructed, add:

```typescript
const filterProfile = getFilterProfile(regime as MarketRegime);
// Add to validationCtx:
regimeMinConfidence: filterProfile?.minConfidence,
```

**Step 9: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

**Step 10: Commit**

```bash
git add src/risk/manager.ts tests/risk/manager.test.ts src/trading-loop.ts
git commit -m "fix(risk): regime-aware confidence + lower 4h override 80→65"
```

---

### Task 4: Config — Lower Swarm Threshold & Position Floor

**Problem:** `swarmVolumeThreshold=0.8` means Swarm never activates in normal markets (vol 0.3-0.5x). Single LLM defaults to HOLD. `minPositionPct=30%` forces over-selectivity.

**Files:**
- Modify: `config.yaml:5,15,23`

**Step 1: Update config.yaml**

```yaml
minPositionPct: 15          # was 30 — allow smaller bets
minConfidence: 40            # was 55 — global floor lowered (regimes override)
swarmVolumeThreshold: 0.4    # was 0.8 — activate swarm earlier
```

**Step 2: Verify bot still starts**

Run: `npx vitest run tests/`
Expected: All PASS (config defaults are tested elsewhere)

**Step 3: Commit**

```bash
git add config.yaml
git commit -m "config: lower minPositionPct 30→15, minConfidence 55→40, swarmThreshold 0.8→0.4"
```

---

### Task 5: Prompts — Soften Timeframe Alignment Language

**Problem:** Prompt says "Only if 1h AND 4h trends align" — LLM interprets this as "HOLD if not aligned", which covers 80%+ of the time.

**Files:**
- Modify: `src/llm/prompts.ts:39-42`

**Step 1: Replace the MULTI-TIMEFRAME CONFIRMATION block**

In `src/llm/prompts.ts:39-42`, replace:

```
MULTI-TIMEFRAME CONFIRMATION:
- LONG: Only if 1h AND 4h trends align bullish (EMA20 > EMA50). If only 1h bullish but 4h bearish, HOLD or use minimal leverage (3-5x).
- SHORT: Only if 1h AND 4h trends align bearish. If only 1h bearish but 4h bullish, HOLD.
- 4h trend overrides 1h for direction. Use 1h for entry timing.
```

with:

```
MULTI-TIMEFRAME CONTEXT:
- PREFERRED: 1h AND 4h trends aligned → full conviction, full sizing.
- ALLOWED: 1h trend clear, 4h neutral or conflicting → trade with reduced size (15-25%) and tighter SL. Tag reasoning "counter_4h".
- AVOID: only if BOTH timeframes show clear opposing trend AND no catalyst/setup overrides it.
- 4h is context, not a veto. A strong 1h setup with catalyst can override a lazy 4h trend.
```

**Step 2: Also update the entry rule on line 45**

Replace:

```
- Trend-following: LONG if EMA20 > EMA50 (both timeframes), SHORT if EMA20 < EMA50
```

with:

```
- Trend-following: LONG if EMA20 > EMA50 (1h required, 4h preferred). SHORT if EMA20 < EMA50 (1h required, 4h preferred).
```

**Step 3: Run tests**

Run: `npx vitest run tests/llm/`
Expected: All PASS (prompt tests check structure, not exact wording)

**Step 4: Commit**

```bash
git add src/llm/prompts.ts
git commit -m "fix(prompts): soften timeframe alignment — 4h is context not veto"
```

---

### Task 6: Pipeline Audit Script

**Problem:** No way to see WHERE in the pipeline decisions get blocked. Need a script that reads DB and shows stats per blocking reason.

**Files:**
- Create: `scripts/pipeline-audit.ts`
- Modify: `package.json` (add `audit:pipeline` script)

**Step 1: Write the pipeline audit script**

Create `scripts/pipeline-audit.ts`:

```typescript
/**
 * pipeline-audit.ts — diagnose where the decision pipeline blocks trades
 * Usage: npx tsx scripts/pipeline-audit.ts [hours=24]
 *
 * Reads DB tables: cycles, trade_decisions, risk_validations, trade_executions
 * Shows: pre-screen block reasons, risk rejection reasons, swarm vs single LLM stats
 */
import 'dotenv/config';
import pg from 'pg';

const hours = parseInt(process.argv[2] || '24', 10);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

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

function bar(pct: number, width = 30): string {
  const filled = Math.round(pct / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

try {
  const since = `NOW() - INTERVAL '${hours} hours'`;

  // ── 1. Cycle overview ──
  section(`PIPELINE AUDIT (last ${hours}h)`);

  const { rows: [overview] } = await pool.query(`
    SELECT
      COUNT(*) as total_cycles,
      COUNT(DISTINCT DATE_TRUNC('hour', created_at)) as active_hours,
      ROUND(AVG(volume_ratio::numeric), 2) as avg_volume,
      MODE() WITHIN GROUP (ORDER BY regime) as dominant_regime
    FROM cycles WHERE created_at > ${since}
  `);
  console.log(`  Cycles: ${overview.total_cycles} | Active hours: ${overview.active_hours} | Avg vol: ${overview.avg_volume}x | Regime: ${overview.dominant_regime}`);

  // ── 2. Decision funnel ──
  section('DECISION FUNNEL');

  const { rows: [funnel] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM trade_decisions WHERE created_at > ${since}) as total_decisions,
      (SELECT COUNT(*) FROM trade_decisions WHERE created_at > ${since} AND action = 'HOLD') as holds,
      (SELECT COUNT(*) FROM trade_decisions WHERE created_at > ${since} AND action IN ('LONG','SHORT')) as action_decisions,
      (SELECT COUNT(*) FROM trade_decisions WHERE created_at > ${since} AND action = 'CLOSE') as closes,
      (SELECT COUNT(*) FROM trade_decisions WHERE created_at > ${since} AND action = 'ADJUST') as adjusts,
      (SELECT COUNT(*) FROM risk_validations rv JOIN trade_decisions td ON rv.decision_id = td.id
        WHERE td.created_at > ${since} AND rv.passed = false) as risk_rejected,
      (SELECT COUNT(*) FROM trade_executions WHERE created_at > ${since}) as executed
  `);

  const total = Number(funnel.total_decisions) || 1;
  const holds = Number(funnel.holds);
  const actions = Number(funnel.action_decisions);
  const rejected = Number(funnel.risk_rejected);
  const executed = Number(funnel.executed);

  console.log(`  Total decisions:  ${funnel.total_decisions}`);
  console.log(`  HOLDs:            ${holds} (${(holds/total*100).toFixed(0)}%) ${bar(holds/total*100)}`);
  console.log(`  LONG/SHORT:       ${actions} (${(actions/total*100).toFixed(0)}%)`);
  console.log(`  Risk rejected:    ${rejected}`);
  console.log(`  Executed:         ${executed}`);
  console.log(`  CLOSEs:           ${funnel.closes}`);
  console.log(`  ADJUSTs:          ${funnel.adjusts}`);
  console.log(`  Pass-through:     ${total > 0 ? (executed/total*100).toFixed(1) : 0}%`);

  // ── 3. Pre-screen blocking reasons ──
  section('PRE-SCREEN BLOCKS (HOLD reasons from auto-hold)');

  const { rows: preScreenReasons } = await pool.query(`
    SELECT reasoning, COUNT(*) as cnt
    FROM trade_decisions
    WHERE created_at > ${since}
      AND action = 'HOLD'
      AND confidence = 0
    GROUP BY reasoning
    ORDER BY cnt DESC
    LIMIT 15
  `);

  if (preScreenReasons.length === 0) {
    console.log('  No pre-screen blocks found.');
  } else {
    const maxCnt = Number(preScreenReasons[0].cnt);
    for (const r of preScreenReasons) {
      const cnt = Number(r.cnt);
      console.log(`  ${String(cnt).padStart(4)} ${bar(cnt/maxCnt*100, 20)} ${r.reasoning}`);
    }
  }

  // ── 4. Risk rejection reasons ──
  section('RISK REJECTIONS');

  const { rows: riskReasons } = await pool.query(`
    SELECT rv.rejection_reason, COUNT(*) as cnt
    FROM risk_validations rv
    JOIN trade_decisions td ON rv.decision_id = td.id
    WHERE td.created_at > ${since} AND rv.passed = false
    GROUP BY rv.rejection_reason
    ORDER BY cnt DESC
    LIMIT 15
  `);

  if (riskReasons.length === 0) {
    console.log('  No risk rejections found.');
  } else {
    const maxCnt = Number(riskReasons[0].cnt);
    for (const r of riskReasons) {
      const cnt = Number(r.cnt);
      console.log(`  ${String(cnt).padStart(4)} ${bar(cnt/maxCnt*100, 20)} ${r.rejection_reason}`);
    }
  }

  // ── 5. LLM confidence distribution ──
  section('CONFIDENCE DISTRIBUTION (LONG/SHORT only)');

  const { rows: confDist } = await pool.query(`
    SELECT
      CASE
        WHEN confidence < 30 THEN '<30'
        WHEN confidence < 40 THEN '30-39'
        WHEN confidence < 50 THEN '40-49'
        WHEN confidence < 60 THEN '50-59'
        WHEN confidence < 70 THEN '60-69'
        WHEN confidence < 80 THEN '70-79'
        ELSE '80+'
      END as bucket,
      COUNT(*) as cnt
    FROM trade_decisions
    WHERE created_at > ${since}
      AND action IN ('LONG', 'SHORT')
      AND confidence IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket
  `);

  if (confDist.length === 0) {
    console.log('  No action decisions with confidence found.');
  } else {
    const maxCnt = Math.max(...confDist.map(r => Number(r.cnt)));
    for (const r of confDist) {
      const cnt = Number(r.cnt);
      console.log(`  ${r.bucket.padStart(6)} ${String(cnt).padStart(3)} ${bar(cnt/maxCnt*100, 25)}`);
    }
  }

  // ── 6. Swarm vs Single LLM ──
  section('SWARM vs SINGLE LLM');

  const { rows: [swarmStats] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE regime IS NOT NULL) as total_cycles,
      (SELECT COUNT(*) FROM llm_conversations
        WHERE created_at > ${since} AND method = 'swarm') as swarm_calls,
      (SELECT COUNT(*) FROM llm_conversations
        WHERE created_at > ${since} AND method = 'analyze') as single_calls
    FROM cycles WHERE created_at > ${since}
  `);
  console.log(`  Swarm debates:  ${swarmStats.swarm_calls}`);
  console.log(`  Single LLM:    ${swarmStats.single_calls}`);
  console.log(`  Total cycles:  ${swarmStats.total_cycles}`);

  // ── 7. Per-pair passivity ──
  section('PER-PAIR ACTIVITY');

  const { rows: pairActivity } = await pool.query(`
    SELECT
      pair,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE action = 'HOLD') as holds,
      COUNT(*) FILTER (WHERE action IN ('LONG','SHORT')) as actions,
      ROUND(AVG(confidence) FILTER (WHERE action IN ('LONG','SHORT')), 0) as avg_conf
    FROM trade_decisions
    WHERE created_at > ${since}
    GROUP BY pair
    ORDER BY actions DESC, total DESC
  `);

  if (pairActivity.length === 0) {
    console.log('  No pair activity found.');
  } else {
    console.log(`  ${'Pair'.padEnd(12)} ${'Total'.padStart(5)} ${'HOLD'.padStart(5)} ${'Act'.padStart(5)} ${'Conf'.padStart(5)} ${'Rate'.padStart(6)}`);
    console.log(`  ${'─'.repeat(42)}`);
    for (const p of pairActivity) {
      const total = Number(p.total);
      const acts = Number(p.actions);
      const rate = total > 0 ? (acts / total * 100).toFixed(0) + '%' : '0%';
      console.log(`  ${p.pair.padEnd(12)} ${String(total).padStart(5)} ${String(p.holds).padStart(5)} ${String(acts).padStart(5)} ${String(p.avg_conf ?? '-').padStart(5)} ${rate.padStart(6)}`);
    }
  }

  // ── 8. Regime distribution ──
  section('REGIME DISTRIBUTION');

  const { rows: regimeDist } = await pool.query(`
    SELECT regime, COUNT(*) as cnt,
      ROUND(AVG(volume_ratio::numeric), 2) as avg_vol,
      ROUND(AVG(confluence_score::numeric), 1) as avg_conf
    FROM cycles
    WHERE created_at > ${since} AND regime IS NOT NULL
    GROUP BY regime
    ORDER BY cnt DESC
  `);

  for (const r of regimeDist) {
    console.log(`  ${r.regime?.padEnd(16) ?? 'unknown'} ${String(r.cnt).padStart(4)} cycles | vol:${r.avg_vol}x conf:${r.avg_conf}/5`);
  }

  // ── 9. Recent action decisions (not HOLD) ──
  section('RECENT ACTION DECISIONS (last 10 LONG/SHORT)');

  const { rows: recentActions } = await pool.query(`
    SELECT td.pair, td.action, td.confidence, td.leverage, td.reasoning, td.regime,
      rv.passed as risk_passed, rv.rejection_reason,
      te.id IS NOT NULL as was_executed,
      td.created_at
    FROM trade_decisions td
    LEFT JOIN risk_validations rv ON rv.decision_id = td.id
    LEFT JOIN trade_executions te ON te.decision_id = td.id
    WHERE td.created_at > ${since}
      AND td.action IN ('LONG', 'SHORT')
    ORDER BY td.created_at DESC
    LIMIT 10
  `);

  if (recentActions.length === 0) {
    console.log('  No action decisions found.');
  } else {
    for (const d of recentActions) {
      const ts = new Date(d.created_at).toISOString().slice(11, 19);
      const status = d.was_executed ? '✓ EXEC' : d.risk_passed === false ? `✗ ${d.rejection_reason?.slice(0, 40)}` : '? pending';
      console.log(`  ${ts} ${d.pair} ${d.action} conf:${d.confidence} lev:${d.leverage}x ${d.regime}`);
      console.log(`         ${status}`);
      if (d.reasoning) console.log(`         "${d.reasoning.slice(0, 100)}"`);
    }
  }

  console.log('\n');
} catch (err: any) {
  console.error('DB error:', err.message);
} finally {
  await pool.end();
}
```

**Step 2: Add npm script**

In `package.json`, add to `"scripts"`:

```json
"audit:pipeline": "tsx scripts/pipeline-audit.ts"
```

**Step 3: Test locally (needs DATABASE_URL)**

Run: `npm run audit:pipeline 48`
Expected: Shows pipeline funnel with blocking stats

**Step 4: Commit**

```bash
git add scripts/pipeline-audit.ts package.json
git commit -m "feat(scripts): add pipeline-audit — diagnose where decisions get blocked"
```

---

## Summary of Changes

| # | File | Change | Impact |
|---|------|--------|--------|
| 1 | `pre-screener.ts` | 4h_conflict: block → warn | Unblocks 80%+ pairs |
| 2 | `filter-profiles.ts` | Breakout vol 1.2→0.6, Scalping conf 72→50 | Unblocks 2 regimes |
| 3 | `risk/manager.ts` | Regime-aware confidence, 4h override 80→65 | Stops double-blocking |
| 4 | `config.yaml` | minConf 55→40, swarm 0.8→0.4, minPos 30→15 | Global relaxation |
| 5 | `prompts.ts` | "Only if aligned" → "preferred, not required" | LLM stops auto-HOLD |
| 6 | `pipeline-audit.ts` | New diagnostic script | Visibility into blocks |

**Execution order:** Tasks are independent — can be parallelized. Recommended: 1→2→3→4→5 (code changes), then 6 (diagnostic).

**Risk:** Lowering thresholds may increase bad trades. Mitigation: daily loss limit (5%), session loss limit (10%), SL on every trade. Monitor with `npm run audit:pipeline` after deploy.
