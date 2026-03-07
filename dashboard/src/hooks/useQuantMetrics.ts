import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface QuantMetrics {
  sharpeRatio: number | null;
  maxDrawdownPct: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  tradeCount: number;
}

export function useQuantMetrics(): { metrics: QuantMetrics | null; loading: boolean } {
  const [metrics, setMetrics] = useState<QuantMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: closes } = await supabase
        .from('trade_closes')
        .select('pnl_usd, pnl_pct, closed_at')
        .order('closed_at', { ascending: true });

      if (!closes || closes.length < 5) {
        setMetrics({ sharpeRatio: null, maxDrawdownPct: null, profitFactor: null, expectancy: null, tradeCount: closes?.length ?? 0 });
        setLoading(false);
        return;
      }

      const returns = closes.map(c => c.pnl_pct);
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length);

      // Annualized Sharpe: assume ~3 trades/day avg
      const sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(365 * 3) : null;

      // Max drawdown on cumulative USD PnL
      let peak = 0;
      let maxDd = 0;
      let cumulative = 0;
      for (const c of closes) {
        cumulative += c.pnl_usd;
        if (cumulative > peak) peak = cumulative;
        const dd = peak > 0 ? (peak - cumulative) / peak * 100 : 0;
        if (dd > maxDd) maxDd = dd;
      }

      const grossProfit = closes.filter(c => c.pnl_usd > 0).reduce((s, c) => s + c.pnl_usd, 0);
      const grossLoss = Math.abs(closes.filter(c => c.pnl_usd < 0).reduce((s, c) => s + c.pnl_usd, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

      const winCount = closes.filter(c => c.pnl_usd > 0).length;
      const loseCount = closes.filter(c => c.pnl_usd < 0).length;
      const winRate = winCount / closes.length;
      const avgWin = grossProfit / Math.max(1, winCount);
      const avgLoss = grossLoss / Math.max(1, loseCount);
      const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

      setMetrics({
        sharpeRatio: closes.length >= 30 ? sharpeRatio : null,
        maxDrawdownPct: maxDd,
        profitFactor: closes.length >= 20 ? profitFactor : null,
        expectancy: closes.length >= 30 ? expectancy : null,
        tradeCount: closes.length,
      });
      setLoading(false);
    })();
  }, []);

  return { metrics, loading };
}
