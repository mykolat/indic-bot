/**
 * snapshot.ts — detailed Binance account snapshot with trade history, funding, commissions
 * Usage: npx tsx scripts/snapshot.ts [--pair SOLUSDT] [--hours 24]
 *
 * Sections:
 *   1. Account balances & margin
 *   2. Open positions with SL/TP
 *   3. Trade history with commissions per pair
 *   4. Income history (funding fees, realized PnL, commissions)
 *   5. Per-position P&L reconciliation (entry→exit with all fees)
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

// CLI args
const args = process.argv.slice(2);
const pairIdx = args.indexOf('--pair');
const hoursIdx = args.indexOf('--hours');
const filterPair = pairIdx !== -1 ? args[pairIdx + 1] : undefined;
const lookbackHours = hoursIdx !== -1 ? parseInt(args[hoursIdx + 1]) : 72;

const startTime = Date.now() - lookbackHours * 60 * 60 * 1000;
const pairs = filterPair ? [filterPair] : config.trading.pairs;

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function row(label: string, value: string | number) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

// ── 1. ACCOUNT ──────────────────────────────────────────────
section('ACCOUNT');
const account = await client.getAccountInformation();
row('Wallet Balance', `$${parseFloat(account.totalWalletBalance).toFixed(2)}`);
row('Margin Balance', `$${parseFloat(account.totalMarginBalance).toFixed(2)}`);
row('Available Balance', `$${parseFloat(account.availableBalance).toFixed(2)}`);
row('Unrealized PnL', `$${parseFloat(account.totalUnrealizedProfit).toFixed(2)}`);
row('Initial Margin', `$${parseFloat(account.totalInitialMargin).toFixed(2)}`);
row('Maint Margin', `$${parseFloat(account.totalMaintMargin).toFixed(2)}`);
row('Fee Tier', (account as any).feeTier ?? 'n/a');

// ── 2. OPEN POSITIONS ───────────────────────────────────────
section('OPEN POSITIONS');
const positions = await client.getPositions();
const open = positions.filter((p: any) => parseFloat(p.positionAmt) !== 0);

let algoOrders: any[] = [];
try { algoOrders = await client.getOpenAlgoOrders() as any[]; } catch { /* */ }

