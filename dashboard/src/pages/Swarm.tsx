import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { DebateSidebar } from '../components/swarm/DebateSidebar';
import { InputContextCard } from '../components/swarm/InputContextCard';
import { RoundSection } from '../components/swarm/RoundSection';

interface SwarmMessage {
  persona: string;
  content: string;
  vote?: string | null;
  confidence?: number | null;
  probability?: number | null;
  time: string;
  isJudge?: boolean;
  isSuperuser?: boolean;
  phase?: number;
  conflictsWith?: Record<string, string> | null;
}

interface DebateData {
  cycleId: number;
  createdAt: string;
  votes: Array<{ persona: string; vote: string | null }>;
  summary: string;
  messages: SwarmMessage[];
  userPrompt: string;
  blackboardStates: Array<{ phase: number; state: any }>;
  conflicts: Array<{ personaA: string; personaB: string; topic: string; severity: string; phase: number }>;
}

function extractSummary(judgeResponse?: string): string {
  if (!judgeResponse) return 'No verdict';
  try {
    const parsed = JSON.parse(judgeResponse);
    if (parsed.decisions?.[0]) {
      const d = parsed.decisions[0];
      return `${d.action} ${d.pair ?? ''} conf:${d.confidence ?? '?'}`;
    }
    if (parsed.verdict) return parsed.verdict.slice(0, 60);
  } catch { /* not JSON */ }
  return judgeResponse.slice(0, 60).replace(/\n/g, ' ') + '\u2026';
}

