import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { PnlHeader } from '../components/PnlHeader';
import { HeroBlock } from '../components/HeroBlock';
import { DailyPnlBar } from '../components/charts/DailyPnlBar';
import { EquityCurve } from '../components/charts/EquityCurve';
import { BalanceArea } from '../components/charts/BalanceArea';
import { FunnelBar } from '../components/charts/FunnelBar';
import { StatCard } from '../components/StatCard';
import { PositionCardList } from '../components/PositionCard';
import { ErrorFeed } from '../components/ErrorFeed';
import { CycleSummary } from '../components/CycleSummary';
import { usePnlData } from '../hooks/usePnlData';
import { useFunnelData } from '../hooks/useFunnelData';
import { useBalanceHistory } from '../hooks/useBalanceHistory';
import { useQuantMetrics } from '../hooks/useQuantMetrics';

export function Overview() {
  const [range, setRange] = useState<'7D' | '1M' | '3M' | 'ALL'>('7D');
  const pnl = usePnlData(range);
  const funnel = useFunnelData();
  const balance = useBalanceHistory();
  const quant = useQuantMetrics();

  const [cycle, setCycle] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);

  const fetchLive = useCallback(() => {
    supabase.from('cycles').select('*').order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => data?.[0] && setCycle(data[0]));
    supabase.rpc('get_open_positions').then(({ data }) => data && setPositions(data));
    const twoH = new Date(Date.now() - 7200_000).toISOString();
    supabase.from('errors').select('code, message, created_at')
      .gte('created_at', twoH).order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => data && setErrors(data));
  }, []);

  useEffect(() => { fetchLive(); const iv = setInterval(fetchLive, 30_000); return () => clearInterval(iv); }, [fetchLive]);

  useEffect(() => {
    const ch = supabase.channel('errors-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'errors' },
        (p) => setErrors((prev) => [p.new as any, ...prev].slice(0, 20)))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const cycleAge = cycle?.created_at ? Math.round((Date.now() - new Date(cycle.created_at).getTime()) / 60_000) : null;
  const balanceNum = Number(cycle?.balance || 1);
  const sessionPnl = Number(cycle?.session_pnl || 0);
  const sessionPnlPct = balanceNum > 0 ? (sessionPnl / (balanceNum - sessionPnl)) * 100 : 0;
  const todayPct = balanceNum > 0 ? (pnl.todayPnl / balanceNum) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">Overview</h1>
        {cycleAge !== null && cycle?.id && (
          <CycleSummary cycleId={cycle.id} cycleAge={cycleAge} />
        )}
      </div>

      {/* Hero: Balance + PnL + Regime */}
      <HeroBlock
        balance={balanceNum}
        sessionPnl={sessionPnl}
        sessionPnlPct={sessionPnlPct}
        regime={cycle?.regime}
        regimeConfidence={cycle?.regime_confidence}
        fearGreed={cycle?.fear_greed_value}
        volumeRatio={cycle?.volume_ratio != null ? Number(cycle.volume_ratio) : null}
        layer={cycle?.layer}
        confluenceScore={cycle?.confluence_score != null ? Number(cycle.confluence_score) : null}
      />

      <PnlHeader
        todayPnl={pnl.todayPnl}
        todayPct={todayPct}
        weekPnl={pnl.weekPnl}
        monthPnl={pnl.monthPnl}
        allTimePnl={pnl.allTimePnl}
        totalProfit={pnl.totalProfit}
        totalLoss={Math.abs(pnl.totalLoss)}
        onRangeChange={setRange}
        selectedRange={range}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Daily PnL</h3>
          <DailyPnlBar data={pnl.dailyPnl} />
        </div>
        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Cumulative PnL</h3>
          <EquityCurve data={pnl.cumulative} />
        </div>
        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Balance</h3>
          <BalanceArea data={balance.data} />
        </div>
      </div>

      {quant.metrics && (
        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Quant Metrics <span className="text-zinc-500 font-normal">({quant.metrics.tradeCount} trades)</span></h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Sharpe Ratio"
              value={quant.metrics.sharpeRatio != null ? quant.metrics.sharpeRatio.toFixed(2) : '—'}
              subtitle={quant.metrics.sharpeRatio == null ? `Need ${30 - quant.metrics.tradeCount} more trades` : quant.metrics.sharpeRatio >= 1 ? 'Good' : quant.metrics.sharpeRatio >= 0 ? 'Weak' : 'Negative'}
              color={quant.metrics.sharpeRatio == null ? 'default' : quant.metrics.sharpeRatio >= 1 ? 'green' : quant.metrics.sharpeRatio >= 0 ? 'yellow' : 'red'}
            />
            <StatCard
              label="Max Drawdown"
              value={quant.metrics.maxDrawdownPct != null ? `${quant.metrics.maxDrawdownPct.toFixed(1)}%` : '—'}
              subtitle={quant.metrics.maxDrawdownPct != null ? (quant.metrics.maxDrawdownPct < 10 ? 'Healthy' : quant.metrics.maxDrawdownPct < 25 ? 'Moderate' : 'High') : undefined}
              color={quant.metrics.maxDrawdownPct == null ? 'default' : quant.metrics.maxDrawdownPct < 10 ? 'green' : quant.metrics.maxDrawdownPct < 25 ? 'yellow' : 'red'}
            />
            <StatCard
              label="Profit Factor"
              value={quant.metrics.profitFactor != null ? quant.metrics.profitFactor.toFixed(2) : '—'}
              subtitle={quant.metrics.profitFactor == null ? `Need ${20 - quant.metrics.tradeCount} more trades` : quant.metrics.profitFactor >= 1.5 ? 'Strong' : quant.metrics.profitFactor >= 1 ? 'Marginal' : 'Losing'}
              color={quant.metrics.profitFactor == null ? 'default' : quant.metrics.profitFactor >= 1.5 ? 'green' : quant.metrics.profitFactor >= 1 ? 'yellow' : 'red'}
            />
            <StatCard
              label="Expectancy"
              value={quant.metrics.expectancy != null ? `$${quant.metrics.expectancy.toFixed(2)}` : '—'}
              subtitle={quant.metrics.expectancy == null ? `Need ${30 - quant.metrics.tradeCount} more trades` : 'Avg $ per trade'}
              color={quant.metrics.expectancy == null ? 'default' : quant.metrics.expectancy > 0 ? 'green' : 'red'}
            />
          </div>
        </div>
      )}

      {funnel.data && (
        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Decision Pipeline</h3>
          <FunnelBar steps={[
            { label: 'Cycles', count: funnel.data.totalCycles, color: '#71717a' },
            { label: 'Decisions', count: funnel.data.totalDecisions, color: '#60a5fa' },
            { label: 'Risk Passed', count: funnel.data.riskPassed, color: '#eab308' },
            { label: 'Executed', count: funnel.data.executed, color: '#4ade80' },
            { label: 'Closed', count: funnel.data.closedTp + funnel.data.closedSl + funnel.data.closedManual, color: '#a78bfa' },
          ]} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Open Positions</h3>
          <PositionCardList positions={positions} />
        </div>
        <div className="bg-surface-1 rounded-xl border border-border">
          <div className="p-3 border-b border-border text-sm font-semibold text-zinc-300">Recent Errors (2h)</div>
          <ErrorFeed errors={errors} />
        </div>
      </div>
    </div>
  );
}
