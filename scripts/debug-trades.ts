/**
 * debug-trades.ts — show recent Binance futures trades
 * Usage: npx tsx scripts/debug-trades.ts [hours=24]
 */
import 'dotenv/config';
import { USDMClient } from 'binance';
import { loadConfig } from '../src/config.js';

const hours = parseInt(process.argv[2] || '24', 10);
const config = loadConfig();
const client = new USDMClient({
  api_key: config.binance.apiKey,
  api_secret: config.binance.apiSecret,
  baseUrl: config.binance.testnet ? 'https://testnet.binancefuture.com' : undefined,
});

const since = Date.now() - hours * 3_600_000;
const pairs = config.trading.pairs;
const all: any[] = [];

for (const p of pairs) {
  try {
    const trades = await client.getAccountTrades({ symbol: p, startTime: since, limit: 100 });
    all.push(...trades);
  } catch {}
}

all.sort((a: any, b: any) => a.time - b.time);

if (all.length === 0) {
  console.log(`No trades in last ${hours}h`);
  process.exit(0);
}

console.log(`\n  Binance Futures Trades (last ${hours}h)\n${'─'.repeat(90)}`);
console.log('  Time              Symbol      Side   Qty          Price        PnL          Fee');
console.log('─'.repeat(90));

let totalPnl = 0;
let totalFee = 0;
for (const t of all) {
  const time = new Date(t.time).toISOString().slice(0, 19).replace('T', ' ');
  const pnl = parseFloat(t.realizedPnl);
  const fee = parseFloat(t.commission);
  totalPnl += pnl;
  totalFee += fee;
  const pnlStr = pnl === 0 ? '—' : (pnl > 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4));
  console.log(`  ${time}  ${t.symbol.padEnd(10)} ${t.side.padEnd(5)}  ${t.qty.toString().padEnd(12)} ${t.price.toString().padEnd(12)} ${pnlStr.padEnd(12)} ${fee.toFixed(4)}`);
}

console.log('─'.repeat(90));
console.log(`  Total: ${all.length} trades | PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} | Fees: ${totalFee.toFixed(4)}`);