function formatDebateForCopy(d: DebateData): string {
  const lines: string[] = [];
  lines.push(`=== Swarm Debate \u2014 Cycle ${d.cycleId} ===`);
  lines.push(`Date: ${new Date(d.createdAt).toLocaleString()}`);
  lines.push('');
  if (d.userPrompt) {
    lines.push('--- INPUT CONTEXT ---');
    lines.push(d.userPrompt);
    lines.push('');
  }
  const byRound = new Map<number, SwarmMessage[]>();
  for (const m of d.messages) {
    const r = m.phase ?? 1;
    const arr = byRound.get(r) ?? [];
    arr.push(m);
    byRound.set(r, arr);
  }
  for (const [round, msgs] of byRound) {
    lines.push(`--- ROUND ${round} ---`);
    for (const m of msgs) {
      const header = m.isJudge ? 'JUDGE' : m.persona.toUpperCase();
      const vote = m.vote ? ` [${m.vote}]` : '';
      const conf = m.confidence != null ? ` conf:${m.confidence}` : '';
      lines.push(`${header}${vote}${conf}`);
      lines.push(m.content);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function CopyButton({ debate }: { debate: DebateData }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(formatDebateForCopy(debate)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button onClick={handleCopy} className="text-xs px-3 py-1.5 rounded-lg border border-border text-zinc-400 hover:text-white hover:border-accent/40 transition-colors font-mono">
      {copied ? 'Copied!' : 'Copy All'}
    </button>
  );
}

export function Swarm() {
  const [debates, setDebates] = useState<DebateData[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [superInput, setSuperInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const { data: judges } = await supabase
        .from('llm_conversations')
        .select('cycle_id, raw_response, created_at, label')
        .eq('method', 'swarm_consensus')
        .order('created_at', { ascending: false })
        .limit(30);
      if (!judges?.length) return;

      const seenCycles = new Set<number>();
      const topJudges = judges.filter(j => {
        if (seenCycles.has(j.cycle_id)) return false;
        seenCycles.add(j.cycle_id);
        return true;
      });

      const result: DebateData[] = [];
      for (const j of topJudges) {
        const windowStart = new Date(new Date(j.created_at).getTime() - 1_800_000).toISOString();
        const windowEnd = new Date(new Date(j.created_at).getTime() + 60_000).toISOString();

        const [personasRes, judgeConvsRes] = await Promise.all([
          supabase
            .from('swarm_personas')
            .select('persona, vote, confidence, reasoning, created_at, phase, reply_to_id, conflicts_with, signals')
            .gte('created_at', windowStart)
            .lte('created_at', windowEnd)
            .order('created_at', { ascending: true }),
          supabase
            .from('llm_conversations')
            .select('raw_response, created_at, label, blackboard_state, user_prompt')
            .eq('cycle_id', j.cycle_id)
            .eq('method', 'swarm_consensus')
            .order('created_at', { ascending: true }),
        ]);

        const personaList = personasRes.data || [];
        const judgeConvs = judgeConvsRes.data || [];

        const judgeByLevel = new Map<number, typeof judgeConvs>();
        for (const jc of judgeConvs) {
          const levelMatch = jc.label?.match(/judge_(?:level|round)_(\d+)/);
          const level = levelMatch ? parseInt(levelMatch[1]) : 1;
          const arr = judgeByLevel.get(level) ?? [];
          arr.push(jc);
          judgeByLevel.set(level, arr);
        }
        if (!judgeByLevel.has(1) && judgeConvs.length > 0) {
          judgeByLevel.set(1, judgeConvs);
        }

        const maxPhase = Math.max(...personaList.map(p => p.phase ?? 1), 1);
        const messages: SwarmMessage[] = [];

        for (let phase = 1; phase <= maxPhase; phase++) {
          const phasePersonas = personaList.filter(p => (p.phase ?? 1) === phase);
          for (const p of phasePersonas) {
            if (p.persona === 'superuser') {
              messages.push({
                persona: 'superuser', content: p.reasoning || '(no message)',
                time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isSuperuser: true, phase,
              });
            } else {
              messages.push({
                persona: p.persona, content: p.reasoning || '(no reasoning)',
                vote: p.vote, confidence: p.confidence,
                time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                phase, conflictsWith: p.conflicts_with as Record<string, string> | null,
              });
            }
          }
          for (const jc of judgeByLevel.get(phase) ?? []) {
            messages.push({
              persona: 'judge', content: jc.raw_response || '(no verdict)',
              time: new Date(jc.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isJudge: true, phase,
            });
          }
        }

        const blackboardStates: DebateData['blackboardStates'] = [];
        for (const [level, convs] of judgeByLevel) {
          for (const jc of convs) {
            if ((jc as any).blackboard_state) {
              blackboardStates.push({ phase: level, state: (jc as any).blackboard_state });
            }
          }
        }

        result.push({
          cycleId: j.cycle_id,
          createdAt: j.created_at,
          votes: personaList.filter(p => p.persona !== 'superuser').map(p => ({ persona: p.persona, vote: p.vote })),
          summary: extractSummary(j.raw_response),
          messages,
          userPrompt: (judgeConvs[0] as any)?.user_prompt ?? '',
          blackboardStates,
          conflicts: [],
        });
      }
      setDebates(result);
    };
    load();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [selectedIdx]);

  const current = debates[selectedIdx];

  const sendSuperuserMessage = async () => {
    if (!superInput.trim() || !current || sending) return;
    setSending(true);
    try {
      const webhookUrl = (import.meta as any).env?.VITE_WEBHOOK_URL || 'http://localhost:3000';
      await fetch(`${webhookUrl}/api/swarm/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle_id: current.cycleId, message: superInput.trim() }),
      });
      const now = new Date();
      const newMsg: SwarmMessage = {
        persona: 'superuser', content: superInput.trim(),
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSuperuser: true, phase: Math.max(...current.messages.map(m => m.phase ?? 1), 1),
      };
      setDebates(prev => prev.map((d, i) => i === selectedIdx ? { ...d, messages: [...d.messages, newMsg] } : d));
      setSuperInput('');
    } catch (err) {
      console.error('Failed to inject superuser message:', err);
    }
    setSending(false);
  };

  // Group messages by round for RoundSection
  const getRounds = () => {
    if (!current) return [];
    const roundMap = new Map<number, { personas: SwarmMessage[]; judgeRaw?: string }>();
    for (const m of current.messages) {
      const r = m.phase ?? 1;
      const entry = roundMap.get(r) ?? { personas: [] };
      if (m.isJudge) {
        entry.judgeRaw = m.content;
      } else {
        entry.personas.push(m);
      }
      roundMap.set(r, entry);
    }
    const maxRound = Math.max(...roundMap.keys(), 0);
    return Array.from(roundMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([round, data]) => {
        const board = current.blackboardStates.find(b => b.phase === round);
        return {
          round,
          personas: data.personas.map(p => ({
            persona: p.persona,
            vote: p.vote ?? null,
            confidence: p.confidence ?? null,
            reasoning: p.content,
            probability: null,
            conflictsWith: p.conflictsWith ?? null,
          })),
          judgeRawResponse: data.judgeRaw,
          isFinalRound: round === maxRound,
          blackboardSignals: board?.state?.signals,
          blackboardRisks: board?.state?.risks,
        };
      });
  };

  // Extract context from blackboard state or user prompt
  const getContext = () => {
    if (!current) return null;
    const firstBoard = current.blackboardStates[0]?.state;
    return {
      pair: firstBoard?.market?.pairs?.[0] ?? 'N/A',
      regime: firstBoard?.market?.regime ?? 'Unknown',
      fearGreed: firstBoard?.market?.fearGreed ?? 0,
      volumeRatio: firstBoard?.market?.volumeRatio ?? 0,
    };
  };

  const rounds = getRounds();
  const ctx = getContext();

  return (
    <div className="flex h-[calc(100vh-5rem)]">
      <DebateSidebar
        debates={debates.map(d => ({ cycleId: d.cycleId, createdAt: d.createdAt, votes: d.votes, summary: d.summary }))}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-zinc-300">Swarm Debate</h1>
            {current && (
              <span className="text-xs text-zinc-600 font-mono">
                Cycle {current.cycleId} &middot; {new Date(current.createdAt).toLocaleString()}
              </span>
            )}
          </div>
          {current && <CopyButton debate={current} />}
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-6">
          {current ? (
            <>
              {ctx && current.userPrompt && (
                <InputContextCard
                  userPrompt={current.userPrompt}
                  pair={ctx.pair}
                  regime={ctx.regime}
                  fearGreed={ctx.fearGreed}
                  volumeRatio={ctx.volumeRatio}
                />
              )}
              {rounds.map(r => (
                <RoundSection key={r.round} {...r} />
              ))}
            </>
          ) : (
            <div className="text-zinc-500 text-sm mt-8 text-center">
              {debates.length === 0 ? 'No swarm debates found' : 'Select a debate from the sidebar'}
            </div>
          )}
        </div>

        {/* Superuser input */}
        <div className="p-3 border-t border-border">
          <div className="flex gap-2">
            <input
              type="text"
              value={superInput}
              onChange={(e) => setSuperInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendSuperuserMessage()}
              placeholder="Inject message as superuser..."
              disabled={!current || sending}
              className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent/60 disabled:opacity-50"
            />
            <button
              onClick={sendSuperuserMessage}
              disabled={!superInput.trim() || !current || sending}
              className="bg-superuser hover:bg-superuser/80 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium text-surface-0"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
