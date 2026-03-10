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
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(64));
}

function row(label: string, val: string | number | null | undefined) {
  if (val == null) return;
  console.log(`  ${String(label).padEnd(28)} ${val}`);
}

try {
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

    const bb = conv.blackboard_state;
    if (bb?.market) {
      console.log(`\n  -- MARKET CONTEXT --`);
      row('Pairs', bb.market.pairs?.join(', '));
      row('Regime', bb.market.regime);
      row('F&G', bb.market.fearGreed);
      row('Volume ratio', bb.market.volumeRatio ? `${bb.market.volumeRatio}x` : null);
    }

    if (conv.cycle_id) {
      const { rows: [cycle] } = await pool.query(
        `SELECT cycle_number, balance, session_pnl, regime, volume_ratio,
                fear_greed_value, layer, filter_warning
         FROM cycles WHERE id = $1`, [conv.cycle_id]);
      if (cycle) {
        console.log(`\n  -- CYCLE #${cycle.cycle_number} --`);
        row('Balance', `$${Number(cycle.balance).toFixed(2)}`);
        row('Session P&L', cycle.session_pnl != null ? `${Number(cycle.session_pnl) >= 0 ? '+' : ''}$${Number(cycle.session_pnl).toFixed(2)}` : null);
        row('Layer', cycle.layer);
      }
    }

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
          console.log(`\n  -- ROUND ${currentPhase} --`);
        }

        const conf = p.confidence ? ` (c:${p.confidence})` : '';
        const voteStr = p.vote ? `${p.vote}${conf}` : 'NO VOTE';
        const model = p.model === 'grok' ? ' [Grok]' : '';

        console.log(`  ${p.persona}: ${voteStr}${model}`);
        if (p.reasoning) {
          console.log(`     ${p.reasoning.slice(0, 200)}`);
        }

        const sig = p.signals;
        if (sig) {
          const parts: string[] = [];
          if (sig.bullish?.length) parts.push(`^ ${sig.bullish.join(', ')}`);
          if (sig.bearish?.length) parts.push(`v ${sig.bearish.join(', ')}`);
          if (parts.length > 0) console.log(`     Signals: ${parts.join(' | ')}`);
        }

        if (p.conflicts_with && Object.keys(p.conflicts_with).length > 0) {
          const conflicts = Object.entries(p.conflicts_with).map(([k, v]) => `${k}: ${v}`).join(', ');
          console.log(`     Conflicts: ${conflicts}`);
        }
      }
    }

    if (bb?.conflicts?.length > 0) {
      console.log(`\n  -- BLACKBOARD CONFLICTS --`);
      for (const c of bb.conflicts) {
        console.log(`  ${c.between?.[0] ?? '?'} <-> ${c.between?.[1] ?? '?'}: ${c.reason ?? ''} (${c.severity ?? 'unknown'})`);
      }
    }

    console.log(`\n  -- JUDGE VERDICT --`);
    row('Label', conv.label);
    row('Parsed OK', conv.parsed_ok ? 'YES' : 'NO');
    if (conv.parse_error) row('Parse error', conv.parse_error);
    row('Tokens', `in:${conv.tokens_in ?? '?'} out:${conv.tokens_out ?? '?'}`);
    row('Latency', conv.latency_ms ? `${conv.latency_ms}ms` : null);

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
        console.log(`\n  -- DECISIONS --`);
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

    // -- Hindsight --
    if (judgeResult?.decisions?.length > 0 && bb?.market?.pairs?.length > 0) {
      console.log(`\n  -- HINDSIGHT --`);
      const mainPair = bb.market.pairs[0];

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

        // Per-persona accuracy (4h)
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
          row('Decision accuracy', wasRight ? 'CORRECT (4h)' : `WRONG (${mainPair} moved ${move4h.toFixed(2)}%)`);

          if (personas.length > 0) {
            console.log(`\n  -- PERSONA ACCURACY (4h) --`);
            for (const p of personas) {
              if (!p.vote) continue;
              const right = (p.vote === 'LONG' && move4h > 0.5) ||
                            (p.vote === 'SHORT' && move4h < -0.5) ||
                            (p.vote === 'HOLD' && Math.abs(move4h) < 1);
              console.log(`  ${right ? '[+]' : '[-]'} ${p.persona}: ${p.vote} (price ${move4h >= 0 ? '+' : ''}${move4h.toFixed(2)}%)`);
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