if (open.length === 0) {
  console.log('  No open positions.');
} else {
  for (const p of open as any[]) {
    const side = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
    const notional = Math.abs(parseFloat(p.notional));
    const lev = parseInt(p.leverage);
    const margin = notional / lev;
    const pnl = parseFloat(p.unRealizedProfit);
    const pnlPct = (pnl / margin * 100);
    console.log(`\n  ${p.symbol} ${side} ${lev}x`);
    row('  Entry Price', `$${parseFloat(p.entryPrice)}`);
    row('  Mark Price', `$${parseFloat(p.markPrice)}`);
    row('  Amount', `${p.positionAmt}`);
    row('  Notional', `$${notional.toFixed(2)}`);
    row('  Margin', `$${margin.toFixed(2)}`);
    row('  Unrealized PnL', `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);
    row('  Liquidation', `$${parseFloat(p.liquidationPrice).toFixed(2)}`);

    const posAlgos = algoOrders.filter((o: any) => o.symbol === p.symbol);
    const sl = posAlgos.find((o: any) => o.orderType === 'STOP_MARKET');
    const tp = posAlgos.find((o: any) => o.orderType === 'TAKE_PROFIT_MARKET');
    if (sl) row('  Stop-Loss', `$${parseFloat(sl.triggerPrice)}`);
    if (tp) row('  Take-Profit', `$${parseFloat(tp.triggerPrice)}`);
  }
}

// ── 3. TRADE HISTORY ────────────────────────────────────────
section(`TRADE HISTORY (last ${lookbackHours}h)`);

interface TradeRecord {
  symbol: string;
  side: string;
  price: number;
  qty: number;
  quoteQty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  maker: boolean;
  time: number;
  orderId: number;
}

const allTrades: TradeRecord[] = [];

for (const symbol of pairs) {
  try {
    // userTrades limited to 7-day windows, chunk if needed
    let symTrades: any[] = [];
    let windowStart = startTime;
    const windowSize = 7 * 24 * 60 * 60 * 1000;

    while (windowStart < Date.now()) {
      const windowEnd = Math.min(windowStart + windowSize, Date.now());
      const chunk = await client.getAccountTrades({
        symbol,
        startTime: windowStart,
        endTime: windowEnd,
        limit: 1000,
      });
      symTrades.push(...chunk);
      windowStart = windowEnd;
    }

    if (!symTrades.length) continue;

    console.log(`\n  ${symbol} (${symTrades.length} fills)`);
    let pairPnl = 0;
    let pairComm = 0;

    for (const t of symTrades as any[]) {
      const pnl = parseFloat(t.realizedPnl || '0');
      const comm = parseFloat(t.commission || '0');
      pairPnl += pnl;
      pairComm += comm;
      allTrades.push({
        symbol, side: t.side, price: parseFloat(t.price),
        qty: parseFloat(t.qty), quoteQty: parseFloat(t.quoteQty),
        realizedPnl: pnl, commission: comm,
        commissionAsset: t.commissionAsset,
        maker: t.maker, time: t.time, orderId: t.orderId,
      });

      const sign = pnl >= 0 ? '+' : '';
      const ts = new Date(t.time).toISOString().slice(5, 19).replace('T', ' ');
      console.log(`    ${ts} ${t.side.padEnd(4)} ${String(t.qty).padStart(10)} @ $${parseFloat(t.price)} | PnL: ${sign}$${pnl.toFixed(4)} | Comm: ${comm.toFixed(4)} ${t.commissionAsset}`);
    }

    console.log(`    ─── ${symbol}: PnL ${pairPnl >= 0 ? '+' : ''}$${pairPnl.toFixed(4)} | Commissions: $${pairComm.toFixed(4)}`);
  } catch (e: any) {
    console.log(`  ${symbol}: error — ${e.message}`);
  }
}

const totalTradesPnl = allTrades.reduce((s, t) => s + t.realizedPnl, 0);
const totalComm = allTrades.reduce((s, t) => s + t.commission, 0);
console.log(`\n  TOTAL: PnL ${totalTradesPnl >= 0 ? '+' : ''}$${totalTradesPnl.toFixed(4)} | Commissions: $${totalComm.toFixed(4)}`);

// ── 4. INCOME HISTORY ───────────────────────────────────────
section(`INCOME HISTORY (last ${lookbackHours}h)`);

const incomeTypes = ['FUNDING_FEE', 'REALIZED_PNL', 'COMMISSION', 'TRANSFER'] as const;
const incomeSummary: Record<string, { total: number; count: number; byPair: Record<string, number> }> = {};

for (const incomeType of incomeTypes) {
  try {
    const income = await (client as any).getIncomeHistory({
      incomeType,
      startTime,
      limit: 1000,
    });

    if (!income.length) continue;

    const byPair: Record<string, number> = {};
    let total = 0;
    for (const i of income) {
      const amt = parseFloat(i.income);
      total += amt;
      if (i.symbol) {
        byPair[i.symbol] = (byPair[i.symbol] || 0) + amt;
      }
    }

    incomeSummary[incomeType] = { total, count: income.length, byPair };

    const sign = total >= 0 ? '+' : '';
    console.log(`\n  ${incomeType}: ${sign}$${total.toFixed(4)} (${income.length} entries)`);

    // Show per-pair breakdown
    const sortedPairs = Object.entries(byPair).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [pair, amt] of sortedPairs) {
      const s = amt >= 0 ? '+' : '';
      console.log(`    ${pair.padEnd(14)} ${s}$${amt.toFixed(4)}`);
    }
  } catch (e: any) {
    console.log(`  ${incomeType}: error — ${e.message}`);
  }
}

// ── 5. MARKET DATA ──────────────────────────────────────────
section('MARKET DATA');

for (const symbol of filterPair ? [filterPair] : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  try {
    // Current ticker
    const ticker = await (client as any).get24hrChangeStatistics({ symbol });
    const price = parseFloat(ticker.lastPrice);
    const change = parseFloat(ticker.priceChangePercent);
    const vol = parseFloat(ticker.quoteVolume);

    // Open Interest
    const oi = await (client as any).getOpenInterest({ symbol });
    const oiValue = parseFloat(oi.openInterest) * price;

    // Funding rate
    const funding = await (client as any).getFundingRateHistory({ symbol, limit: 1 });
    const fundRate = funding.length > 0 ? parseFloat(funding[0].fundingRate) : 0;

    // Long/Short ratio
    let lsRatio = 'n/a';
    try {
      const ls = await (client as any).getGlobalLongShortAccountRatio({ symbol, period: '1h', limit: 1 });
      if (ls.length > 0) lsRatio = ls[0].longShortRatio;
    } catch { /* not available for all pairs */ }

    // Top trader positions
    let topLs = 'n/a';
    try {
      const top = await (client as any).getTopTradersLongShortPositionRatio({ symbol, period: '1h', limit: 1 });
      if (top.length > 0) topLs = top[0].longShortRatio;
    } catch { /* */ }

    console.log(`\n  ${symbol}`);
    row('  Price', `$${price} (${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h)`);
    row('  Volume 24h', `$${(vol / 1e6).toFixed(1)}M`);
    row('  Open Interest', `$${(oiValue / 1e6).toFixed(1)}M`);
    row('  Funding Rate', `${(fundRate * 100).toFixed(4)}%`);
    row('  L/S Ratio (all)', lsRatio);
    row('  L/S Ratio (top)', topLs);
  } catch (e: any) {
    console.log(`  ${symbol}: error — ${e.message}`);
  }
}

// ── 6. P&L RECONCILIATION ───────────────────────────────────
section('P&L RECONCILIATION');

const fundingByPair = incomeSummary['FUNDING_FEE']?.byPair ?? {};
const realizedByPair = incomeSummary['REALIZED_PNL']?.byPair ?? {};
const commByPair: Record<string, number> = {};
for (const t of allTrades) {
  // Commission in non-USDT assets needs conversion, approximate as-is
  commByPair[t.symbol] = (commByPair[t.symbol] || 0) + t.commission;
}

const allSymbols = new Set([
  ...Object.keys(fundingByPair),
  ...Object.keys(realizedByPair),
  ...Object.keys(commByPair),
]);

console.log(`\n  ${'Pair'.padEnd(14)} ${'Realized'.padStart(10)} ${'Funding'.padStart(10)} ${'Comm'.padStart(10)} ${'Net'.padStart(10)}`);
console.log(`  ${'─'.repeat(54)}`);

let grandRealized = 0, grandFunding = 0, grandComm = 0;

for (const sym of [...allSymbols].sort()) {
  if (filterPair && sym !== filterPair) continue;
  const realized = realizedByPair[sym] || 0;
  const funding = fundingByPair[sym] || 0;
  const comm = commByPair[sym] || 0;
  const net = realized + funding - comm;
  grandRealized += realized;
  grandFunding += funding;
  grandComm += comm;

  const fmt = (n: number) => `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
  console.log(`  ${sym.padEnd(14)} ${fmt(realized).padStart(10)} ${fmt(funding).padStart(10)} ${fmt(-comm).padStart(10)} ${fmt(net).padStart(10)}`);
}

const grandNet = grandRealized + grandFunding - grandComm;
console.log(`  ${'─'.repeat(54)}`);
const fmt = (n: number) => `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
console.log(`  ${'TOTAL'.padEnd(14)} ${fmt(grandRealized).padStart(10)} ${fmt(grandFunding).padStart(10)} ${fmt(-grandComm).padStart(10)} ${fmt(grandNet).padStart(10)}`);

console.log('\n  Note: Commission may be in BNB — amounts shown in commission asset units.');
console.log('  Funding: negative = you paid, positive = you received.');
