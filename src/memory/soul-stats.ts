import type { TradeRecord } from './session.js';

export interface SoulStats {
  winRate: number;         // 0-100
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  currentStreak: number;   // positive = wins, negative = losses
  sessionPnlPct: number;
  bestPair: string;
  worstPair: string;
  totalTrades: number;
}

export function computeSoulStats(trades: TradeRecord[], sessionPnlPct: number): SoulStats {
  if (trades.length === 0) {
    return {
      winRate: 0, avgWinPct: 0, avgLossPct: 0, profitFactor: 0,
      currentStreak: 0, sessionPnlPct, bestPair: '-', worstPair: '-',
      totalTrades: 0,
    };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct < 0);

  const winRate = (wins.length / trades.length) * 100;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  const totalWinUsd = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const totalLossUsd = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const profitFactor = totalLossUsd > 0 ? totalWinUsd / totalLossUsd : 0;

  // Current streak (trades[0] is most recent)
  let currentStreak = 0;
  const firstPnl = trades[0].pnlPct;
  if (firstPnl > 0) {
    for (const t of trades) {
      if (t.pnlPct > 0) currentStreak++;
      else break;
    }
  } else if (firstPnl < 0) {
    for (const t of trades) {
      if (t.pnlPct < 0) currentStreak--;
      else break;
    }
  }

  // Best/worst pair by net P&L
  const pairPnl = new Map<string, number>();
  for (const t of trades) {
    pairPnl.set(t.pair, (pairPnl.get(t.pair) ?? 0) + t.pnlUsd);
  }
  let bestPair = '-', worstPair = '-', bestVal = -Infinity, worstVal = Infinity;
  for (const [pair, pnl] of pairPnl) {
    if (pnl > bestVal) { bestVal = pnl; bestPair = pair; }
    if (pnl < worstVal) { worstVal = pnl; worstPair = pair; }
  }

  return {
    winRate, avgWinPct, avgLossPct, profitFactor,
    currentStreak, sessionPnlPct, bestPair, worstPair,
    totalTrades: trades.length,
  };
}
