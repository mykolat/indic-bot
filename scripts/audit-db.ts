/**
 * audit-db.ts — query observability DB for recent bot activity
 * Usage: npx tsx scripts/audit-db.ts [hours=24]
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
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function row(label: string, value: string | number) {
  console.log(`  ${String(label).padEnd(30)} ${value}`);
}

try {
  // ── 1. Sessions ──
  section(`SESSIONS (last ${hours}h)`);
  const { rows: sessions } = await pool.query(
    `SELECT id, start_balance, started_at, ended_at
     FROM sessions WHERE started_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY started_at DESC LIMIT 5`,
  );
  if (sessions.length === 0) {
    console.log('  No sessions found.');
  } else {
    for (const s of sessions) {
      const end = s.ended_at ? new Date(s.ended_at).toISOString().slice(11, 19) : 'running';
      row(s.id.slice(0, 8), `started ${new Date(s.started_at).toISOString().slice(0, 19)} | end: ${end} | bal: $${s.start_balance}`);
    }
  }

  // ── 2. Cycles ──
  section('CYCLES (last 20)');
  const { rows: cycles } = await pool.query(
    `SELECT cycle_number, balance, session_pnl, regime, regime_confidence,
            volume_ratio, confluence_score, layer, filter_warning, created_at
     FROM cycles
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC LIMIT 20`,
  );
  if (cycles.length === 0) {
    console.log('  No cycles found.');
  } else {
    for (const c of cycles) {
      const ts = new Date(c.created_at).toISOString().slice(11, 19);
      const pnl = c.session_pnl != null ? `pnl:${c.session_pnl >= 0 ? '+' : ''}$${Number(c.session_pnl).toFixed(2)}` : '';
      const reg = c.regime ? `${c.regime}(${Number(c.regime_confidence || 0).toFixed(0)}%)` : '';
      const vol = c.volume_ratio != null ? `vol:${Number(c.volume_ratio).toFixed(2)}x` : '';
      const conf = c.confluence_score != null ? `conf:${c.confluence_score}/5` : '';
      const warn = c.filter_warning ? ` ⚠${c.filter_warning}` : '';
      console.log(`  #${c.cycle_number} ${ts} L${c.layer || '?'} bal:$${Number(c.balance).toFixed(2)} ${pnl} ${reg} ${vol} ${conf}${warn}`);
    }
  }

  // ── 3. Trade Decisions ──
  section('TRADE DECISIONS (last 20)');
  const { rows: decisions } = await pool.query(
    `SELECT pair, action, confidence, leverage, stop_loss_pct, take_profit_pct,
            regime, reasoning, created_at
     FROM trade_decisions
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC LIMIT 20`,
  );
  if (decisions.length === 0) {
    console.log('  No trade decisions found.');
  } else {
    for (const d of decisions) {
      const ts = new Date(d.created_at).toISOString().slice(11, 19);
      const conf = d.confidence ? `(${d.confidence}%)` : '';
      const lev = d.leverage ? `${d.leverage}x` : '';
      const sl = d.stop_loss_pct ? `SL:${Number(d.stop_loss_pct).toFixed(1)}%` : '';
      const tp = d.take_profit_pct ? `TP:${Number(d.take_profit_pct).toFixed(1)}%` : '';
      console.log(`  ${ts} ${d.pair} ${d.action} ${conf} ${lev} ${sl} ${tp} ${d.regime || ''}`);
      if (d.reasoning) console.log(`         ${d.reasoning.slice(0, 100)}`);
    }
  }

  // ── 4. Trade Executions ──
  section('TRADE EXECUTIONS (last 20)');
  const { rows: executions } = await pool.query(
    `SELECT pair, side, action, fill_price, quantity, leverage, sl_price, tp_price,
            entry_thesis, created_at
     FROM trade_executions
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC LIMIT 20`,
  );
  if (executions.length === 0) {
    console.log('  No executions found.');
  } else {
    for (const e of executions) {
      const ts = new Date(e.created_at).toISOString().slice(11, 19);
      const sl = e.sl_price ? `SL:$${Number(e.sl_price).toFixed(2)}` : '';
      const tp = e.tp_price ? `TP:$${Number(e.tp_price).toFixed(2)}` : '';
      console.log(`  ${ts} ${e.pair} ${e.action} ${e.side} ${e.leverage}x @ $${Number(e.fill_price).toFixed(2)} qty:${e.quantity} ${sl} ${tp}`);
      if (e.entry_thesis) console.log(`         "${e.entry_thesis.slice(0, 120)}"`);
    }
  }

  // ── 5. Trade Closes ──
  section('TRADE CLOSES (last 20)');
  const { rows: closes } = await pool.query(
    `SELECT pair, side, close_reason, exit_price, pnl_usd, pnl_pct, held_hours, created_at
     FROM trade_closes
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC LIMIT 20`,
  );
  if (closes.length === 0) {
    console.log('  No closes found.');
  } else {
    for (const c of closes) {
      const ts = new Date(c.created_at).toISOString().slice(11, 19);
      const pnl = c.pnl_usd != null ? `${Number(c.pnl_usd) >= 0 ? '+' : ''}$${Number(c.pnl_usd).toFixed(2)}` : '';
      const pct = c.pnl_pct != null ? `(${Number(c.pnl_pct) >= 0 ? '+' : ''}${Number(c.pnl_pct).toFixed(1)}%)` : '';
      const held = c.held_hours != null ? `${Number(c.held_hours).toFixed(1)}h` : '';
      console.log(`  ${ts} ${c.pair} ${c.side} ${c.close_reason} ${pnl} ${pct} held:${held}`);
    }
  }

  // ── 6. Errors ──
  section('ERRORS (last 10)');
  const { rows: errors } = await pool.query(
    `SELECT code, message, context, created_at
     FROM errors
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC LIMIT 10`,
  );
  if (errors.length === 0) {
    console.log('  No errors found.');
  } else {
    for (const e of errors) {
      const ts = new Date(e.created_at).toISOString().slice(11, 19);
      console.log(`  ${ts} [${e.code}] ${e.message?.slice(0, 100)}`);
    }
  }

  // ── 7. Token Usage Summary ──
  section('TOKEN USAGE (today)');
  const { rows: tokens } = await pool.query(
    `SELECT model, method,
            COUNT(*) as calls,
            SUM(tokens_in) as total_in,
            SUM(tokens_out) as total_out
     FROM token_usage
     WHERE created_at > CURRENT_DATE
     GROUP BY model, method
     ORDER BY total_in DESC`,
  );
  if (tokens.length === 0) {
    console.log('  No token usage today.');
  } else {
    for (const t of tokens) {
      row(`${t.model}/${t.method}`, `${t.calls} calls | in:${Number(t.total_in).toLocaleString()} out:${Number(t.total_out).toLocaleString()}`);
    }
  }

  // ── 8. Swarm Personas (last debate) ──
  section('LAST SWARM DEBATE');
  const { rows: personas } = await pool.query(
    `SELECT persona, model, vote, confidence, reasoning, created_at
     FROM swarm_personas
     WHERE created_at > NOW() - INTERVAL '${hours} hours'
     ORDER BY created_at DESC LIMIT 10`,
  );
  if (personas.length === 0) {
    console.log('  No swarm debates found.');
  } else {
    for (const p of personas) {
      const ts = new Date(p.created_at).toISOString().slice(11, 19);
      const conf = p.confidence ? `(${p.confidence}%)` : '';
      console.log(`  ${ts} [${p.model}] ${p.persona}: ${p.vote} ${conf}`);
      if (p.reasoning) console.log(`         ${p.reasoning.slice(0, 100)}`);
    }
  }

  // ── 9. Market Snapshots (latest per pair) ──
  section('LATEST MARKET SNAPSHOTS');
  const { rows: snaps } = await pool.query(
    `SELECT DISTINCT ON (pair) pair, mark_price, open_interest, funding_rate,
            long_short_ratio, price_change_pct, oi_change_pct, created_at
     FROM market_snapshots
     ORDER BY pair, created_at DESC`,
  );
  if (snaps.length === 0) {
    console.log('  No market snapshots found.');
  } else {
    for (const s of snaps) {
      const ts = new Date(s.created_at).toISOString().slice(11, 19);
      const price = s.mark_price ? `$${Number(s.mark_price).toFixed(2)}` : '?';
      const fr = s.funding_rate ? `FR:${(Number(s.funding_rate) * 100).toFixed(4)}%` : '';
      const ls = s.long_short_ratio ? `L/S:${Number(s.long_short_ratio).toFixed(2)}` : '';
      const priceChg = s.price_change_pct != null ? `Δ${Number(s.price_change_pct).toFixed(2)}%` : '';
      console.log(`  ${s.pair} ${price} ${fr} ${ls} ${priceChg} @ ${ts}`);
    }
  }

  console.log('\n');
} catch (err: any) {
  console.error('DB error:', err.message);
} finally {
  await pool.end();
}
