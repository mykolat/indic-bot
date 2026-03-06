import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { PersonaCard } from '../components/PersonaCard';

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
        // Personas may be written BEFORE or AFTER judge — search +/- 10min window
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
                Cycle {c.cycle_id} &mdash; {new Date(c.created_at).toLocaleString()}
                {c.personas.length > 0 ? ` (${c.personas.length} experts)` : ' (no experts)'}
              </option>
            ))}
          </select>
        )}
      </div>

      {current ? (
        <>
          {current.personas.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {current.personas.map((p, i) => (
                <PersonaCard key={i} {...p} />
              ))}
            </div>
          ) : (
            <div className="text-zinc-500 text-sm">
              No parsed expert responses for this cycle (experts may have failed to parse)
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
