import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';

interface CycleBalance {
  balance: number;
  created_at: string;
}

export function useBalanceHistory() {
  const [raw, setRaw] = useState<CycleBalance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('cycles')
      .select('balance, created_at')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setRaw(data ?? []);
        setLoading(false);
      });
  }, []);

  const data = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of raw) {
      map.set(c.created_at.slice(0, 10), Number(c.balance));
    }
    return Array.from(map, ([date, balance]) => ({ date, balance }));
  }, [raw]);

  return { data, loading };
}
