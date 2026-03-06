import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSupabaseQuery<T>(
  queryFn: () => Promise<{ data: T | null; error: any }>,
  deps: any[] = [],
): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    const { data, error } = await queryFn();
    setData(data);
    setError(error?.message ?? null);
    setLoading(false);
  }, deps);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch };
}

export { supabase };
