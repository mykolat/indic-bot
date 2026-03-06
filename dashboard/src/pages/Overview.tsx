import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { StatCard } from '../components/StatCard';
import { PositionTable } from '../components/PositionTable';
import { ErrorFeed } from '../components/ErrorFeed';

export function Overview() {
  const [cycle, setCycle] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [snapshotCount, setSnapshotCount] = useState(0);

  const fetchData = useCallback(() => {
    supabase
      .from('cycles')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => data?.[0] && setCycle(data[0]));

    supabase.rpc('get_open_positions').then(({ data }) => data && setPositions(data));

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    supabase
      .from('errors')
      .select('code, message, created_at')
      .gte('created_at', twoHoursAgo)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => data && setErrors(data));

    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    supabase
      .from('market_snapshots')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', oneHourAgo)
      .then(({ count }) => setSnapshotCount(count ?? 0));
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Realtime errors
  useEffect(() => {
    const channel = supabase
      .channel('errors-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'errors' },
        (payload) => setErrors((prev) => [payload.new as any, ...prev].slice(0, 20)),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const pnlColor =
    cycle?.session_pnl > 0 ? 'green' : cycle?.session_pnl < 0 ? 'red' : ('default' as const);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Overview</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Balance" value={`$${Number(cycle?.balance || 0).toFixed(2)}`} />
        <StatCard
          label="Session PnL"
          value={`$${Number(cycle?.session_pnl || 0).toFixed(2)}`}
          color={pnlColor}
        />
        <StatCard
          label="Regime"
          value={cycle?.regime || '\u2014'}
          subtitle={`F&G: ${cycle?.fear_greed_value ?? '\u2014'} | Layer: ${cycle?.layer ?? '\u2014'}`}
        />
        <StatCard
          label="Watchdog (1h)"
          value={snapshotCount}
          subtitle="market snapshots"
          color={snapshotCount > 50 ? 'green' : 'yellow'}
        />
      </div>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800">
        <div className="p-3 border-b border-zinc-800 text-sm font-semibold text-zinc-300">
          Open Positions
        </div>
        <PositionTable positions={positions} />
      </div>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800">
        <div className="p-3 border-b border-zinc-800 text-sm font-semibold text-zinc-300">
          Recent Errors (2h)
        </div>
        <ErrorFeed errors={errors} />
      </div>
    </div>
  );
}
