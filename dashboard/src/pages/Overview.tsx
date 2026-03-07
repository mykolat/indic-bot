import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { PnlHeader } from '../components/PnlHeader';
import { DailyPnlBar } from '../components/charts/DailyPnlBar';
import { EquityCurve } from '../components/charts/EquityCurve';
import { BalanceArea } from '../components/charts/BalanceArea';
import { FunnelBar } from '../components/charts/FunnelBar';
import { StatCard } from '../components/StatCard';
import { PositionTable } from '../components/PositionTable';
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
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [lastSnapshotAge, setLastSnapshotAge] = useState<number | null>(null);
  const [totalFees, setTotalFees] = useState<{ usd: number; asset: string } | null>(null);

  const fetchLive = useCallback(() => {
    supabase.from('cycles').select('*').order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => data?.[0] && setCycle(data[0]));
    supabase.rpc('get_open_positions').then(({ data }) => data && setPositions(data));
    const twoH = new Date(Date.now() - 7200_000).toISOString();
    supabase.from('errors').select('code, message, created_at')
      .gte('created_at', twoH).order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => data && setErrors(data));
    const oneH = new Date(Date.now() - 3600_000).toISOString();
    supabase.from('market_snapshots').select('id', { count: 'exact', head: true })
      .gte('created_at', oneH).then(({ count }) => setSnapshotCount(count ?? 0));
    supabase.from('market_snapshots').select('created_at')
      .order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data?.[0]) setLastSnapshotAge(Math.round((Date.now() - new Date(data[0].created_at).getTime()) / 1000));
      });
    // Fees: sum real commission_usd where available, fallback to estimated (size_usd * leverage * 0.0008)
    supabase.from('trade_executions').select('commission_usd, commission_asset, size_usd, leverage')
      .then(({ data }) => {
        if (!data) return;
        let total = 0;
        let asset = 'USDT';
        for (const e of data) {
          const comm = Number(e.commission_usd);
          if (comm > 0) {
            total += comm;
            if (e.commission_asset) asset = e.commission_asset;
          } else {
            // Estimate: entry + exit = size_usd * leverage * 0.04% * 2
            total += Number(e.size_usd || 0) * Number(e.leverage || 1) * 0.0008;
          }
        }
        setTotalFees({ usd: total, asset });
      });
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
  const watchdogOk = lastSnapshotAge !== null && lastSnapshotAge < 120;
  const pnlColor = (cycle?.session_pnl ?? 0) > 0 ? 'green' : (cycle?.session_pnl ?? 0) < 0 ? 'red' : 'default' as const;
  const balanceNum = Number(cycle?.balance || 1);
  const todayPct = balanceNum > 0 ? (pnl.todayPnl / balanceNum) * 100 : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">Overview</h1>
        {cycleAge !== null && cycle?.id && (
          <CycleSummary cycleId={cycle.id} cycleAge={cycleAge} />
        )}
      </div>

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

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard label="Wallet Balance" value={`$${Number(cycle?.balance || 0).toFixed(2)}`} />
        <StatCard label="Session PnL" value={`$${Number(cycle?.session_pnl || 0).toFixed(2)}`} color={pnlColor} />
        <StatCard label="Regime" value={cycle?.regime || '—'} subtitle={`Confidence: ${cycle?.regime_confidence != null ? `${Math.round(cycle.regime_confidence)}%` : '—'}`} />
        <StatCard
          label="Total Fees"
          value={totalFees != null ? `$${totalFees.usd.toFixed(2)}` : '—'}
          subtitle={totalFees?.asset === 'BNB' ? 'Paid in BNB' : 'Est. 0.04% taker'}
          color="red"
        />
        <StatCard label="Watchdog" value={watchdogOk ? 'Healthy' : 'Stale'} subtitle={`${snapshotCount} snaps/h`} color={watchdogOk ? 'green' : 'red'} />
      </div>

      <div className="bg-surface-1 rounded-xl border border-border p-4">
        <h3 className="text-sm font-semibold text-zinc-300 mb-3">Market State — Last Cycle</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Volume Ratio"
            value={cycle?.volume_ratio != null ? `${Number(cycle.volume_ratio).toFixed(2)}x` : '—'}
            subtitle="Swarm @ >1.5x"
            color={Number(cycle?.volume_ratio) >= 1.5 ? 'green' : Number(cycle?.volume_ratio) >= 0.8 ? 'default' : 'red'}
          />
          <StatCard
            label="Fear & Greed"
            value={cycle?.fear_greed_value != null ? String(cycle.fear_greed_value) : '—'}
            subtitle={cycle?.fear_greed_value != null ? (cycle.fear_greed_value <= 25 ? 'Extreme Fear' : cycle.fear_greed_value <= 45 ? 'Fear' : cycle.fear_greed_value <= 55 ? 'Neutral' : cycle.fear_greed_value <= 75 ? 'Greed' : 'Extreme Greed') : ''}
            color={cycle?.fear_greed_value != null ? (cycle.fear_greed_value <= 25 ? 'red' : cycle.fear_greed_value >= 75 ? 'green' : 'default') : 'default'}
          />
          <StatCard
            label="Confluence"
            value={cycle?.confluence_score != null ? `${Number(cycle.confluence_score).toFixed(1)} / 5` : '—'}
            subtitle={Array.isArray(cycle?.confluence_factors) ? cycle.confluence_factors.slice(0, 2).join(', ') : cycle?.confluence_factors ?? ''}
            color={Number(cycle?.confluence_score) >= 3 ? 'green' : Number(cycle?.confluence_score) >= 2 ? 'default' : 'red'}
          />
          <StatCard
            label="LLM Layer"
            value={cycle?.layer != null ? `Layer ${cycle.layer}` : '—'}
            subtitle={cycle?.filter_warning ? '⚠ ' + cycle.filter_warning.slice(0, 40) : 'No filter warnings'}
            color={cycle?.filter_warning ? 'red' : 'green'}
          />
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
        <div className="bg-surface-1 rounded-xl border border-border">
          <div className="p-3 border-b border-border text-sm font-semibold text-zinc-300">Open Positions</div>
          <PositionTable positions={positions} />
        </div>
        <div className="bg-surface-1 rounded-xl border border-border">
          <div className="p-3 border-b border-border text-sm font-semibold text-zinc-300">Recent Errors (2h)</div>
          <ErrorFeed errors={errors} />
        </div>
      </div>
    </div>
  );
}
