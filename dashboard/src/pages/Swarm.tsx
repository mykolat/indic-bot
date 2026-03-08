import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { DebateSidebar } from '../components/swarm/DebateSidebar';
import { InputContextCard } from '../components/swarm/InputContextCard';
import { RoundSection } from '../components/swarm/RoundSection';

// ── Types ──

interface SidebarItem {
  cycleId: number;
  createdAt: string;
  summary: string;
  votes: Array<{ persona: string; vote: string | null }>;
  isSkip?: boolean;
  skipReason?: string;
}

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
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] } | null;
}

interface SingleCycleEntry {
  cycleId: number;
  createdAt: string;
  model?: string;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  decisions: Array<{ pair: string; action: string; confidence?: number; reasoning?: string }>;
  raw_response?: string;
}

interface DebateDetail {
  cycleId: number;
  createdAt: string;
  messages: SwarmMessage[];
  userPrompt: string;
  blackboardStates: Array<{ phase: number; state: any }>;
  singleCycles?: SingleCycleEntry[];
}

// ── Helpers ──

function extractSummary(judgeResponse?: string): string {
  if (!judgeResponse) return 'No verdict';
  try {
    const parsed = JSON.parse(judgeResponse);
    if (parsed.decisions?.[0]) {
      const d = parsed.decisions[0];
      if (typeof d === 'string') {
        // Blackboard format: ["HOLD", "SHORT"]
        const unique = [...new Set(parsed.decisions as string[])];
        return `${unique.join('/')} ${parsed.verdict ? parsed.verdict.slice(0, 40) : ''}`.trim();
      }
      // Legacy format: [{pair, action, confidence}]
      return `${d.action} ${d.pair ?? ''} conf:${d.confidence ?? '?'}`;
    }
    if (parsed.verdict) return parsed.verdict.slice(0, 60);
  } catch { /* not JSON */ }
  return judgeResponse.slice(0, 60).replace(/\n/g, ' ') + '\u2026';
}

