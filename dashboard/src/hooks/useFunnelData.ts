import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface FunnelData {
  totalCycles: number;
  totalDecisions: number;
  preflightRejected: number;
  riskPassed: number;
  riskRejected: number;
  executed: number;
  orderFailed: number;
  closedTp: number;
  closedSl: number;
  closedManual: number;
  rejectionReasons: { reason: string; count: number }[];
}

export function useFunnelData() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const [cycles, decisions, riskVals, executions, closes, preflightErrors, orderErrors] =
        await Promise.all([
          supabase.from('cycles').select('id', { count: 'exact', head: true }),
          supabase.from('trade_decisions').select('id, action'),
          supabase.from('risk_validations').select('passed, rejection_reason'),
          supabase.from('trade_executions').select('id'),
          supabase.from('trade_closes').select('exit_reason'),
          supabase.from('errors').select('id').eq('code', 'LLM_PREFLIGHT_WARNING'),
          supabase.from('errors').select('id').eq('code', 'ORDER_FAIL'),
        ]);

      const tradeDecisions = (decisions.data ?? []).filter(
        (d) => d.action === 'LONG' || d.action === 'SHORT',
      );

      const riskArr = riskVals.data ?? [];
      const riskPassed = riskArr.filter((r) => r.passed).length;
      const riskRejected = riskArr.filter((r) => !r.passed).length;

      const reasonMap = new Map<string, number>();
      riskArr.filter((r) => !r.passed).forEach((r) => {
        const reason = r.rejection_reason || 'unknown';
        reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
      });
      const preflightCount = preflightErrors.data?.length ?? 0;
      if (preflightCount > 0) reasonMap.set('preflight_filter', preflightCount);
      const orderFailCount = orderErrors.data?.length ?? 0;
      if (orderFailCount > 0) reasonMap.set('order_fail', orderFailCount);

      const closesArr = closes.data ?? [];

      setData({
        totalCycles: cycles.count ?? 0,
        totalDecisions: tradeDecisions.length,
        preflightRejected: preflightCount,
        riskPassed,
        riskRejected,
        executed: executions.data?.length ?? 0,
        orderFailed: orderFailCount,
        closedTp: closesArr.filter((c) => c.exit_reason === 'TP').length,
        closedSl: closesArr.filter((c) => c.exit_reason === 'SL').length,
        closedManual: closesArr.filter((c) => c.exit_reason !== 'TP' && c.exit_reason !== 'SL').length,
        rejectionReasons: Array.from(reasonMap, ([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      });
      setLoading(false);
    };
    load();
  }, []);

  return { data, loading };
}
