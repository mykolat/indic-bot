import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
  leverage?: number;
  close_pnl?: number;
  close_pnl_pct?: number;
  close_reason?: string;
  held_hours?: number;
  has_swarm?: boolean;
  fill_price?: number;
  fail_reason?: string;
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

const REGIME_COLORS: Record<string, string> = {
  BullTrend: 'bg-green-500/15 text-green-400 border-green-500/25',
  BearTrend: 'bg-red-500/15 text-red-400 border-red-500/25',
  Range: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/25',
  Breakout: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
  Capitulation: 'bg-red-500/20 text-red-300 border-red-500/30',
  Unknown: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25',
};

interface TimelineEvent {
  type: 'context' | 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

type FilterTab = 'all' | 'open' | 'won' | 'lost' | 'rejected';

export function Trades() {
  const navigate = useNavigate();
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
      const cycleIds = [...new Set(decs.map((d) => d.cycle_id))];

      const [risks, execs, swarms, errors] = await Promise.all([
        supabase.from('risk_validations').select('decision_id, passed, rejection_reason').in('decision_id', decIds),
        supabase.from('trade_executions').select('id, decision_id, leverage, fill_price').in('decision_id', decIds),
        supabase.from('llm_conversations').select('cycle_id').eq('method', 'swarm_consensus').in('cycle_id', cycleIds),
        supabase.from('errors').select('cycle_id, message').eq('code', 'ORDER_FAIL').in('cycle_id', cycleIds),
      ]);

      const execIds = (execs.data ?? []).map((e: any) => e.id);
      const { data: closes } = execIds.length
        ? await supabase.from('trade_closes').select('execution_id, pnl_usd, pnl_pct, exit_reason, held_hours').in('execution_id', execIds)
        : { data: [] };

      const riskMap = new Map((risks.data ?? []).map((r) => [r.decision_id, r]));
      const execMap = new Map((execs.data ?? []).map((e: any) => [e.decision_id, e]));
      const closeMap = new Map((closes ?? []).map((c: any) => [c.execution_id, c]));
      const swarmSet = new Set((swarms.data ?? []).map((s) => s.cycle_id));
      const errorMap = new Map((errors.data ?? []).map((e) => [e.cycle_id, e.message]));

      const enriched = decs.map((d) => {
        const risk = riskMap.get(d.id);
        const exec = execMap.get(d.id);
        const close = exec ? closeMap.get(exec.id) : undefined;
        return {
          ...d,
          risk_passed: risk?.passed,
          risk_reason: risk?.rejection_reason,
          executed: !!exec,
          leverage: exec?.leverage ? Number(exec.leverage) : undefined,
          close_pnl: close ? Number(close.pnl_usd) : undefined,
          close_pnl_pct: close?.pnl_pct != null ? Number(close.pnl_pct) : undefined,
          close_reason: close?.exit_reason,
          held_hours: close?.held_hours != null ? Number(close.held_hours) : undefined,
          has_swarm: swarmSet.has(d.cycle_id),
          fill_price: exec?.fill_price ? Number(exec.fill_price) : undefined,
          fail_reason: errorMap.get(d.cycle_id),
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
      const events: TimelineEvent[] = [];

      // Fetch cycle context + news
      const [cycleRes, newsRes, risk, exec, err] = await Promise.all([
        supabase.from('cycles').select('balance, session_pnl, volume_ratio, fear_greed_value, confluence_score, confluence_factors, regime, regime_confidence, layer, filter_warning, created_at').eq('id', decision.cycle_id).single(),
        supabase.from('news_analyses').select('overall_sentiment, risk_events, article_count').eq('cycle_id', decision.cycle_id).maybeSingle(),
        supabase.from('risk_validations').select('*').eq('decision_id', selectedId),
        supabase.from('trade_executions').select('*').eq('decision_id', selectedId),
        supabase.from('errors').select('*').eq('cycle_id', decision.cycle_id).eq('code', 'ORDER_FAIL'),
      ]);

      if (cycleRes.data) {
        const c = cycleRes.data;
        events.push({
          type: 'context',
          time: c.created_at,
          data: { ...c, news_sentiment: newsRes?.data?.overall_sentiment, news_risks: newsRes?.data?.risk_events, news_count: newsRes?.data?.article_count },
        });
      }

      events.push({ type: 'decision', time: decision.created_at, data: decision });
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

  const formatTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
    const dateGroups: Array<{ date: string; regimes: Array<{ regime: string; items: DecisionRow[] }> }> = [];
    let currentDate = '';
    for (const d of filtered) {
      const date = formatDate(d.created_at);
      if (date !== currentDate) {
        dateGroups.push({ date, regimes: [] });
        currentDate = date;
      }
      const dg = dateGroups[dateGroups.length - 1];
      const lastRegime = dg.regimes[dg.regimes.length - 1];
      if (lastRegime && lastRegime.regime === (d.regime || 'Unknown')) {
        lastRegime.items.push(d);
      } else {
        dg.regimes.push({ regime: d.regime || 'Unknown', items: [d] });
      }
    }
    return dateGroups;
  }, [filtered]);

  const selectedDecision = decisions.find(d => d.id === selectedId);

  const TABS: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'open', label: 'Open', count: stats.open },
    { key: 'won', label: 'Won', count: stats.wins },
    { key: 'lost', label: 'Lost', count: stats.losses },
    { key: 'rejected', label: 'Rejected', count: stats.rejected },
  ];

