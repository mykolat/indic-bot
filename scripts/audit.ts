/**
 * audit.ts — full snapshot of bot state + Binance account
 * Usage: npx tsx scripts/audit.ts
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { USDMClient } from 'binance';
import { loadConfig } from '../src/config.js';
import { computeIndicators } from '../src/indicators/technical.js';
import { fetchFearGreed } from '../src/news/fear-greed.js';
import { classifyRegime } from '../src/market/regime-classifier.js';
import { getFilterProfile } from '../src/market/filter-profiles.js';

const config = loadConfig();
const client = new USDMClient({
  api_key: config.binance.apiKey,
  api_secret: config.binance.apiSecret,
  baseUrl: config.binance.testnet ? 'https://testnet.binancefuture.com' : undefined,
});

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function row(label: string, value: string | number) {
  const pad = 28;
  console.log(`  ${label.padEnd(pad)} ${value}`);
}

// ── 1. ACCOUNT ────────────────────────────────────────────────
section('ACCOUNT (USDT)');
const account = await client.getAccountInformation();
const usdt = (account as any).assets?.find((a: any) => a.asset === 'USDT');

row('Wallet Balance', `$${parseFloat(account.totalWalletBalance).toFixed(2)}`);
row('Margin Balance', `$${parseFloat(account.totalMarginBalance).toFixed(2)}`);
row('Available Balance', `$${parseFloat(account.availableBalance).toFixed(2)}`);
row('Unrealized PnL', `$${parseFloat(account.totalUnrealizedProfit).toFixed(2)}`);
row('Initial Margin', `$${parseFloat(account.totalInitialMargin).toFixed(2)}`);

// ── 2. OPEN POSITIONS ─────────────────────────────────────────
section('OPEN POSITIONS');
const positions = await client.getPositions();
const open = positions.filter((p: any) => parseFloat(p.positionAmt) !== 0);

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
    const liqPrice = parseFloat(p.liquidationPrice);
    console.log(`\n  ${p.symbol} ${side} ${lev}x`);
    row('  Amount', `${p.positionAmt} contracts`);
    row('  Entry Price', `$${parseFloat(p.entryPrice).toFixed(2)}`);
    row('  Mark Price', `$${parseFloat(p.markPrice).toFixed(2)}`);
    row('  Margin used', `$${margin.toFixed(2)}`);
    row('  Notional', `$${notional.toFixed(2)}`);
    row('  Unrealized PnL', `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
    row('  Liquidation', `$${liqPrice.toFixed(2)}`);
  }
}

function readJsonl(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const perf = readJsonl('logs/performance.jsonl');
const trades = readJsonl('logs/trades.jsonl');
const errors = readJsonl('logs/errors.jsonl');
const decisions = readJsonl('logs/decisions.jsonl');

// ── 3. TRADE HISTORY (Session) ──────────────────────
section('REALIZED PnL — SESSION');
const pairs = config.trading.pairs;
const since = perf.length > 0 ? new Date(perf[0].timestamp).getTime() : Date.now() - 24 * 60 * 60 * 1000;
let grandTotal = 0;

for (const symbol of pairs) {
  try {
    const trades = await client.getAccountTrades({ symbol, startTime: since, limit: 100 });
    if (!trades.length) continue;
    let pairTotal = 0;
    console.log(`\n  ${symbol}`);
    for (const t of trades as any[]) {
      const pnl = parseFloat(t.realizedPnl || '0');
      pairTotal += pnl;
      const sign = pnl >= 0 ? '+' : '';
      console.log(`    ${t.side.padEnd(5)} ${String(t.qty).padStart(10)} @ $${parseFloat(t.price).toFixed(2)} | PnL: ${sign}$${pnl.toFixed(4)} | ${new Date(t.time).toISOString()}`);
    }
    grandTotal += pairTotal;
    console.log(`    ─── ${symbol} total: ${pairTotal >= 0 ? '+' : ''}$${pairTotal.toFixed(2)}`);
  } catch (e: any) {
    console.log(`  ${symbol}: error — ${e.message}`);
  }
}
console.log(`\n  TOTAL REALIZED PnL: ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(2)}`);

// ── 4. BOT LOGS SUMMARY ───────────────────────────────────────
section('BOT LOGS SUMMARY');

if (perf.length > 0) {
  // Use very first log entry in file as start of session
  const startBalance = perf[0].balance;
  const currentWallet = parseFloat(account.totalWalletBalance);
  const unRealized = parseFloat(account.totalUnrealizedProfit);
  const pnlUsd = grandTotal + unRealized;
  const roiPct = startBalance > 0 ? (pnlUsd / startBalance) * 100 : 0;
  const roiSign = pnlUsd >= 0 ? '+' : '';

  row('Bot cycles logged', perf.length);
  row('Start balance', `$${startBalance.toFixed(2)} at ${perf[0].timestamp}`);
  row('Current wallet', `$${currentWallet.toFixed(2)}`);
  row('Session PnL (True)', `${roiSign}$${pnlUsd.toFixed(2)} (${roiSign}${roiPct.toFixed(2)}% ROI)`);
}

const executedTrades = trades.filter(t => ['LONG', 'SHORT', 'CLOSE'].includes(t.type));
row('Executed trades', executedTrades.length);
row('Errors logged', errors.length);

const llmDecisions = decisions.filter(d => d.type === 'LLM_DECISION');
const actionCounts: Record<string, number> = {};
for (const d of llmDecisions) {
  actionCounts[d.action] = (actionCounts[d.action] || 0) + 1;
}
if (Object.keys(actionCounts).length) {
  row('LLM decisions', Object.entries(actionCounts).map(([a, c]) => `${a}:${c}`).join(' | '));
}

const riskRejected = decisions.filter(d => d.type === 'RISK_REJECTED');
row('Risk rejections', riskRejected.length);

if (errors.length > 0) {
  console.log('\n  Recent errors:');
  for (const e of errors.slice(-5)) {
    console.log(`    [${e.timestamp}] ${e.code || e.type || '(Audit Error)'}: ${e.message}`);
  }
}

if (riskRejected.length > 0) {
  console.log('\n  Recent risk rejections:');
  for (const r of riskRejected.slice(-5)) {
    console.log(`    [${r.timestamp}] ${r.pair}: ${r.reason}`);
  }
}

// ── 5. MARKET REGIME ("SHARK MODE") ───────────────────────────
section('MARKET REGIME & FILTER');
try {
  const klines = await client.getKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 100 });
  const closes = klines.map((k: any) => parseFloat(k[4]));
  const highs = klines.map((k: any) => parseFloat(k[2]));
  const lows = klines.map((k: any) => parseFloat(k[3]));
  const volumes = klines.map((k: any) => parseFloat(k[5]));
  const markPrice = closes[closes.length - 1]; // Approximate

  const btcInd = computeIndicators(closes, highs, lows, volumes);
  const fearGreed = await fetchFearGreed();
  const { regime, confidence } = classifyRegime(btcInd, markPrice, fearGreed);
  const profile = getFilterProfile(regime);

  row('Detected Regime', regime);
  row('Confidence', `${confidence}/2`);
  row('Volume Req', `Must be > ${profile.volumeMin}x`);
  row('Confluence Req', `Must have >= ${profile.confluenceMin} factors`);
  row('Leverage Multiplier', `${profile.leverageMultiplier}x`);
} catch (e: any) {
  console.log(`  Error loading Market Regime: ${e.message}`);
}

// ── 6. NEWS CACHE ─────────────────────────────────────────────
section('NEWS CACHE');
const homedir = process.env.HOME || '.';
const newsCachePath = `${homedir}/.indic-bot/news-cache.json`;
if (existsSync(newsCachePath)) {
  try {
    const cache = JSON.parse(readFileSync(newsCachePath, 'utf-8'));
    const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
    const ageMin = Math.round(ageMs / 60000);
    const analysis = cache.analysis;
    row('Fetched', `${new Date(cache.fetchedAt).toISOString()} (${ageMin} min ago)`);
    row('Headlines', `${cache.items?.length ?? 0} items`);
    row('Refresh interval', `${config.trading.newsRefreshIntervalH * 60} min`);
    if (analysis) {
      row('Sentiment', analysis.overall_sentiment ?? 'n/a');
      row('Fed stance', analysis.macro_signals?.fed_stance ?? 'n/a');
      row('Risk appetite', analysis.macro_signals?.risk_appetite ?? 'n/a');
      row('BTC dominance', analysis.macro_signals?.dominance_trend ?? 'n/a');
      const signals = analysis.top_signals ?? [];
      row('Signals', `${signals.length} total`);
      if (signals.length > 0) {
        console.log('');
        for (const s of signals) {
          const coins = (s.coins ?? []).join(',') || 'GENERAL';
          const dir = s.direction?.toUpperCase().padEnd(8) ?? 'UNKNOWN ';
          console.log(`    [${s.importance}/10] ${dir} ${coins.padEnd(12)} ${s.catalyst}`);
        }
      }
      if (analysis.risk_events?.length) {
        console.log('\n  Risk events:');
        for (const e of analysis.risk_events) console.log(`    ⚠  ${e}`);
      }
    }
  } catch (e: any) {
    console.log(`  Error reading cache: ${e.message}`);
  }
} else {
  console.log('  No news cache found (~/.indic-bot/news-cache.json)');
}

// ── SOUL MEMORY ───────────────────────────────────────────────
section('SOUL MEMORY (EXTERNAL INTEL)');
const soulPath = `${homedir}/.indic-bot/soul.md`;
if (existsSync(soulPath)) {
  const content = readFileSync(soulPath, 'utf-8');
  let intelLines = [];
  let recording = false;
  for (const line of content.split('\n')) {
    if (line.trim() === '## External Insights' || line.trim() === '### ✅ Verified Intel') {
      recording = true;
      intelLines.push(line);
      continue;
    }
    if (recording && line.startsWith('#') && line.trim() !== '### ✅ Verified Intel') {
      recording = false;
    }
    if (recording && line.trim()) {
      intelLines.push(line);
    }
  }

  if (intelLines.length > 0) {
    for (const line of intelLines.slice(-10)) { // Limit to last 10 lines of intel
      console.log(`  ${line}`);
    }
  } else {
    console.log('  No external insights or verified intel currently logged.');
  }
} else {
  console.log('  No soul.md found.');
}

// ── 7. TOKEN USAGE ────────────────────────────────────────────
section('TOKEN USAGE (logs/tokens.jsonl)');
const tokenLogs = readJsonl('logs/tokens.jsonl');
if (tokenLogs.length === 0) {
  console.log('  No token logs yet.');
} else {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTokens = tokenLogs.filter(t => t.ts?.startsWith(todayStr));
  const totalIn = todayTokens.reduce((s: number, t: any) => s + (t.tokens_in ?? 0), 0);
  const totalOut = todayTokens.reduce((s: number, t: any) => s + (t.tokens_out ?? 0), 0);
  const avgIn = todayTokens.length > 0 ? Math.round(totalIn / todayTokens.length) : 0;
  const hasEstimated = todayTokens.some((t: any) => t.estimated);
  const estMark = hasEstimated ? ' (estimated)' : '';

  row('Today calls', todayTokens.length);
  row('Today tokens in', `${hasEstimated ? '~' : ''}${totalIn.toLocaleString()}${estMark}`);
  row('Today tokens out', `${hasEstimated ? '~' : ''}${totalOut.toLocaleString()}${estMark}`);
  row('Avg per call', `${hasEstimated ? '~' : ''}${avgIn.toLocaleString()} in`);

  if (todayTokens.length > 0) {
    const biggest = todayTokens.reduce((max: any, t: any) => (t.tokens_in ?? 0) > (max.tokens_in ?? 0) ? t : max, todayTokens[0]);
    const method = biggest.label ? `${biggest.method}:${biggest.label}` : biggest.method;
    row('Biggest call', `${method} — ${hasEstimated ? '~' : ''}${(biggest.tokens_in ?? 0).toLocaleString()} in @ ${biggest.ts?.slice(11, 16)}`);
  }

  row('All-time calls', tokenLogs.length);
}

// ── 8. CONFIG ─────────────────────────────────────────────────
section('BOT CONFIG');
row('Pairs', config.trading.pairs.join(', '));
row('Max leverage', `${config.trading.maxLeverage}x`);
row('Max position', `${config.trading.maxPositionPct}%`);
row('Max exposure', `${config.trading.maxExposurePct}%`);
row('Max stop-loss', `${config.trading.maxStopLossPct}%`);
row('Max loss USD', `$${config.trading.maxLossUsd}`);
row('Target return', `+${config.trading.targetReturnPct}%`);
row('Min take-profit', `${config.trading.minTakeProfitPct}%`);
row('Loop interval', `${config.trading.loopIntervalMs / 1000}s`);
row('Testnet', String(config.binance.testnet));

console.log('\n');