function formatDebateForCopy(item: SidebarItem, detail: DebateDetail): string {
  const lines: string[] = [];
  lines.push(`=== Swarm Debate \u2014 Cycle ${item.cycleId} ===`);
  lines.push(`Date: ${new Date(item.createdAt).toLocaleString()}`);
  lines.push('');
  if (detail.userPrompt) {
    lines.push('--- INPUT CONTEXT ---');
    lines.push(detail.userPrompt);
    lines.push('');
  }
  const byRound = new Map<number, SwarmMessage[]>();
  for (const m of detail.messages) {
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

function CopyButton({ item, detail }: { item: SidebarItem; detail: DebateDetail }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(formatDebateForCopy(item, detail)).then(() => {
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

// ── Main Component ──

export function Swarm() {
  const [searchParams] = useSearchParams();
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [currentDetail, setCurrentDetail] = useState<DebateDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [superInput, setSuperInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const detailCache = useRef(new Map<number, DebateDetail>());

  // ── Load sidebar (fast — single query) ──
  useEffect(() => {
    (async () => {
      const [{ data: recentCycles }, { data: judges }, { data: allVotes }] = await Promise.all([
        supabase
          .from('cycles')
          .select('id, volume_ratio, regime, created_at')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('llm_conversations')
          .select('cycle_id, raw_response, created_at')
          .eq('method', 'swarm_consensus')
          .order('created_at', { ascending: false })
          .limit(60),
        supabase
          .from('swarm_personas')
          .select('conversation_id, persona, vote, phase')
          .eq('phase', 1)
          .neq('persona', 'superuser')
          .order('created_at', { ascending: false })
          .limit(500),
      ]);

      // Build vote lookup: conversation_id → cycle_id via judges
      const cycleVotes = new Map<number, Array<{ persona: string; vote: string | null }>>();
      if (judges?.length && allVotes?.length) {
        const { data: convs } = await supabase
          .from('llm_conversations')
          .select('id, cycle_id')
          .eq('method', 'swarm_consensus')
          .in('cycle_id', judges.map(j => j.cycle_id));
        const convToCycle = new Map<number, number>();
        for (const c of convs ?? []) convToCycle.set(c.id, c.cycle_id);
        for (const v of allVotes) {
          const cid = convToCycle.get(v.conversation_id);
          if (!cid) continue;
          const arr = cycleVotes.get(cid) ?? [];
          arr.push({ persona: v.persona, vote: v.vote });
          cycleVotes.set(cid, arr);
        }
      }

      // Build lookup of debate cycles
      const debateJudge = new Map<number, string>();
      for (const j of judges ?? []) {
        if (!debateJudge.has(j.cycle_id)) {
          debateJudge.set(j.cycle_id, j.raw_response);
        }
      }

      // Build items: group consecutive non-debate cycles into single sidebar entries
      const items: SidebarItem[] = [];
      const cycles = recentCycles ?? [];
      let i = 0;
      while (i < cycles.length) {
        const cycle = cycles[i];
        if (debateJudge.has(cycle.id)) {
          items.push({
            cycleId: cycle.id,
            createdAt: cycle.created_at,
            summary: extractSummary(debateJudge.get(cycle.id)),
            votes: cycleVotes.get(cycle.id) ?? [],
          });
          i++;
        } else {
          // Collect consecutive skip cycles into a group
          const groupStart = i;
          while (i < cycles.length && !debateJudge.has(cycles[i].id)) i++;
          const groupCycles = cycles.slice(groupStart, i);
          const first = groupCycles[0];
          const last = groupCycles[groupCycles.length - 1];
          const count = groupCycles.length;
          items.push({
            cycleId: first.id,
            createdAt: first.created_at,
            summary: count === 1
              ? `Single LLM #${first.id}`
              : `Single LLM #${first.id}–#${last.id} (${count})`,
            votes: [],
            isSkip: true,
            skipReason: groupCycles.map(c => c.id).join(','),
          });
        }
      }
      setSidebarItems(items);

      // Auto-select from ?cycle= param (default to first debate, not skip)
      const cycleParam = searchParams.get('cycle');
      if (cycleParam) {
        const idx = items.findIndex(i => i.cycleId === Number(cycleParam));
        if (idx >= 0) setSelectedIdx(idx);
      } else if (items.length > 0) {
        setSelectedIdx(0); // select first item (latest group or debate)
      }
    })();
  }, [searchParams]);

  // ── Load detail for selected debate (lazy) ──
  const loadDetail = useCallback(async (idx: number) => {
    const item = sidebarItems[idx];
    if (!item) return;

    // Check cache
    if (detailCache.current.has(item.cycleId)) {
      setCurrentDetail(detailCache.current.get(item.cycleId)!);
      return;
    }

    setLoadingDetail(true);

    // For skip items, fetch ALL single-LLM cycles in this group
    if (item.isSkip) {
      const skipCycleIds = (item.skipReason ?? '').split(',').map(Number).filter(Boolean);

      const [{ data: convs }, { data: decisions }] = await Promise.all([
        supabase
          .from('llm_conversations')
          .select('cycle_id, raw_response, model, tokens_in, tokens_out, latency_ms, created_at')
          .in('cycle_id', skipCycleIds)
          .eq('method', 'analyze')
          .order('created_at', { ascending: false }),
        supabase
          .from('trade_decisions')
          .select('cycle_id, pair, action, confidence, reasoning')
          .in('cycle_id', skipCycleIds),
      ]);

      const convMap = new Map<number, typeof convs extends (infer T)[] | null ? T : never>();
      for (const c of convs ?? []) {
        if (!convMap.has(c.cycle_id)) convMap.set(c.cycle_id, c);
      }
      const decMap = new Map<number, Array<{ pair: string; action: string; confidence?: number; reasoning?: string }>>();
      for (const d of decisions ?? []) {
        const arr = decMap.get(d.cycle_id) ?? [];
        arr.push(d);
        decMap.set(d.cycle_id, arr);
      }

      const singleCycles: SingleCycleEntry[] = skipCycleIds.map(cid => {
        const conv = convMap.get(cid);
        let decs = decMap.get(cid) ?? [];
        // Fallback: parse decisions from raw_response if trade_decisions is empty
        if (decs.length === 0 && conv?.raw_response) {
          try {
            const parsed = JSON.parse(conv.raw_response);
            if (Array.isArray(parsed.decisions)) {
              decs = parsed.decisions.map((d: any) => ({
                pair: d.pair, action: d.action,
                confidence: d.confidence, reasoning: d.reasoning,
              }));
            }
          } catch { /* not JSON */ }
        }
        return {
          cycleId: cid,
          createdAt: conv?.created_at ?? item.createdAt,
          model: conv?.model,
          latency_ms: conv?.latency_ms,
          tokens_in: conv?.tokens_in,
          tokens_out: conv?.tokens_out,
          decisions: decs,
          raw_response: conv?.raw_response,
        };
      });

      const detail: DebateDetail = {
        cycleId: item.cycleId,
        createdAt: item.createdAt,
        messages: [],
        userPrompt: '',
        blackboardStates: [],
        singleCycles,
      };
      detailCache.current.set(item.cycleId, detail);
      setCurrentDetail(detail);
      setLoadingDetail(false);
      return;
    }

    // Compute tight time window: from previous cycle to current + 1min
    const nextOlderItem = sidebarItems[idx + 1];
    const windowStart = nextOlderItem
      ? new Date(new Date(nextOlderItem.createdAt).getTime() + 1000).toISOString() // 1s after previous cycle
      : new Date(new Date(item.createdAt).getTime() - 300_000).toISOString(); // fallback: 5min before
    const windowEnd = new Date(new Date(item.createdAt).getTime() + 60_000).toISOString();

    const [personasRes, judgeConvsRes] = await Promise.all([
      supabase
        .from('swarm_personas')
        .select('persona, vote, confidence, reasoning, created_at, phase, conflicts_with, signals')
        .gte('created_at', windowStart)
        .lte('created_at', windowEnd)
        .order('created_at', { ascending: true }),
      supabase
        .from('llm_conversations')
        .select('raw_response, created_at, label, blackboard_state, user_prompt')
        .eq('cycle_id', item.cycleId)
        .eq('method', 'swarm_consensus')
        .order('created_at', { ascending: true }),
    ]);

    const personaList = personasRes.data || [];
    const judgeConvs = judgeConvsRes.data || [];

    // Map judge conversations by round level
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

    const maxPhase = Math.max(...personaList.map(p => p.phase ?? 1), ...judgeByLevel.keys(), 1);
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
            signals: p.signals as { bullish?: string[]; bearish?: string[]; neutral?: string[] } | null,
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

    // Blackboard states
    const blackboardStates: DebateDetail['blackboardStates'] = [];
    for (const [level, convs] of judgeByLevel) {
      for (const jc of convs) {
        if ((jc as any).blackboard_state) {
          blackboardStates.push({ phase: level, state: (jc as any).blackboard_state });
        }
      }
    }

    // Update sidebar votes for this item (only if we got new data)
    const votes = personaList
      .filter(p => p.persona !== 'superuser' && (p.phase ?? 1) === 1)
      .map(p => ({ persona: p.persona, vote: p.vote }));
    if (votes.length > 0) {
      setSidebarItems(prev => prev.map((si, i) => i === idx ? { ...si, votes } : si));
    }

    const detail: DebateDetail = {
      cycleId: item.cycleId,
      createdAt: item.createdAt,
      messages,
      userPrompt: (judgeConvs[0] as any)?.user_prompt ?? '',
      blackboardStates,
    };

    detailCache.current.set(item.cycleId, detail);
    setCurrentDetail(detail);
    setLoadingDetail(false);
  }, [sidebarItems]);

  // Trigger detail load on selection change
  useEffect(() => {
    if (sidebarItems.length > 0) {
      loadDetail(selectedIdx);
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [selectedIdx, sidebarItems, loadDetail]);

  // ── Superuser inject ──
  const sendSuperuserMessage = async () => {
    if (!superInput.trim() || !currentDetail || sending) return;
    setSending(true);
    try {
      const webhookUrl = (import.meta as any).env?.VITE_WEBHOOK_URL || 'http://localhost:3000';
      await fetch(`${webhookUrl}/api/swarm/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle_id: currentDetail.cycleId, message: superInput.trim() }),
      });
      const now = new Date();
      const newMsg: SwarmMessage = {
        persona: 'superuser', content: superInput.trim(),
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSuperuser: true, phase: Math.max(...currentDetail.messages.map(m => m.phase ?? 1), 1),
      };
      const updated = { ...currentDetail, messages: [...currentDetail.messages, newMsg] };
      setCurrentDetail(updated);
      detailCache.current.set(currentDetail.cycleId, updated);
      setSuperInput('');
    } catch (err) {
      console.error('Failed to inject:', err);
    }
    setSending(false);
  };

  // ── Build rounds for RoundSection ──
  const getRounds = () => {
    if (!currentDetail) return [];
    const roundMap = new Map<number, { personas: SwarmMessage[]; judgeRaw?: string }>();
    for (const m of currentDetail.messages) {
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
        const board = currentDetail.blackboardStates.find(b => b.phase === round);
        return {
          round,
          personas: data.personas.map(p => ({
            persona: p.persona,
            vote: p.vote ?? null,
            confidence: p.confidence ?? null,
            reasoning: p.content,
            probability: null,
            conflictsWith: p.conflictsWith ?? null,
            signals: p.signals ?? undefined,
            time: p.time,
          })),
          judgeRawResponse: data.judgeRaw,
          isFinalRound: round === maxRound,
          blackboardSignals: board?.state?.signals,
          blackboardRisks: board?.state?.risks,
        };
      });
  };

  // ── Extract context (blackboard first, fallback to user_prompt parsing) ──
  const getContext = () => {
    if (!currentDetail) return null;
    const prompt = currentDetail.userPrompt;

    // Try blackboard state first
    const firstBoard = currentDetail.blackboardStates[0]?.state;
    if (firstBoard?.market?.pairs?.[0] && firstBoard.market.fearGreed > 0) {
      return {
        pair: firstBoard.market.pairs[0],
        regime: firstBoard.market.regime ?? 'Unknown',
        fearGreed: firstBoard.market.fearGreed,
        volumeRatio: firstBoard.market.volumeRatio ?? 0,
      };
    }

    if (!prompt) return null;

    // Fallback: parse from user_prompt text
    const pairMatch = prompt.match(/([A-Z]{2,}USDT)/);
    const regimeMatch = prompt.match(/REGIME:\s*(.+?)(?:\.|\\n|\n)/i);
    const fgMatch = prompt.match(/Fear.*?Greed.*?(\d+)/i) || prompt.match(/F&G[:\s]*(\d+)/i);
    const volMatch = prompt.match(/volume[Rr]atio[:\s]*(\d+\.?\d*)/i) || prompt.match(/(\d+\.?\d*)x\s*(?:average|vol)/i);

    return {
      pair: pairMatch?.[1] ?? 'N/A',
      regime: regimeMatch?.[1]?.trim() ?? 'Unknown',
      fearGreed: fgMatch ? parseInt(fgMatch[1]) : 0,
      volumeRatio: volMatch ? parseFloat(volMatch[1]) : 0,
    };
  };

  const selected = sidebarItems[selectedIdx];
  const rounds = getRounds();
  const ctx = getContext();

  return (
    <div className="flex h-[calc(100vh-5rem)]">
      <DebateSidebar
        debates={sidebarItems.map(d => ({ cycleId: d.cycleId, createdAt: d.createdAt, votes: d.votes, summary: d.summary, isSkip: d.isSkip, skipReason: d.skipReason }))}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
      />

      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold text-zinc-300">Swarm Debate</h1>
            {selected && (
              <span className="text-xs text-zinc-600 font-mono">
                Cycle {selected.cycleId} &middot; {new Date(selected.createdAt).toLocaleString()}
              </span>
            )}
          </div>
          {selected && currentDetail && <CopyButton item={selected} detail={currentDetail} />}
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-6">
          {loadingDetail ? (
            <div className="space-y-6 animate-pulse">
              {/* Context skeleton */}
              <div className="bg-surface-1 rounded-xl border border-border p-5">
                <div className="h-3 bg-surface-3 rounded w-24 mb-3" />
                <div className="grid grid-cols-5 gap-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i}>
                      <div className="h-2 bg-surface-2 rounded w-12 mb-1" />
                      <div className="h-4 bg-surface-3 rounded w-16" />
                    </div>
                  ))}
                </div>
              </div>
              {/* Chat bubbles skeleton */}
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-surface-3 shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-surface-3 rounded w-28" />
                    <div className="bg-surface-2 rounded-2xl p-4 space-y-2">
                      <div className="h-3 bg-surface-3 rounded w-full" />
                      <div className="h-3 bg-surface-3 rounded w-3/4" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : currentDetail ? (
            <>
              {ctx && currentDetail.userPrompt && (
                <InputContextCard
                  userPrompt={currentDetail.userPrompt}
                  pair={ctx.pair}
                  regime={ctx.regime}
                  fearGreed={ctx.fearGreed}
                  volumeRatio={ctx.volumeRatio}
                />
              )}
              {rounds.map(r => (
                <RoundSection key={r.round} {...r} />
              ))}
              {rounds.length === 0 && selected?.isSkip && currentDetail?.singleCycles && (
                <div className="max-w-2xl mx-auto space-y-3">
                  {currentDetail.singleCycles.map((sc) => (
                    <div key={sc.cycleId} className="bg-surface-1 border border-border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-zinc-500">#{sc.cycleId}</span>
                          <span className="text-xs text-zinc-600">
                            {new Date(sc.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div className="flex gap-3 text-xs text-zinc-600 font-mono">
                          {sc.model && <span>{sc.model}</span>}
                          {sc.latency_ms != null && <span>{(sc.latency_ms / 1000).toFixed(1)}s</span>}
                          {sc.tokens_in != null && <span>in:{sc.tokens_in}</span>}
                          {sc.tokens_out != null && <span>out:{sc.tokens_out}</span>}
                        </div>
                      </div>
                      {sc.decisions.length > 0 ? sc.decisions.map((d, di) => (
                        <div key={di} className={di > 0 ? 'mt-3 pt-3 border-t border-border' : ''}>
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className={`text-lg font-bold ${
                              d.action === 'HOLD' ? 'text-zinc-500' :
                              d.action === 'LONG' ? 'text-green-400' :
                              d.action === 'SHORT' ? 'text-red-400' :
                              d.action === 'CLOSE' ? 'text-yellow-400' : 'text-zinc-400'
                            }`}>{d.action}</span>
                            <span className="text-sm text-zinc-300 font-mono">{d.pair}</span>
                            {d.confidence != null && (
                              <span className="text-xs text-zinc-500">conf:{d.confidence}</span>
                            )}
                          </div>
                          {d.reasoning && (
                            <p className="text-xs text-zinc-400 leading-relaxed">{d.reasoning}</p>
                          )}
                        </div>
                      )) : (
                        <p className="text-xs text-zinc-600 italic">No decisions recorded</p>
                      )}
                    </div>
                  ))}
                  {currentDetail.singleCycles.length === 0 && (
                    <div className="text-sm text-zinc-600 text-center py-8">No single LLM data found</div>
                  )}
                </div>
              )}
              {rounds.length === 0 && selected?.isSkip && !currentDetail?.singleCycles && (
                <div className="text-sm text-zinc-600 text-center py-8">No data for this cycle</div>
              )}
              {rounds.length === 0 && !selected?.isSkip && (
                <div className="text-zinc-600 text-sm text-center mt-8">No expert data for this debate</div>
              )}
            </>
          ) : (
            <div className="text-zinc-500 text-sm mt-8 text-center">
              {sidebarItems.length === 0 ? 'No swarm debates found' : 'Select a debate from the sidebar'}
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
              disabled={!currentDetail || sending}
              className="flex-1 bg-surface-2 border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent/60 disabled:opacity-50"
            />
            <button
              onClick={sendSuperuserMessage}
              disabled={!superInput.trim() || !currentDetail || sending}
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
