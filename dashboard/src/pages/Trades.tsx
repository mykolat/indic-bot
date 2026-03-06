import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { TradeTimeline } from '../components/TradeTimeline';

interface DecisionRow {
  id: number;
  pair: string;
  action: string;
  confidence: number;
  reasoning: string;
  regime: string;
  created_at: string;
  cycle_id: number;
  // joined
  risk_passed?: boolean;
  risk_reason?: string;
  executed?: boolean;
  close_pnl?: number;
  close_reason?: string;
}

type StatusBadge = 'PREFLIGHT_FAIL' | 'RISK_REJECTED' | 'ORDER_FAIL' | 'OPEN' | 'TP' | 'SL' | 'MANUAL' | 'PENDING';

const badgeColors: Record<StatusBadge, string> = {
  PREFLIGHT_FAIL: 'bg-orange-900 text-orange-300',
  RISK_REJECTED: 'bg-red-900 text-red-300',
  ORDER_FAIL: 'bg-red-900 text-red-300',
  OPEN: 'bg-blue-900 text-blue-300',
  TP: 'bg-green-900 text-green-300',
  SL: 'bg-red-900 text-red-300',
  MANUAL: 'bg-zinc-700 text-zinc-300',
  PENDING: 'bg-zinc-800 text-zinc-400',
};

interface TimelineEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

export function Trades() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [filterPair, setFilterPair] = useState('');
  const [filterAction, setFilterAction] = useState('');

  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase
        .from('trade_decisions')
        .select('id, pair, action, confidence, reasoning, regime, created_at, cycle_id')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!decs) return;

      const decIds = decs.map((d) => d.id);
      const [risks, execs] = await Promise.all([
        supabase.from('risk_validations').select('decision_id, passed, rejection_reason').in('decision_id', decIds),
        supabase.from('trade_executions').select('id, decision_id').in('decision_id', decIds),
      ]);

      const execIds = (execs.data ?? []).map((e) => e.id);
      const { data: closes } = execIds.length
        ? await supabase.from('trade_closes').select('execution_id, pnl_usd, exit_reason').in('execution_id', execIds)
        : { data: [] };

      const riskMap = new Map((risks.data ?? []).map((r) => [r.decision_id, r]));
      const execMap = new Map((execs.data ?? []).map((e) => [e.decision_id, e]));
      const closeMap = new Map((closes ?? []).map((c) => [c.execution_id, c]));

      const enriched = decs.map((d) => {
        const risk = riskMap.get(d.id);
        const exec = execMap.get(d.id);
        const close = exec ? closeMap.get(exec.id) : undefined;
        return {
          ...d,
          risk_passed: risk?.passed,
          risk_reason: risk?.rejection_reason,
          executed: !!exec,
          close_pnl: close ? Number(close.pnl_usd) : undefined,
          close_reason: close?.exit_reason,
        };
      });

      setDecisions(enriched);
    };
    load();
  }, []);

  const getStatus = (d: DecisionRow): StatusBadge => {
    if (d.action === 'HOLD' || d.action === 'ADJUST' || d.action === 'CLOSE') return 'PENDING';
    if (d.risk_passed === false) return 'RISK_REJECTED';
    if (!d.executed && d.risk_passed) return 'ORDER_FAIL';
    if (!d.executed) return 'PENDING';
    if (d.close_reason === 'TP') return 'TP';
    if (d.close_reason === 'SL') return 'SL';
    if (d.close_reason) return 'MANUAL';
    return 'OPEN';
  };

  const pairs = useMemo(() => [...new Set(decisions.map((d) => d.pair))], [decisions]);
  const filtered = useMemo(() => {
    return decisions.filter((d) => {
      if (filterPair && d.pair !== filterPair) return false;
      if (filterAction && d.action !== filterAction) return false;
      return true;
    });
  }, [decisions, filterPair, filterAction]);

  useEffect(() => {
    if (!selectedId) return;
    const decision = decisions.find((d) => d.id === selectedId);
    if (!decision) return;

    const loadTimeline = async () => {
      const events: TimelineEvent[] = [
        { type: 'decision', time: decision.created_at, data: decision },
      ];
      const [risk, exec, err] = await Promise.all([
        supabase.from('risk_validations').select('*').eq('decision_id', selectedId),
        supabase.from('trade_executions').select('*').eq('decision_id', selectedId),
        supabase.from('errors').select('*').eq('cycle_id', decision.cycle_id).eq('code', 'ORDER_FAIL'),
      ]);
      risk.data?.forEach((r) => events.push({ type: 'risk', time: r.created_at, data: r }));
      err.data?.forEach((e) => events.push({ type: 'error', time: e.created_at, data: e }));
      for (const ex of exec.data || []) {
        events.push({ type: 'execution', time: ex.opened_at, data: ex });
        const { data: closes } = await supabase.from('trade_closes').select('*').eq('execution_id', ex.id);
        closes?.forEach((c) => events.push({ type: 'close', time: c.closed_at, data: c }));
      }
      setTimeline(events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()));
    };
    loadTimeline();
  }, [selectedId, decisions]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Trade Decisions</h1>

      <div className="flex gap-3 text-sm">
        <select value={filterPair} onChange={(e) => setFilterPair(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1">
          <option value="">All Pairs</option>
          {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1">
          <option value="">All Actions</option>
          {['LONG', 'SHORT', 'CLOSE', 'HOLD', 'ADJUST'].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="text-zinc-500 self-center">{filtered.length} decisions</span>
      </div>

      <div className="flex gap-6">
        <div className="w-2/5 space-y-1 max-h-[75vh] overflow-y-auto">
          {filtered.map((d) => {
            const status = getStatus(d);
            return (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`w-full text-left p-3 rounded text-sm ${
                  selectedId === d.id ? 'bg-zinc-800 border border-zinc-700' : 'hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="font-mono">{d.pair}</span>
                  <div className="flex gap-2 items-center">
                    <span className={`text-xs px-2 py-0.5 rounded ${badgeColors[status]}`}>{status}</span>
                    <span className={
                      d.action === 'HOLD' ? 'text-zinc-500' :
                      d.action === 'CLOSE' ? 'text-purple-400' :
                      d.action === 'SHORT' ? 'text-red-400' : 'text-green-400'
                    }>{d.action}</span>
                  </div>
                </div>
                <div className="text-zinc-500 text-xs mt-1">
                  {new Date(d.created_at).toLocaleString()} | conf:{d.confidence} | {d.regime}
                  {d.close_pnl !== undefined && (
                    <span className={d.close_pnl > 0 ? ' text-green-400' : ' text-red-400'}>
                      {' '}| ${d.close_pnl.toFixed(2)}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex-1">
          <h2 className="text-lg font-bold mb-3">Decision Lifecycle</h2>
          {selectedId ? (
            <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
              <TradeTimeline events={timeline} />
            </div>
          ) : (
            <div className="text-zinc-500 text-sm">Select a decision to see its full lifecycle funnel</div>
          )}
        </div>
      </div>
    </div>
  );
}
