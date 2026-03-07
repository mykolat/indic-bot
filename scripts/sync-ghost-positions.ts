/**
 * One-shot script: fetch actual close data from Binance for ghost positions
 * (trade_executions without trade_closes) and insert trade_closes.
 *
 * Usage: npx tsx scripts/sync-ghost-positions.ts
 * Must run on GCP VM (Binance API IP-whitelisted there).
 */
import { USDMClient } from 'binance';
import { loadConfig } from '../src/config.js';
import pg from 'pg';

interface GhostPosition {
  id: number;
  pair: string;
  side: string;
  fill_price: string;
  leverage: number;
  size_usd: string;
  opened_at: string;
}

async function main() {
  const config = loadConfig();
  const client = new USDMClient({
    api_key: config.binance.apiKey,
    api_secret: config.binance.apiSecret,
  });

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  // 1. Get ghost positions from DB
  const { rows: ghosts } = await pool.query<GhostPosition>(`
    SELECT te.id, te.pair, te.side, te.fill_price, te.leverage, te.size_usd, te.opened_at
    FROM trade_executions te
    LEFT JOIN trade_closes tc ON tc.execution_id = te.id
    WHERE tc.id IS NULL
      AND te.fill_price IS NOT NULL
      AND te.opened_at > NOW() - INTERVAL '7 days'
    ORDER BY te.opened_at DESC
  `);

  console.log(`Found ${ghosts.length} ghost positions`);
  if (ghosts.length === 0) {
    console.log('Nothing to sync');
    await pool.end();
    return;
  }

  // 2. For each ghost, fetch trades from Binance
  const pairs = [...new Set(ghosts.map(g => g.pair))];

  for (const pair of pairs) {
    const pairGhosts = ghosts.filter(g => g.pair === pair);
    console.log(`\n--- ${pair}: ${pairGhosts.length} ghost(s) ---`);

    const trades = await client.getAccountTrades({
      symbol: pair,
      startTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
      limit: 1000,
    });
    console.log(`  Binance trades: ${trades.length}`);

    const orders = await client.getAllOrders({
      symbol: pair,
      startTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
      limit: 500,
    });

    for (const ghost of pairGhosts) {
      const openedMs = new Date(ghost.opened_at).getTime();
      const entryPrice = parseFloat(ghost.fill_price);
      const margin = parseFloat(ghost.size_usd) / ghost.leverage;

      const closeSide = ghost.side === 'BUY' ? 'SELL' : 'BUY';
      const closingTrades = trades.filter((t: any) =>
        t.side === closeSide &&
        t.time > openedMs &&
        t.realizedPnl !== '0' &&
        parseFloat(t.realizedPnl) !== 0
      );

      const triggerOrders = orders.filter((o: any) =>
        o.time >= openedMs &&
        (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') &&
        o.status === 'FILLED' &&
        o.closePosition === 'true'
      );

      if (closingTrades.length === 0 && triggerOrders.length === 0) {
        console.log(`  [${ghost.id}] ${ghost.pair} ${ghost.side} @ ${ghost.fill_price} — NO closing data found`);
        continue;
      }

      let exitPrice: number;
      let closedAt: string;
      let pnlUsd: number;
      let exitReason: string;

      if (triggerOrders.length > 0) {
        const trigger = triggerOrders.sort((a: any, b: any) => a.time - b.time)[0];
        exitPrice = parseFloat(trigger.avgPrice || trigger.stopPrice || trigger.activatePrice);
        closedAt = new Date(trigger.updateTime || trigger.time).toISOString();
        exitReason = trigger.type === 'STOP_MARKET' ? 'sl_triggered' : 'tp_triggered';

        if (ghost.side === 'BUY') {
          pnlUsd = (exitPrice - entryPrice) / entryPrice * margin * ghost.leverage;
        } else {
          pnlUsd = (entryPrice - exitPrice) / entryPrice * margin * ghost.leverage;
        }
      } else {
        const closeTrade = closingTrades.sort((a: any, b: any) => a.time - b.time)[0];
        exitPrice = parseFloat(closeTrade.price);
        closedAt = new Date(closeTrade.time).toISOString();
        pnlUsd = parseFloat(closeTrade.realizedPnl);
        exitReason = 'sl_triggered';
      }

      const pnlPct = ghost.side === 'BUY'
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;

      const heldMs = new Date(closedAt).getTime() - openedMs;
      const heldHours = heldMs / 3600000;

      console.log(`  [${ghost.id}] ${ghost.pair} ${ghost.side} @ ${ghost.fill_price} → exit ${exitPrice.toFixed(6)} | PnL $${pnlUsd.toFixed(4)} (${pnlPct.toFixed(2)}%) | ${exitReason} | held ${heldHours.toFixed(1)}h`);

      await pool.query(
        `INSERT INTO trade_closes (execution_id, pair, exit_price, exit_reason, pnl_usd, pnl_pct, held_hours, holding_time_minutes, closed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ghost.id, ghost.pair, exitPrice, exitReason, pnlUsd, pnlPct, heldHours, heldMs / 60000, closedAt],
      );
      console.log(`    -> inserted trade_closes`);
    }
  }

  await pool.end();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