  return (
    <div className="space-y-4">
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
        <div className="w-[45%] overflow-y-auto pr-1 space-y-4">
          {grouped.map((group) => (
            <div key={group.date}>
              <div className="sticky top-0 z-10 bg-surface-0 pb-1 pt-1">
                <span className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold">{group.date}</span>
              </div>
              <div className="space-y-3">
                {group.regimes.map((rg, ri) => {
                  const rc = REGIME_COLORS[rg.regime] ?? REGIME_COLORS.Unknown;
                  return (
                    <div key={`${rg.regime}-${ri}`}>
                      {/* Regime bubble header */}
                      <div className="flex items-center gap-2 mb-1 pl-1">
                        <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full border ${rc}`}>
                          {rg.regime}
                        </span>
                        <span className="text-[10px] text-zinc-600 font-mono">{rg.items.length} trade{rg.items.length > 1 ? 's' : ''}</span>
                      </div>
                      {/* Trades in this regime */}
                      <div className="space-y-px border-l-2 border-border ml-2 pl-2">
                        {rg.items.map((d) => {
                          const status = getStatus(d);
                          const isSelected = selectedId === d.id;
                          const isLong = d.action === 'LONG';

                          return (
                            <button
                              key={d.id}
                              onClick={() => setSelectedId(d.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg transition-all ${
                                isSelected
                                  ? 'bg-surface-2 border border-border'
                                  : 'hover:bg-surface-1 border border-transparent'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className={`text-sm ${isLong ? 'text-green-400' : 'text-red-400'}`}>
                                    {isLong ? '\u2191' : '\u2193'}
                                  </span>
                                  <span className="text-[13px] font-mono font-medium text-zinc-300">{d.pair}</span>
                                  {d.leverage && (
                                    <span className="text-[10px] font-mono text-zinc-500">{d.leverage}x</span>
                                  )}
                                  {d.fill_price && (
                                    <span className="text-[10px] font-mono text-zinc-500">@${d.fill_price}</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {d.close_pnl !== undefined ? (
                                    <span className={`text-[12px] font-mono font-semibold ${d.close_pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                      {d.close_pnl > 0 ? '+' : ''}${d.close_pnl.toFixed(2)}
                                      {d.close_pnl_pct != null && (
                                        <span className="text-[10px] ml-1 opacity-60">{d.close_pnl_pct > 0 ? '+' : ''}{d.close_pnl_pct.toFixed(1)}%</span>
                                      )}
                                    </span>
                                  ) : (
                                    <span className={`text-[10px] font-mono px-1.5 py-px rounded border ${BADGE_STYLES[status]}`}>
                                      {STATUS_LABELS[status]}
                                    </span>
                                  )}
                                  <span className="text-[10px] text-zinc-500 font-mono">{formatTime(d.created_at)}</span>
                                </div>
                              </div>

                              <div className="flex items-center gap-3 mt-1 flex-wrap">
                                <span className="text-[10px] text-zinc-400 font-mono">
                                  <span className="text-zinc-600">conf</span> {d.confidence}%
                                </span>
                                {d.held_hours != null && (
                                  <span className="text-[10px] text-zinc-400 font-mono">
                                    <span className="text-zinc-600">hold</span> {d.held_hours.toFixed(1)}h
                                  </span>
                                )}
                                {d.has_swarm && (
                                  <span className="text-[10px] text-accent/70 font-mono">Swarm</span>
                                )}
                              </div>
                              {(d.risk_reason || d.fail_reason) && (
                                <div className="mt-1">
                                  <span className="text-[10px] text-red-400/80 truncate block" title={d.risk_reason || d.fail_reason}>
                                    {(d.risk_reason || d.fail_reason || '').slice(0, 60)}{(d.risk_reason || d.fail_reason || '').length > 60 ? '...' : ''}
                                  </span>
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-zinc-600 text-sm text-center py-8">No trades in this category</div>
          )}
        </div>

        <div className="flex-1 min-w-0">
          {selectedId && selectedDecision ? (
            <div className="bg-surface-1 rounded-xl border border-border h-full overflow-y-auto">
              <div className="p-4 border-b border-border flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Trade Lifecycle</h2>
                {selectedDecision.has_swarm && (
                  <button
                    onClick={() => navigate(`/swarm?cycle=${selectedDecision.cycle_id}`)}
                    className="text-[11px] text-accent hover:text-accent/80 font-mono transition-colors"
                  >
                    View Swarm Debate &rarr;
                  </button>
                )}
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
