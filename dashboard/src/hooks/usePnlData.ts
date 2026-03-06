import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';

interface TradeClose {
  pnl_usd: number;
  pnl_pct: number;
  closed_at: string;
}

interface DailyPnl { date: string; pnl: number; }

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export function usePnlData(range: '7D' | '1M' | '3M' | 'ALL') {
  const [closes, setCloses] = useState<TradeClose[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      let query = supabase
        .from('trade_closes')
        .select('pnl_usd, pnl_pct, closed_at')
        .order('closed_at', { ascending: true });

      if (range !== 'ALL') {
        const days = range === '7D' ? 7 : range === '1M' ? 30 : 90;
        query = query.gte('closed_at', daysAgo(days));
      }

      const { data } = await query;
      setCloses(data ?? []);
      setLoading(false);
    };
    load();
  }, [range]);

  const dailyPnl: DailyPnl[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of closes) {
      const date = c.closed_at.slice(0, 10);
      map.set(date, (map.get(date) ?? 0) + Number(c.pnl_usd));
    }
    return Array.from(map, ([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }));
  }, [closes]);

  const cumulative = useMemo(() => {
    let sum = 0;
    return closes.map((c) => {
      sum += Number(c.pnl_usd);
      return { date: c.closed_at.slice(0, 10), cumPnl: Math.round(sum * 100) / 100 };
    });
  }, [closes]);

  const totalProfit = useMemo(
    () => closes.filter((c) => Number(c.pnl_usd) > 0).reduce((s, c) => s + Number(c.pnl_usd), 0),
    [closes],
  );
  const totalLoss = useMemo(
    () => closes.filter((c) => Number(c.pnl_usd) < 0).reduce((s, c) => s + Number(c.pnl_usd), 0),
    [closes],
  );

  const todayPnl = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return closes
      .filter((c) => c.closed_at.startsWith(today))
      .reduce((s, c) => s + Number(c.pnl_usd), 0);
  }, [closes]);

  const periodPnl = (days: number) =>
    closes
      .filter((c) => new Date(c.closed_at).getTime() > Date.now() - days * 86400_000)
      .reduce((s, c) => s + Number(c.pnl_usd), 0);

  return {
    loading,
    dailyPnl,
    cumulative,
    totalProfit,
    totalLoss,
    todayPnl,
    weekPnl: periodPnl(7),
    monthPnl: periodPnl(30),
    allTimePnl: closes.reduce((s, c) => s + Number(c.pnl_usd), 0),
  };
}
