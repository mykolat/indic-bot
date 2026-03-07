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

interface DebateDetail {
  cycleId: number;
  createdAt: string;
  messages: SwarmMessage[];
  userPrompt: string;
  blackboardStates: Array<{ phase: number; state: any }>;
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
      const [{ data: judges }, { data: latestCycle }] = await Promise.all([
        supabase
          .from('llm_conversations')
          .select('cycle_id, raw_response, created_at')
          .eq('method', 'swarm_consensus')
          .order('created_at', { ascending: false })
          .limit(60),
        supabase
          .from('cycles')
          .select('id, volume_ratio, regime, created_at')
          .order('created_at', { ascending: false })
          .limit(1),
      ]);

      // Deduplicate by cycle_id, keep latest per cycle
      const seen = new Set<number>();
      const items: SidebarItem[] = [];

      // If latest cycle is NOT a debate, show it as "skip" at top
      const latestDebateCycleId = judges?.[0]?.cycle_id;
      const latest = latestCycle?.[0];
      if (latest && latest.id !== latestDebateCycleId) {
        const vol = latest.volume_ratio != null ? Number(latest.volume_ratio).toFixed(2) : '?';
        items.push({
          cycleId: latest.id,
          createdAt: latest.created_at,
          summary: `Skip — Vol ${vol}x < 1.5x`,
          votes: [],
          isSkip: true,
          skipReason: `Vol ${vol}x (need >1.5x) · ${latest.regime}`,
        });
        seen.add(latest.id);
      }

      if (judges?.length) {
        for (const j of judges) {
          if (seen.has(j.cycle_id)) continue;
          seen.add(j.cycle_id);
          items.push({
            cycleId: j.cycle_id,
            createdAt: j.created_at,
            summary: extractSummary(j.raw_response),
            votes: [],
          });
        }
      }
      setSidebarItems(items);

      // Auto-select from ?cycle= param (default to first debate, not skip)
      const cycleParam = searchParams.get('cycle');
      if (cycleParam) {
        const idx = items.findIndex(i => i.cycleId === Number(cycleParam));
        if (idx >= 0) setSelectedIdx(idx);
      } else if (items.length > 0 && items[0].isSkip && items.length > 1) {
        setSelectedIdx(1); // select first real debate by default
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

    // Update sidebar votes for this item
    const votes = personaList
      .filter(p => p.persona !== 'superuser' && (p.phase ?? 1) === 1)
      .map(p => ({ persona: p.persona, vote: p.vote }));
    setSidebarItems(prev => prev.map((si, i) => i === idx ? { ...si, votes } : si));

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
              {rounds.length === 0 && selected?.isSkip && (
                <div className="max-w-lg mx-auto mt-8 space-y-4">
                  <div className="bg-yellow-950/20 border border-yellow-800/30 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-yellow-500 mb-2">Debate Skipped</h3>
                    <p className="text-sm text-zinc-400">{selected.skipReason}</p>
                  </div>
                  <div className="bg-surface-1 border border-border rounded-xl p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">How Swarm Activation Works</h3>
                    <div className="text-xs text-zinc-500 space-y-2">
                      <p>The swarm multi-agent debate activates when <span className="text-zinc-300 font-mono">BTC volumeRatio &gt; 1.5x</span> (current volume vs 20-period average).</p>
                      <p>When active, <span className="text-zinc-300">5 AI personas</span> debate independently: Risk Manager, Bull Thesis, Bear Thesis, Market Structure, and Devil's Advocate (+ optional Narrative Expert via Grok).</p>
                      <p>When volume is below threshold, the bot uses a <span className="text-zinc-300">single LLM call</span> instead — faster, cheaper, sufficient for low-activity markets.</p>
                      <div className="border-t border-border pt-2 mt-2">
                        <p className="text-zinc-600">Volume typically spikes during London/NY overlap (15:00-19:00 Kyiv) and around major news events.</p>
                      </div>
                    </div>
                  </div>
                </div>
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
