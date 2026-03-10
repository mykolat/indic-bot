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
