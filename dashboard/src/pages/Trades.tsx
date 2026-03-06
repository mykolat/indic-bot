import { useEffect, useState } from 'react';
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
}

interface TimelineEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

export function Trades() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);

  useEffect(() => {
    supabase
      .from('trade_decisions')
      .select('id, pair, action, confidence, reasoning, regime, created_at, cycle_id')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => data && setDecisions(data));
  }, []);

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
        supabase
          .from('errors')
          .select('*')
          .eq('cycle_id', decision.cycle_id)
          .eq('code', 'ORDER_FAIL'),
      ]);

      risk.data?.forEach((r) => events.push({ type: 'risk', time: r.created_at, data: r }));
      err.data?.forEach((e) => events.push({ type: 'error', time: e.created_at, data: e }));

      for (const ex of exec.data || []) {
        events.push({ type: 'execution', time: ex.opened_at, data: ex });
        const { data: closes } = await supabase
          .from('trade_closes')
          .select('*')
          .eq('execution_id', ex.id);
        closes?.forEach((c) => events.push({ type: 'close', time: c.closed_at, data: c }));
      }

      setTimeline(events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()));
    };

    loadTimeline();
  }, [selectedId, decisions]);

  return (
    <div className="flex gap-6">
      <div className="w-1/3 space-y-1 max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-3">Trade Decisions</h2>
        {decisions.map((d) => (
          <button
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            className={`w-full text-left p-2 rounded text-sm ${
              selectedId === d.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
            }`}
          >
            <div className="flex justify-between">
              <span className="font-mono">{d.pair}</span>
              <span
                className={
                  d.action === 'HOLD'
                    ? 'text-zinc-500'
                    : d.action === 'CLOSE'
                      ? 'text-purple-400'
                      : 'text-blue-400'
                }
              >
                {d.action}
              </span>
            </div>
            <div className="text-zinc-500 text-xs">
              {new Date(d.created_at).toLocaleString()} | conf:{d.confidence} | {d.regime}
            </div>
          </button>
        ))}
      </div>

      <div className="flex-1">
        <h2 className="text-lg font-bold mb-3">Lifecycle</h2>
        {selectedId ? (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <TradeTimeline events={timeline} />
          </div>
        ) : (
          <div className="text-zinc-500">Select a decision to see its lifecycle</div>
        )}
      </div>
    </div>
  );
}
