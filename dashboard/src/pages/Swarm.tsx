import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface SwarmCycle {
  cycle_id: number;
  created_at: string;
  personas: Array<{
    persona: string;
    vote: string | null;
    confidence: number | null;
    reasoning: string;
  }>;
  judge_response?: string;
}

const personaColors: Record<string, string> = {
  risk_manager: '#eab308',
  bull_thesis: '#4ade80',
  bear_thesis: '#f87171',
  market_structure: '#60a5fa',
  devils_advocate: '#a78bfa',
  narrative_expert: '#fb923c',
};

const voteColors: Record<string, string> = {
  LONG: '#4ade80', SHORT: '#f87171', HOLD: '#71717a',
};

export function Swarm() {
  const [cycles, setCycles] = useState<SwarmCycle[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    const load = async () => {
      const { data: judges } = await supabase
        .from('llm_conversations')
        .select('cycle_id, raw_response, created_at')
        .eq('method', 'swarm_consensus')
        .order('created_at', { ascending: false })
        .limit(20);
      if (!judges?.length) return;

      const result: SwarmCycle[] = [];
      for (const j of judges) {
        const windowStart = new Date(new Date(j.created_at).getTime() - 600_000).toISOString();
        const windowEnd = new Date(new Date(j.created_at).getTime() + 600_000).toISOString();
        const { data: personas } = await supabase
          .from('swarm_personas')
          .select('persona, vote, confidence, reasoning')
          .gte('created_at', windowStart)
          .lte('created_at', windowEnd)
          .order('created_at', { ascending: true });
        result.push({
          cycle_id: j.cycle_id,
          created_at: j.created_at,
          personas: personas || [],
          judge_response: j.raw_response,
        });
      }
      setCycles(result);
    };
    load();
  }, []);

  const current = cycles[selectedIdx];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Swarm Debate</h1>
        {cycles.length > 0 && (
          <select
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
          >
            {cycles.map((c, i) => (
              <option key={i} value={i}>
                Cycle {c.cycle_id} — {new Date(c.created_at).toLocaleString()} ({c.personas.length} experts)
              </option>
            ))}
          </select>
        )}
      </div>

      {current ? (
        <>
          {current.personas.length > 0 && (
            <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300 mb-2">Expert Votes</h3>
              {current.personas.map((p, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-36 text-xs text-right shrink-0 truncate"
                    style={{ color: personaColors[p.persona] ?? '#a1a1aa' }}>
                    {p.persona.replace(/_/g, ' ').toUpperCase()}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-5 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className="h-full rounded transition-all"
                        style={{
                          width: `${p.confidence ?? 0}%`,
                          backgroundColor: voteColors[p.vote ?? 'HOLD'] ?? '#71717a',
                        }}
                      />
                    </div>
                    <span className="text-xs font-mono w-8 text-right text-zinc-400">{p.confidence ?? 0}%</span>
                    <span className="text-xs w-12" style={{ color: voteColors[p.vote ?? 'HOLD'] }}>
                      {p.vote ?? '—'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {current.personas.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {current.personas.map((p, i) => (
                <div key={i} className="bg-zinc-900 rounded-lg border-l-4 p-4"
                  style={{ borderColor: personaColors[p.persona] ?? '#3f3f46' }}>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">{p.persona.replace(/_/g, ' ').toUpperCase()}</span>
                    <div className="flex gap-2 text-xs">
                      {p.vote && (
                        <span style={{ color: voteColors[p.vote] ?? '#a1a1aa' }}>{p.vote}</span>
                      )}
                      {p.confidence !== null && <span className="text-zinc-500">conf: {p.confidence}</span>}
                    </div>
                  </div>
                  <p className="text-zinc-400 text-xs leading-relaxed">{p.reasoning}</p>
                </div>
              ))}
            </div>
          )}

          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <h3 className="text-sm font-semibold mb-2 text-zinc-300">Judge Consensus</h3>
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap max-h-64 overflow-y-auto">
              {current.judge_response}
            </pre>
          </div>
        </>
      ) : (
        <div className="text-zinc-500">No swarm debates found</div>
      )}
    </div>
  );
}
