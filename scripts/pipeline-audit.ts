/**
 * pipeline-audit.ts — diagnose where the decision pipeline blocks trades
 * Usage: npx tsx scripts/pipeline-audit.ts [hours=24]
 *
 * Reads DB tables: cycles, trade_decisions, risk_validations, trade_executions
 * Shows: pre-screen block reasons, risk rejection reasons, confidence distribution, swarm vs single LLM stats
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
