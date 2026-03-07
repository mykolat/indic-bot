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
  strategy_type?: string;
}

type StatusBadge = 'RISK_REJECTED' | 'ORDER_FAIL' | 'OPEN' | 'TP' | 'SL' | 'MANUAL' | 'PENDING';

const BADGE_STYLES: Record<StatusBadge, string> = {
  RISK_REJECTED:  'bg-red-500/15 text-red-400 border-red-500/30',
  ORDER_FAIL:     'bg-red-500/15 text-red-400 border-red-500/30',
  OPEN:           'bg-blue-500/15 text-blue-400 border-blue-500/30',
  TP:             'bg-green-500/15 text-green-400 border-green-500/30',
  SL:             'bg-red-500/15 text-red-400 border-red-500/30',
  MANUAL:         'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  PENDING:        'bg-zinc-500/10 text-zinc-500 border-zinc-600/30',
};

const STATUS_LABELS: Record<StatusBadge, string> = {
  RISK_REJECTED: 'Rejected',
  ORDER_FAIL: 'Failed',
  OPEN: 'Open',
  TP: 'Take Profit',
  SL: 'Stop Loss',
  MANUAL: 'Closed',
  PENDING: 'Pending',
};

interface TimelineEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

type FilterTab = 'all' | 'open' | 'won' | 'lost' | 'rejected';

export function Trades() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');

  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase
        .from('trade_decisions')
        .select('id, pair, action, confidence, reasoning, regime, created_at, cycle_id')
        .in('action', ['LONG', 'SHORT'])
        .order('created_at', { ascending: false })
        .limit(100);
      if (!decs) return;

      const decIds = decs.map((d) => d.id);
      const [risks, execs] = await Promise.all([
        supabase.from('risk_validations').select('decision_id, passed, rejection_reason').in('decision_id', decIds),
        supabase.from('trade_executions').select('id, decision_id, strategy_type').in('decision_id', decIds),
      ]);

      const execIds = (execs.data ?? []).map((e) => e.id);
      const { data: closes } = execIds.length
        ? await supabase.from('trade_closes').select('execution_id, pnl_usd, exit_reason').in('execution_id', execIds)
        : { data: [] };

      const riskMap = new Map((risks.data ?? []).map((r) => [r.decision_id, r]));
      const execMap = new Map((execs.data ?? []).map((e: any) => [e.decision_id, e]));
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
          strategy_type: (exec as any)?.strategy_type,
        };
      });

      setDecisions(enriched);
    };
    load();
  }, []);

  const getStatus = (d: DecisionRow): StatusBadge => {
    if (d.risk_passed === false) return 'RISK_REJECTED';
    if (!d.executed && d.risk_passed) return 'ORDER_FAIL';
    if (!d.executed) return 'PENDING';
    if (d.close_reason === 'TP') return 'TP';
    if (d.close_reason === 'SL') return 'SL';
    if (d.close_reason) return 'MANUAL';
    return 'OPEN';
  };

  const filtered = useMemo(() => {
    return decisions.filter((d) => {
      const status = getStatus(d);
      switch (activeTab) {
        case 'open': return status === 'OPEN';
        case 'won': return status === 'TP' || (status === 'MANUAL' && (d.close_pnl ?? 0) > 0);
        case 'lost': return status === 'SL' || (status === 'MANUAL' && (d.close_pnl ?? 0) < 0);
        case 'rejected': return status === 'RISK_REJECTED' || status === 'ORDER_FAIL';
        default: return true;
      }
    });
  }, [decisions, activeTab]);

  // Stats
  const stats = useMemo(() => {
    const wins = decisions.filter(d => { const s = getStatus(d); return s === 'TP' || (s === 'MANUAL' && (d.close_pnl ?? 0) > 0); }).length;
    const losses = decisions.filter(d => { const s = getStatus(d); return s === 'SL' || (s === 'MANUAL' && (d.close_pnl ?? 0) < 0); }).length;
    const totalPnl = decisions.reduce((sum, d) => sum + (d.close_pnl ?? 0), 0);
    const open = decisions.filter(d => getStatus(d) === 'OPEN').length;
    const rejected = decisions.filter(d => { const s = getStatus(d); return s === 'RISK_REJECTED' || s === 'ORDER_FAIL'; }).length;
    return { wins, losses, totalPnl, open, rejected, total: decisions.length };
  }, [decisions]);

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

  const TABS: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'open', label: 'Open', count: stats.open },
    { key: 'won', label: 'Won', count: stats.wins },
    { key: 'lost', label: 'Lost', count: stats.losses },
    { key: 'rejected', label: 'Rejected', count: stats.rejected },
  ];

  return (
    <div className="space-y-4">
      {/* Header with summary stats */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-200">Trades</h1>
        <div className="flex items-center gap-4">
          <span className={`text-sm font-mono font-semibold ${stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
          </span>
          <span className="text-xs text-zinc-600 font-mono">
            {stats.wins}W / {stats.losses}L
          </span>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-surface-1 rounded-lg p-1 w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === tab.key
                ? 'bg-surface-3 text-zinc-200 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-400'
            }`}
          >
            {tab.label}
            {tab.count > 0 && (
              <span className={`ml-1.5 text-[10px] font-mono ${activeTab === tab.key ? 'text-zinc-400' : 'text-zinc-600'}`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex gap-5 h-[calc(100vh-15rem)]">
        {/* Left: Trade list */}
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
                  const isLong = d.action === 'LONG';

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
                          {/* Direction arrow */}
                          <span className={`text-sm ${isLong ? 'text-green-400' : 'text-red-400'}`}>
                            {isLong ? '\u2191' : '\u2193'}
                          </span>
                          <span className="text-[13px] font-mono font-medium text-zinc-300">{d.pair}</span>
                          {d.strategy_type === 'scalping' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-mono">SCALP</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {d.close_pnl !== undefined ? (
                            <span className={`text-[12px] font-mono font-semibold ${d.close_pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {d.close_pnl > 0 ? '+' : ''}${d.close_pnl.toFixed(2)}
                            </span>
                          ) : (
                            <span className={`text-[10px] font-mono px-1.5 py-px rounded border ${BADGE_STYLES[status]}`}>
                              {STATUS_LABELS[status]}
                            </span>
                          )}
                          <span className="text-[10px] text-zinc-600 font-mono">{formatTime(d.created_at)}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] text-zinc-600 font-mono">{d.confidence}%</span>
                        <span className="text-[10px] text-zinc-700">{d.regime}</span>
                        {d.risk_reason && (
                          <span className="text-[10px] text-red-400/70 truncate">{d.risk_reason}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-zinc-600 text-sm text-center py-8">No trades in this category</div>
          )}
        </div>

        {/* Right: Detail panel */}
        <div className="flex-1 min-w-0">
          {selectedId ? (
            <div className="bg-surface-1 rounded-xl border border-border h-full overflow-y-auto">
              <div className="p-4 border-b border-border">
                <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Trade Lifecycle</h2>
              </div>
              <div className="p-4">
                <TradeTimeline events={timeline} />
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-zinc-600 text-sm">Select a trade to see its lifecycle</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
