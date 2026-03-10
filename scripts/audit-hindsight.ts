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

  if (worstTrades.length === 0 || Number(worstTrades[0].pnl_usd) >= 0) {
    console.log('  No losing trades found.');
  } else {
    for (const t of worstTrades) {
      const pnl = Number(t.pnl_usd);
      if (pnl >= 0) break;
      console.log(`  ${t.pair} ${t.exit_reason}: $${pnl.toFixed(2)} (${Number(t.pnl_pct).toFixed(1)}%) held ${Number(t.held_hours).toFixed(1)}h`);
      console.log(`     Entry: $${Number(t.fill_price).toFixed(2)} | ${t.regime_at_entry} -> ${t.regime_at_exit} | conf:${t.confidence}${t.was_swarm ? ' [swarm]' : ''}`);
      if (t.entry_thesis) console.log(`     Thesis: "${t.entry_thesis.slice(0, 120)}"`);
    }
  }

  // ── 3. Missed opportunities ──
  section('MISSED OPPORTUNITIES (HOLD during >=2% moves)');

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
    console.log('  No missed opportunities found (no HOLDs before >=2% moves).');
  } else {
    for (const m of missedOps) {
      const priceNow = Number(m.price_at_hold);
      const price4h = Number(m.price_4h_later);
      const move = ((price4h - priceNow) / priceNow * 100).toFixed(2);
      const ts = new Date(m.created_at).toISOString().slice(11, 19);
      const direction = Number(move) > 0 ? 'LONG' : 'SHORT';
      console.log(`  ${ts} ${m.pair} HOLD -> missed ${direction} ${move}% (${m.regime} vol:${Number(m.volume_ratio).toFixed(2)}x)`);
      if (m.reasoning) console.log(`     Reason: "${m.reasoning.slice(0, 100)}"`);
    }
  }

  // ── 4. Profitable rejections ──
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
  const totalRejections = profitableRejections.length;

  for (const r of profitableRejections) {
    const priceNow = Number(r.price_at_decision);
    const price4h = Number(r.price_4h_later);
    const move = (price4h - priceNow) / priceNow * 100;
    const wouldHaveProfit = (r.action === 'LONG' && move > 0.5) ||
                             (r.action === 'SHORT' && move < -0.5);
    if (wouldHaveProfit) {
      profitableCount++;
      const ts = new Date(r.created_at).toISOString().slice(11, 19);
      console.log(`  ${ts} ${r.pair} ${r.action} conf:${r.confidence} -> blocked: "${r.rejection_reason}"`);
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
      const winsN = Number(r.wins);
      const rate = total > 0 ? `${(winsN / total * 100).toFixed(0)}%` : '0%';
      const pnl = Number(r.total_pnl);
      console.log(`  ${(r.regime ?? 'unknown').padEnd(16)} ${String(total).padStart(5)} ${String(winsN).padStart(5)} ${rate.padStart(6)} ${String(r.avg_pnl_pct ?? '0').padStart(6)}% ${(pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2)}`);
    }
  }

  // ── 6. Swarm vs Single LLM ──
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

  if (swarmPerf.length === 0) {
    console.log('  No closed trades found.');
  } else {
    for (const s of swarmPerf) {
      const label = s.was_swarm ? 'Swarm' : 'Single LLM';
      const total = Number(s.total);
      const winsN = Number(s.wins);
      const rate = total > 0 ? `${(winsN / total * 100).toFixed(0)}%` : '0%';
      console.log(`  ${label.padEnd(14)} ${total} trades | ${rate} win | avg ${s.avg_pnl_pct}% | total $${s.total_pnl}`);
    }
  }

  console.log('\n');
} catch (err: any) {
  console.error('DB error:', err.message);
} finally {
  await pool.end();
}
