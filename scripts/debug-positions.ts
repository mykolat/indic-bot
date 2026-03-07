/**
 * debug-positions.ts — show open positions + account balance
 * Usage: npx tsx scripts/debug-positions.ts
 */
import 'dotenv/config';
import { USDMClient } from 'binance';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const client = new USDMClient({
  api_key: config.binance.apiKey,
  api_secret: config.binance.apiSecret,
  baseUrl: config.binance.testnet ? 'https://testnet.binancefuture.com' : undefined,
});

const account = await client.getAccountInformation();
const balance = account.totalWalletBalance;
const unrealizedPnl = account.totalUnrealizedProfit;
const available = account.availableBalance;
const positions = account.positions.filter((p: any) => parseFloat(p.positionAmt) !== 0);

console.log(`\n  Account Balance`);
console.log('─'.repeat(50));
console.log(`  Wallet:      $${parseFloat(balance).toFixed(2)}`);
console.log(`  Available:   $${parseFloat(available).toFixed(2)}`);
console.log(`  Unrealized:  $${parseFloat(unrealizedPnl).toFixed(4)}`);

if (positions.length === 0) {
  console.log(`\n  No open positions`);
} else {
  console.log(`\n  Open Positions (${positions.length})`);
  console.log('─'.repeat(80));
  console.log('  Symbol      Side    Amt          Entry        Mark         PnL          Lev');
  console.log('─'.repeat(80));
  for (const p of positions) {
    const amt = parseFloat(p.positionAmt);
    const side = amt > 0 ? 'LONG' : 'SHORT';
    const pnl = parseFloat(p.unrealizedProfit);
    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
    console.log(`  ${p.symbol.padEnd(10)} ${side.padEnd(6)}  ${Math.abs(amt).toString().padEnd(12)} ${parseFloat(p.entryPrice).toFixed(2).padEnd(12)} ${parseFloat(p.markPrice).toFixed(2).padEnd(12)} ${pnlStr.padEnd(12)} ${p.leverage}x`);
  }
}

// Show open orders (SL/TP)
const orders = await client.getAllOpenOrders();
if (orders.length > 0) {
  console.log(`\n  Open Orders (${orders.length})`);
  console.log('─'.repeat(80));
  for (const o of orders) {
    console.log(`  ${(o as any).symbol.padEnd(10)} ${(o as any).type.padEnd(18)} ${(o as any).side.padEnd(5)} price:${(o as any).stopPrice || (o as any).price} qty:${(o as any).origQty}`);
  }
}
