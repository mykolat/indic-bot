import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { SwarmChatMessage } from '../components/swarm/SwarmChatMessage';
import { DebateSidebar } from '../components/swarm/DebateSidebar';
import { LevelDivider } from '../components/swarm/LevelDivider';

interface SwarmMessage {
  persona: string;
  content: string;
  vote?: string | null;
  confidence?: number | null;
  time: string;
  isJudge?: boolean;
  isSuperuser?: boolean;
  phase?: number;
  replyTo?: { persona: string; content: string } | null;
}

interface DebateData {
  cycleId: number;
  createdAt: string;
  votes: Array<{ persona: string; vote: string | null }>;
  summary: string;
  messages: SwarmMessage[];
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
  return judgeResponse.slice(0, 60).replace(/\n/g, ' ') + '…';
}

export function Swarm() {
  const [debates, setDebates] = useState<DebateData[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [superInput, setSuperInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const { data: judges } = await supabase
        .from('llm_conversations')
        .select('cycle_id, raw_response, created_at, label')
        .eq('method', 'swarm_consensus')
        .order('created_at', { ascending: false })
        .limit(30);
      if (!judges?.length) return;

      // Group by cycle_id — take first (latest) judge per cycle for sidebar
      const seenCycles = new Set<number>();
      const topJudges = judges.filter(j => {
        if (seenCycles.has(j.cycle_id)) return false;
        seenCycles.add(j.cycle_id);
        return true;
      });

      const result: DebateData[] = [];
      for (const j of topJudges) {
        const windowStart = new Date(new Date(j.created_at).getTime() - 1_800_000).toISOString(); // 30min window
        const windowEnd = new Date(new Date(j.created_at).getTime() + 60_000).toISOString();

        const [personasRes, judgeConvsRes] = await Promise.all([
          supabase
            .from('swarm_personas')
            .select('persona, vote, confidence, reasoning, created_at, phase, reply_to_id')
            .gte('created_at', windowStart)
            .lte('created_at', windowEnd)
            .order('created_at', { ascending: true }),
          supabase
            .from('llm_conversations')
            .select('raw_response, created_at, label')
            .eq('cycle_id', j.cycle_id)
            .eq('method', 'swarm_consensus')
            .order('created_at', { ascending: true }),
        ]);

        const personaList = personasRes.data || [];
        const judgeConvs = judgeConvsRes.data || [];

        // Map judge convs by level
        const judgeByLevel = new Map<number, typeof judgeConvs>();
        for (const jc of judgeConvs) {
          const levelMatch = jc.label?.match(/judge_level_(\d+)/);
          const level = levelMatch ? parseInt(levelMatch[1]) : 1;
          const arr = judgeByLevel.get(level) ?? [];
          arr.push(jc);
          judgeByLevel.set(level, arr);
        }
        // Legacy: unlabeled judge → level 1
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
                persona: 'superuser',
                content: p.reasoning || '(no message)',
                time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isSuperuser: true,
                phase,
              });
            } else {
              messages.push({
                persona: p.persona,
                content: p.reasoning || '(no reasoning)',
                vote: p.vote,
                confidence: p.confidence,
                time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                phase,
              });
            }
          }
          // Judge for this level
          for (const jc of judgeByLevel.get(phase) ?? []) {
            messages.push({
              persona: 'judge',
              content: jc.raw_response || '(no verdict)',
              time: new Date(jc.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isJudge: true,
              phase,
            });
          }
        }

        result.push({
          cycleId: j.cycle_id,
          createdAt: j.created_at,
          votes: personaList
            .filter(p => p.persona !== 'superuser')
            .map(p => ({ persona: p.persona, vote: p.vote })),
          summary: extractSummary(j.raw_response),
          messages,
        });
      }
      setDebates(result);
    };
    load();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
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
        persona: 'superuser',
        content: superInput.trim(),
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSuperuser: true,
        phase: Math.max(...current.messages.map(m => m.phase ?? 1), 1),
      };
      setDebates(prev => prev.map((d, i) =>
        i === selectedIdx ? { ...d, messages: [...d.messages, newMsg] } : d,
      ));
      setSuperInput('');
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (err) {
      console.error('Failed to inject superuser message:', err);
    }
    setSending(false);
  };

  const renderMessages = () => {
    if (!current) return null;
    const msgs = current.messages;
    let lastPhase = 0;
    const elements: React.ReactNode[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const phase = m.phase ?? 1;
      if (phase !== lastPhase) {
        elements.push(<LevelDivider key={`lvl-${phase}-${i}`} level={phase} />);
        lastPhase = phase;
      }
      elements.push(
        <SwarmChatMessage
          key={i}
          persona={m.persona}
          content={m.content}
          vote={m.vote}
          confidence={m.confidence}
          time={m.time}
          isJudge={m.isJudge}
          isSuperuser={m.isSuperuser}
          replyTo={m.replyTo}
        />,
      );
    }
    return elements;
  };

  return (
    <div className="flex h-[calc(100vh-8rem)]">
      <DebateSidebar
        debates={debates.map(d => ({
          cycleId: d.cycleId,
          createdAt: d.createdAt,
          votes: d.votes,
          summary: d.summary,
        }))}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-3 border-b border-zinc-800 flex items-center gap-3">
          <h1 className="text-sm font-bold text-zinc-300">Swarm Debate</h1>
          {current && (
            <span className="text-xs text-zinc-500">
              Cycle {current.cycleId} — {new Date(current.createdAt).toLocaleString()}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {current ? (
            <>
              {renderMessages()}
              <div ref={bottomRef} />
            </>
          ) : (
            <div className="text-zinc-500 text-sm mt-8 text-center">
              {debates.length === 0 ? 'No swarm debates found' : 'Select a debate from the sidebar'}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-zinc-800">
          <div className="flex gap-2">
            <input
              type="text"
              value={superInput}
              onChange={(e) => setSuperInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendSuperuserMessage()}
              placeholder="Inject message as superuser..."
              disabled={!current || sending}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-600 disabled:opacity-50"
            />
            <button
              onClick={sendSuperuserMessage}
              disabled={!superInput.trim() || !current || sending}
              className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
            >
              👑 Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
