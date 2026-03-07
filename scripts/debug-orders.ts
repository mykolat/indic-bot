/**
 * debug-orders.ts — show recent order history (filled, canceled, expired)
 * Usage: npx tsx scripts/debug-orders.ts [hours=24]
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
    const orders = await client.getAllOrders({ symbol: p, startTime: since, limit: 100 });
    all.push(...orders);
  } catch {}
}

all.sort((a: any, b: any) => a.time - b.time);

if (all.length === 0) {
  console.log(`No orders in last ${hours}h`);
  process.exit(0);
}

console.log(`\n  Order History (last ${hours}h) — ${all.length} orders`);
console.log('─'.repeat(110));
console.log('  Time              Symbol      Type               Side   Status      Price        StopPrice    Qty');
console.log('─'.repeat(110));

for (const o of all) {
  const time = new Date(o.time).toISOString().slice(0, 19).replace('T', ' ');
  const status = o.status === 'FILLED' ? '✓ FILLED' : o.status === 'CANCELED' ? '✗ CANCEL' : o.status === 'EXPIRED' ? '⊘ EXPIRE' : o.status;
  const price = o.avgPrice && parseFloat(o.avgPrice) > 0 ? parseFloat(o.avgPrice).toFixed(2) : (o.price || '—');
  const stop = o.stopPrice && parseFloat(o.stopPrice) > 0 ? parseFloat(o.stopPrice).toFixed(2) : '—';
  console.log(`  ${time}  ${o.symbol.padEnd(10)} ${o.type.padEnd(18)} ${o.side.padEnd(5)}  ${status.padEnd(10)} ${price.toString().padEnd(12)} ${stop.toString().padEnd(12)} ${o.origQty}`);
}
