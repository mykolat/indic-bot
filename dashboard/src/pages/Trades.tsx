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
  risk_passed?: boolean;
  risk_reason?: string;
  executed?: boolean;
  close_pnl?: number;
  close_reason?: string;
}

type StatusBadge = 'PREFLIGHT_FAIL' | 'RISK_REJECTED' | 'ORDER_FAIL' | 'OPEN' | 'TP' | 'SL' | 'MANUAL' | 'PENDING';

const BADGE_STYLES: Record<StatusBadge, string> = {
  PREFLIGHT_FAIL: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  RISK_REJECTED:  'bg-red-500/15 text-red-400 border-red-500/30',
  ORDER_FAIL:     'bg-red-500/15 text-red-400 border-red-500/30',
  OPEN:           'bg-blue-500/15 text-blue-400 border-blue-500/30',
  TP:             'bg-green-500/15 text-green-400 border-green-500/30',
  SL:             'bg-red-500/15 text-red-400 border-red-500/30',
  MANUAL:         'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  PENDING:        'bg-zinc-500/10 text-zinc-500 border-zinc-600/30',
};

const ACTION_COLORS: Record<string, string> = {
  LONG: '#4ade80',
  SHORT: '#f87171',
  HOLD: '#71717a',
  CLOSE: '#a78bfa',
  ADJUST: '#fb923c',
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
  const actions = useMemo(() => [...new Set(decisions.map((d) => d.action))].sort(), [decisions]);
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

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Group decisions by date
  const grouped = useMemo(() => {
    const groups: Array<{ date: string; items: DecisionRow[] }> = [];
    let currentDate = '';
    for (const d of filtered) {
      const date = formatDate(d.created_at);
      if (date !== currentDate) {
        groups.push({ date, items: [] });
        currentDate = date;
      }
      groups[groups.length - 1].items.push(d);
    }
    return groups;
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-200">Trade Decisions</h1>
        <span className="text-xs text-zinc-600 font-mono">{filtered.length} decisions</span>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <select value={filterPair} onChange={(e) => setFilterPair(e.target.value)}
          className="bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-300 focus:outline-none focus:border-accent/40">
          <option value="">All Pairs</option>
          {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
          className="bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-300 focus:outline-none focus:border-accent/40">
          <option value="">All Actions</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <div className="flex gap-5 h-[calc(100vh-14rem)]">
        {/* Left: Decision list */}
        <div className="w-[45%] overflow-y-auto pr-1 space-y-4">
          {grouped.map((group) => (
            <div key={group.date}>
              <div className="sticky top-0 z-10 bg-surface-0 pb-1 pt-1">
                <span className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold">{group.date}</span>
              </div>
              <div className="space-y-px">
                {group.items.map((d) => {
                  const status = getStatus(d);
                  const isSelected = selectedId === d.id;
                  const actionColor = ACTION_COLORS[d.action] ?? '#a1a1aa';

                  return (
                    <button
                      key={d.id}
                      onClick={() => setSelectedId(d.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all ${
                        isSelected
                          ? 'bg-surface-2 border border-border'
                          : 'hover:bg-surface-1 border border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[13px] font-mono font-medium text-zinc-300">{d.pair}</span>
                          <span className="text-[11px] font-mono font-bold" style={{ color: actionColor }}>
                            {d.action}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-[10px] font-mono px-1.5 py-px rounded border ${BADGE_STYLES[status]}`}>
                            {status}
                          </span>
                          <span className="text-[10px] text-zinc-600 font-mono">{formatTime(d.created_at)}</span>
                        </div>
                      </div>

                      {/* Second row: confidence + regime + pnl */}
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] text-zinc-600 font-mono">conf:{d.confidence}</span>
                        <span className="text-[10px] text-zinc-700">{d.regime}</span>
                        {d.close_pnl !== undefined && (
                          <span className={`text-[10px] font-mono font-semibold ${d.close_pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {d.close_pnl > 0 ? '+' : ''}${d.close_pnl.toFixed(2)}
                          </span>
                        )}
                      </div>

                      {/* Reasoning preview */}
                      {d.reasoning && (
                        <p className="text-[11px] text-zinc-600 mt-1 line-clamp-1">
                          {d.reasoning}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-zinc-600 text-sm text-center py-8">No decisions match filters</div>
          )}
        </div>

        {/* Right: Detail panel */}
        <div className="flex-1 min-w-0">
          {selectedId ? (
            <div className="bg-surface-1 rounded-xl border border-border h-full overflow-y-auto">
              <div className="p-4 border-b border-border">
                <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Decision Lifecycle</h2>
              </div>
              <div className="p-4">
                <TradeTimeline events={timeline} />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-zinc-600 text-sm">Select a decision to see its lifecycle</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
