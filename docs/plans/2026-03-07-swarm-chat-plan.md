# Swarm Chat Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Swarm page into a messenger-style group chat where AI personas debate with emoji avatars, the Judge moderates between levels (max 5), and the user can inject messages as superuser.

**Architecture:** 5-phase plan: (1) Frontend chat layout with sidebar + chat bubbles using existing data, (2) DB migration adding `phase` and `reply_to_id` columns, (3) SwarmAgent dynamic loop with Judge-as-moderator, (4) Frontend level dividers + reply quotes, (5) Superuser message injection via webhook API + input bar.

**Tech Stack:** React 19, TypeScript ESM, Tailwind 4, Supabase (PG + REST), Express webhook server, Vitest

**Design doc:** `docs/plans/2026-03-07-swarm-chat-design.md`

---

## Existing File Map

```
# Frontend (dashboard/)
src/pages/Swarm.tsx              — current: dropdown + cards + raw JSON judge
src/components/PersonaCard.tsx   — persona card with colored border (will be replaced)
src/components/ChatMessage.tsx   — simple chat bubble (user/assistant) — REUSE patterns
src/pages/Chat.tsx               — existing chat page — REUSE input bar pattern
src/lib/supabase.ts              — Supabase client

# Backend (src/)
src/llm/swarm-agent.ts           — SwarmAgent class (3-stage hardcoded pipeline)
src/llm/prompts.ts               — buildExpertSystemPrompt, buildCritiquePrompt, buildRevisePrompt
src/db/types.ts                  — DbSwarmPersona interface
src/db/repository.ts             — insertSwarmPersona, insertLlmConversation
src/webhook/server.ts            — Express webhook server
tests/llm/swarm-agent.test.ts    — SwarmAgent tests (10 tests)
```

## DB Tables (relevant columns)

- `swarm_personas`: id, conversation_id, persona, model, raw_response, vote, confidence, reasoning, tokens_in, tokens_out, created_at
- `llm_conversations`: id, cycle_id, session_id, layer, model, method, label, system_prompt, user_prompt, raw_response, tokens_in, tokens_out, latency_ms, parsed_ok, created_at

---

## Task 1: Create SwarmChatMessage component

**Files:**
- Create: `dashboard/src/components/swarm/SwarmChatMessage.tsx`

**Step 1: Create the component**

Create `dashboard/src/components/swarm/SwarmChatMessage.tsx`:

```tsx
interface SwarmChatMessageProps {
  persona: string;
  content: string;
  vote?: string | null;
  confidence?: number | null;
  time: string;
  isJudge?: boolean;
  isSuperuser?: boolean;
  replyTo?: { persona: string; content: string } | null;
}

const PERSONA_EMOJI: Record<string, string> = {
  bull_thesis: '🐂',
  bear_thesis: '🐻',
  risk_manager: '🛡️',
  market_structure: '🔬',
  devils_advocate: '😈',
  narrative_expert: '📰',
  judge: '⚖️',
  superuser: '👑',
};

const PERSONA_COLORS: Record<string, string> = {
  bull_thesis: '#4ade80',
  bear_thesis: '#f87171',
  risk_manager: '#eab308',
  market_structure: '#60a5fa',
  devils_advocate: '#a78bfa',
  narrative_expert: '#fb923c',
  judge: '#e2e8f0',
  superuser: '#f59e0b',
};

const VOTE_COLORS: Record<string, string> = {
  LONG: '#4ade80',
  SHORT: '#f87171',
  HOLD: '#71717a',
};

export function SwarmChatMessage({
  persona, content, vote, confidence, time, isJudge, isSuperuser, replyTo,
}: SwarmChatMessageProps) {
  const emoji = PERSONA_EMOJI[persona] ?? '🤖';
  const color = PERSONA_COLORS[persona] ?? '#a1a1aa';
  const isOutgoing = isJudge;
  const label = persona.replace(/_/g, ' ').toUpperCase();

  return (
    <div className={`flex gap-3 ${isOutgoing ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-lg"
        style={{ backgroundColor: `${color}20`, border: `2px solid ${color}` }}
        title={label}
      >
        {emoji}
      </div>

      {/* Bubble */}
      <div className={`max-w-[75%] ${isOutgoing ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* Header */}
        <div className={`flex items-center gap-2 mb-1 ${isOutgoing ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs font-semibold" style={{ color }}>{label}</span>
          {vote && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{
              color: VOTE_COLORS[vote] ?? '#a1a1aa',
              backgroundColor: `${VOTE_COLORS[vote] ?? '#a1a1aa'}20`,
            }}>
              {vote}
            </span>
          )}
          {confidence != null && <span className="text-xs text-zinc-500">conf:{confidence}</span>}
          <span className="text-xs text-zinc-600">{time}</span>
        </div>

        {/* Reply quote */}
        {replyTo && (
          <div className="text-xs text-zinc-500 border-l-2 pl-2 mb-1 truncate max-w-full"
            style={{ borderColor: PERSONA_COLORS[replyTo.persona] ?? '#3f3f46' }}>
            {PERSONA_EMOJI[replyTo.persona] ?? '🤖'} {replyTo.content.slice(0, 80)}…
          </div>
        )}

        {/* Content */}
        <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isOutgoing
            ? 'bg-zinc-700 text-zinc-100'
            : isSuperuser
              ? 'bg-amber-900/30 border border-amber-800/50 text-zinc-200'
              : 'bg-zinc-800 text-zinc-300'
        }`}>
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

```bash
cd dashboard && npm run build
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/SwarmChatMessage.tsx
git commit -m "feat(dashboard): add SwarmChatMessage component — emoji avatars, vote badges, reply quotes"
```

---

## Task 2: Create DebateSidebar component

**Files:**
- Create: `dashboard/src/components/swarm/DebateSidebar.tsx`

**Step 1: Create the component**

Create `dashboard/src/components/swarm/DebateSidebar.tsx`:

```tsx
interface DebateItem {
  cycleId: number;
  createdAt: string;
  votes: Array<{ persona: string; vote: string | null }>;
  summary: string;
}

interface DebateSidebarProps {
  debates: DebateItem[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}

const VOTE_DOT_COLORS: Record<string, string> = {
  LONG: '#4ade80',
  SHORT: '#f87171',
  HOLD: '#71717a',
};

export function DebateSidebar({ debates, selectedIdx, onSelect }: DebateSidebarProps) {
  return (
    <div className="w-72 shrink-0 border-r border-zinc-800 overflow-y-auto">
      <div className="p-3 border-b border-zinc-800">
        <h2 className="text-sm font-bold text-zinc-300">Debates</h2>
      </div>
      {debates.map((d, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className={`w-full text-left p-3 border-b border-zinc-800/50 transition-colors ${
            selectedIdx === i ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
          }`}
        >
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs font-mono text-zinc-400">Cycle {d.cycleId}</span>
            <span className="text-xs text-zinc-600">
              {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          {/* Vote dots */}
          <div className="flex gap-1 mb-1">
            {d.votes.map((v, j) => (
              <div
                key={j}
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: VOTE_DOT_COLORS[v.vote ?? 'HOLD'] ?? '#71717a' }}
                title={`${v.persona}: ${v.vote ?? 'N/A'}`}
              />
            ))}
          </div>
          {/* Summary */}
          <p className="text-xs text-zinc-500 truncate">{d.summary}</p>
        </button>
      ))}
      {debates.length === 0 && (
        <div className="p-4 text-zinc-600 text-xs">No debates found</div>
      )}
    </div>
  );
}
```

**Step 2: Verify build**

```bash
cd dashboard && npm run build
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/DebateSidebar.tsx
git commit -m "feat(dashboard): add DebateSidebar component — vote dots, time, summary"
```

---

## Task 3: Create LevelDivider component

**Files:**
- Create: `dashboard/src/components/swarm/LevelDivider.tsx`

**Step 1: Create the component**

Create `dashboard/src/components/swarm/LevelDivider.tsx`:

```tsx
interface LevelDividerProps {
  level: number;
  label?: string;
}

export function LevelDivider({ level, label }: LevelDividerProps) {
  const labels: Record<number, string> = {
    1: 'Analysis',
    2: 'Critique',
    3: 'Revision',
    4: 'Deep Dive',
    5: 'Final Round',
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-zinc-800" />
      <span className="text-xs text-zinc-500 font-medium shrink-0">
        Level {level}: {label || labels[level] || `Round ${level}`}
      </span>
      <div className="flex-1 h-px bg-zinc-800" />
    </div>
  );
}
```

**Step 2: Verify build**

```bash
cd dashboard && npm run build
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/LevelDivider.tsx
git commit -m "feat(dashboard): add LevelDivider component"
```

---

## Task 4: Rewrite Swarm page with chat layout

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (full rewrite)

This task wires the three components from Tasks 1-3 into the Swarm page. Uses existing DB schema (`swarm_personas` without `phase`/`reply_to_id`) — all messages shown as Level 1 for now.

**Step 1: Rewrite Swarm.tsx**

Replace entire content of `dashboard/src/pages/Swarm.tsx`:

```tsx
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
  } catch { /* not JSON */ }
  return judgeResponse.slice(0, 60).replace(/\n/g, ' ') + '…';
}

export function Swarm() {
  const [debates, setDebates] = useState<DebateData[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const { data: judges } = await supabase
        .from('llm_conversations')
        .select('cycle_id, raw_response, created_at')
        .eq('method', 'swarm_consensus')
        .order('created_at', { ascending: false })
        .limit(30);
      if (!judges?.length) return;

      const result: DebateData[] = [];
      for (const j of judges) {
        const windowStart = new Date(new Date(j.created_at).getTime() - 600_000).toISOString();
        const windowEnd = new Date(new Date(j.created_at).getTime() + 600_000).toISOString();
        const { data: personas } = await supabase
          .from('swarm_personas')
          .select('persona, vote, confidence, reasoning, created_at')
          .gte('created_at', windowStart)
          .lte('created_at', windowEnd)
          .order('created_at', { ascending: true });

        const personaList = personas || [];
        const messages: SwarmMessage[] = [];

        // Persona messages (Level 1 for now — no phase column yet)
        for (const p of personaList) {
          messages.push({
            persona: p.persona,
            content: p.reasoning || '(no reasoning)',
            vote: p.vote,
            confidence: p.confidence,
            time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            phase: 1,
          });
        }

        // Judge verdict
        messages.push({
          persona: 'judge',
          content: j.raw_response || '(no verdict)',
          time: new Date(j.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isJudge: true,
          phase: 1,
        });

        result.push({
          cycleId: j.cycle_id,
          createdAt: j.created_at,
          votes: personaList.map((p) => ({ persona: p.persona, vote: p.vote })),
          summary: extractSummary(j.raw_response),
          messages,
        });
      }
      setDebates(result);
    };
    load();
  }, []);

  // Auto-scroll when switching debates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedIdx]);

  const current = debates[selectedIdx];

  // Group messages by phase for level dividers
  const renderMessages = () => {
    if (!current) return null;
    const msgs = current.messages;
    let lastPhase = 0;
    const elements: React.ReactNode[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const phase = m.phase ?? 1;
      if (phase !== lastPhase) {
        elements.push(<LevelDivider key={`lvl-${phase}`} level={phase} />);
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
          replyTo={m.replyTo}
        />
      );
    }
    return elements;
  };

  return (
    <div className="flex h-[calc(100vh-8rem)]">
      {/* Sidebar */}
      <DebateSidebar
        debates={debates.map((d) => ({
          cycleId: d.cycleId,
          createdAt: d.createdAt,
          votes: d.votes,
          summary: d.summary,
        }))}
        selectedIdx={selectedIdx}
        onSelect={setSelectedIdx}
      />

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="p-3 border-b border-zinc-800 flex items-center gap-3">
          <h1 className="text-sm font-bold text-zinc-300">Swarm Debate</h1>
          {current && (
            <span className="text-xs text-zinc-500">
              Cycle {current.cycleId} — {new Date(current.createdAt).toLocaleString()}
            </span>
          )}
        </div>

        {/* Messages */}
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

        {/* Superuser input placeholder (wired in Task 10) */}
        <div className="p-3 border-t border-zinc-800">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="Inject message as superuser (coming soon)..."
              disabled
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm opacity-50 cursor-not-allowed"
            />
            <button disabled className="bg-amber-600 opacity-50 cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium">
              👑 Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

```bash
cd dashboard && npm run build
```

**Step 3: Visual smoke test**

```bash
cd dashboard && npm run dev
```
Open http://localhost:5173/swarm — verify:
- Sidebar shows debate list with vote dots
- Clicking a debate shows chat messages with emoji avatars
- Judge message appears right-aligned
- Level 1 divider appears before messages

**Step 4: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): rewrite Swarm page — messenger-style chat with sidebar"
```

---

## Task 5: DB migration — add `phase` and `reply_to_id` to `swarm_personas`

**Files:**
- Modify: `src/db/types.ts:158-170` (add fields to DbSwarmPersona)
- Modify: `src/db/repository.ts:165-172` (update INSERT query)

**Step 1: Apply migration via Supabase MCP**

Run SQL:

```sql
ALTER TABLE swarm_personas ADD COLUMN IF NOT EXISTS phase INT DEFAULT 1;
ALTER TABLE swarm_personas ADD COLUMN IF NOT EXISTS reply_to_id INT REFERENCES swarm_personas(id);
CREATE INDEX IF NOT EXISTS idx_swarm_personas_phase ON swarm_personas(phase);
```

**Step 2: Update DbSwarmPersona type**

In `src/db/types.ts`, add two fields to `DbSwarmPersona` (after `tokens_out`, before `created_at`):

```typescript
  phase?: number;
  reply_to_id?: number;
```

**Step 3: Update insertSwarmPersona**

In `src/db/repository.ts`, update the INSERT query to include new columns:

```typescript
export async function insertSwarmPersona(p: Omit<DbSwarmPersona, 'id' | 'created_at'>): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO swarm_personas (conversation_id, persona, model, raw_response, vote, confidence, reasoning, tokens_in, tokens_out, phase, reply_to_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.conversation_id, p.persona, p.model, p.raw_response, p.vote,
     p.confidence, p.reasoning, p.tokens_in, p.tokens_out, p.phase ?? 1, p.reply_to_id ?? null],
  );
  return rows[0].id;
}
```

**Step 4: Verify existing tests pass**

```bash
npx vitest run tests/llm/swarm-agent.test.ts
```
Expected: ALL PASS (existing mock doesn't hit real DB)

**Step 5: Commit**

```bash
git add src/db/types.ts src/db/repository.ts
git commit -m "feat(db): add phase + reply_to_id columns to swarm_personas"
```

---

## Task 6: Redesign SwarmAgent — dynamic multi-level loop with Judge-as-moderator

**Files:**
- Modify: `src/llm/swarm-agent.ts` (major rewrite of getConsensus)
- Modify: `src/llm/prompts.ts` (add buildLevelJudgePrompt)
- Test: `tests/llm/swarm-agent.test.ts`

This is the biggest task. The current 3-stage hardcoded pipeline (generate → critique → revise) becomes a dynamic loop where the Judge decides after each level whether to continue and who speaks next.

**Step 1: Write failing tests for multi-level behavior**

Add to `tests/llm/swarm-agent.test.ts`:

```typescript
describe('multi-level debate', () => {
  const judgeStopResponse = JSON.stringify({
    continue: false,
    verdict: 'Consensus reached',
    decisions: [{ pair: 'BTCUSDT', action: 'HOLD', confidence: 70, reasoning: 'mixed' }],
    next_check_minutes: 15,
  });

  const judgeContinueResponse = JSON.stringify({
    continue: true,
    next_speakers: ['bull_thesis', 'devils_advocate'],
    verdict: 'Disagreement on direction',
    decisions: [],
    next_check_minutes: 15,
  });

  it('stops after Level 1 when Judge says continue=false', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
        return Promise.resolve(judgeStopResponse);
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // 3 experts + 1 judge = 4
    expect(mockLlm.call).toHaveBeenCalledTimes(4);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('HOLD');
  });

  it('continues to Level 2 when Judge says continue=true with selected speakers', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 3) return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
        if (callCount === 4) return Promise.resolve(judgeContinueResponse); // L1 judge: continue
        if (callCount <= 6) return Promise.resolve(makeStructuredResponse('expert', 'LONG', 70)); // L2 speakers
        return Promise.resolve(judgeStopResponse); // L2 judge: stop
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    const decisions = await agent.getConsensus(makeMinimalPromptData());

    // L1: 3 experts + 1 judge = 4
    // L2: 2 speakers + 1 judge = 3
    // Total: 7
    expect(mockLlm.call).toHaveBeenCalledTimes(7);
    expect(decisions).toHaveLength(1);
  });

  it('caps at 5 levels even if Judge always says continue', async () => {
    let callCount = 0;
    const mockLlm = {
      call: vi.fn().mockImplementation(() => {
        callCount++;
        // Every judge call returns continue=true except we cap at 5
        if (callCount % 4 === 0) {
          // Every 4th call is a judge — but the last one must have decisions
          if (callCount >= 20) return Promise.resolve(judgeStopResponse);
          return Promise.resolve(judgeContinueResponse);
        }
        return Promise.resolve(makeStructuredResponse('expert', 'HOLD', 60));
      }),
      lastNextCheckMinutes: undefined,
    } as any;

    const agent = new SwarmAgent(mockLlm);
    await agent.getConsensus(makeMinimalPromptData());

    // Should not exceed ~20 calls (5 levels × ~4 calls each)
    expect(mockLlm.call.mock.calls.length).toBeLessThanOrEqual(25);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/llm/swarm-agent.test.ts
```
Expected: FAIL — current code doesn't return `continue` field or handle multi-level

**Step 3: Add buildLevelJudgePrompt to prompts.ts**

Add at the end of `src/llm/prompts.ts`:

```typescript
export function buildLevelJudgePrompt(
  level: number,
  conversationHistory: Array<{ persona: string; content: string; vote?: string; phase: number }>,
  maxLevels: number = 5,
): string {
  const historyText = conversationHistory
    .map((m) => `[Level ${m.phase}] ${m.persona.toUpperCase()}${m.vote ? ` (${m.vote})` : ''}: ${m.content}`)
    .join('\n\n');

  const isLastLevel = level >= maxLevels;

  return `You are the SWARM CONSENSUS JUDGE managing a LIVE crypto futures account with real money.

You are reviewing Level ${level} of a multi-level debate. Max ${maxLevels} levels.

== FULL CONVERSATION HISTORY ==
${historyText}

== YOUR TASK ==
${isLastLevel
  ? 'This is the FINAL level. You MUST produce a final trading decision.'
  : `Decide whether the debate needs another round:
- If experts strongly disagree on direction → continue with targeted speakers
- If consensus is clear → stop and produce final decision
- If new risks were raised but not addressed → continue
- If arguments are just repeating → stop`}

You MUST respond with valid JSON:
{
  "continue": ${isLastLevel ? 'false' : 'true|false'},
  "next_speakers": ["persona_name", ...],  // only if continue=true — who should speak next
  "verdict": "<1-2 sentence summary of current state>",
  "decisions": [{"pair": "<pair>", "action": "LONG|SHORT|HOLD|CLOSE", "size_pct": <number>, "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "confidence": <0-100>, "reasoning": "<string>"}],
  "next_check_minutes": <1-30>
}

If continue=true, decisions can be empty [].
If continue=false, decisions MUST contain at least one entry.
If experts strongly disagree, lean towards HOLD.`;
}
```

**Step 4: Rewrite SwarmAgent.getConsensus with dynamic loop**

Replace the body of `getConsensus()` in `src/llm/swarm-agent.ts`. The key changes:

1. Level 1: ALL personas speak (same as before)
2. After each level: run Judge with `buildLevelJudgePrompt` passing full conversation history
3. Judge returns `{continue, next_speakers, verdict, decisions}`
4. If `continue=true` and `level < 5`: run Level N+1 with only `next_speakers`, passing ALL prior messages as context
5. If `continue=false` or `level >= 5`: return `decisions`
6. Store `phase=N` on each `insertSwarmPersona` call

The full replacement code:

```typescript
async getConsensus(data: EnrichedPromptData): Promise<TradeDecision[]> {
  // Fingerprint-based dedup
  const fp = buildSwarmFingerprint({
    positions: data.portfolio.positions.map(p => ({
      pair: p.pair, side: p.side, unrealizedPnlPct: p.unrealizedPnlPct,
    })),
    regime: data.regime ?? '',
    volumeRatio: data.snapshots[0]?.volumeRatio ?? 0,
    fearGreedValue: data.fearGreed?.value ?? 50,
  });

  const cacheExpired = Date.now() - this.lastDebateAt > SwarmAgent.DEBATE_TTL_MS;
  if (!hasChanged(this.lastFingerprint, fp) && this.lastDecisions.length > 0 && !cacheExpired) {
    console.log('[Swarm] Fingerprint unchanged — reusing previous consensus');
    return this.lastDecisions;
  }

  const userPrompt = buildUserPrompt(data);
  const MAX_LEVELS = 5;
  const conversationHistory: Array<{ persona: string; content: string; vote?: string; phase: number }> = [];
  const pendingPersonas: Array<{ persona: string; model: string; raw_response: string; vote?: string; confidence?: number; reasoning?: string; phase: number }> = [];

  // Initial personas
  const allPersonas: SwarmPersona[] = ['risk_manager', 'market_structure', 'devils_advocate'];
  if (this.grokLlm) allPersonas.push('narrative_expert');

  let finalDecisions: TradeDecision[] = [];

  for (let level = 1; level <= MAX_LEVELS; level++) {
    const speakers = level === 1
      ? allPersonas
      : (this as any)._nextSpeakers ?? allPersonas;

    console.log(`[Swarm] Level ${level}: ${speakers.join(', ')}`);

    // Build context including all prior messages for levels > 1
    const contextSuffix = level > 1
      ? '\n\n== PRIOR DEBATE MESSAGES ==\n' + conversationHistory
          .map(m => `[L${m.phase}] ${m.persona.toUpperCase()}${m.vote ? ` (${m.vote})` : ''}: ${m.content}`)
          .join('\n\n')
      : '';

    const expertCalls = speakers.map(p => {
      const isGrok = p === 'narrative_expert' && this.grokLlm;
      const llm = isGrok ? this.grokLlm : this.llm;
      const model = isGrok ? 'grok-4-1-fast-reasoning' : undefined;
      return llm.call(
        buildExpertSystemPrompt(p),
        userPrompt + contextSuffix,
        ...(model ? [model] : []),
      );
    });

    const results = await Promise.allSettled(expertCalls);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (res.status === 'fulfilled') {
        const eo = parseExpertOutput(res.value, speakers[i]);
        if (speakers[i] === 'narrative_expert') this.sourceHealth?.recordSuccess('grok-narrative');

        conversationHistory.push({
          persona: speakers[i],
          content: eo?.thesis || res.value.slice(0, 500),
          vote: eo?.position,
          phase: level,
        });

        if (this.sessionId) {
          pendingPersonas.push({
            persona: speakers[i],
            model: speakers[i] === 'narrative_expert' ? 'grok' : 'codex',
            raw_response: res.value,
            vote: eo?.position,
            confidence: eo?.confidence,
            reasoning: eo?.thesis || res.value.slice(0, 500),
            phase: level,
          });
        }
      } else {
        console.warn(`[Swarm] ${speakers[i]} failed at level ${level}:`, res.reason);
        if (speakers[i] === 'narrative_expert') this.sourceHealth?.recordFailure('grok-narrative', res.reason?.message ?? String(res.reason));
      }
    }

    if (conversationHistory.length === 0) {
      console.error('[Swarm] All sub-agents failed, aborting.');
      throw new Error('Swarm failure');
    }

    // Judge
    const judgePrompt = buildLevelJudgePrompt(level, conversationHistory, MAX_LEVELS);
    let rawJudge: string;
    try {
      rawJudge = await this.llm.call(judgePrompt, userPrompt);
    } catch (e) {
      console.error(`[Swarm] Judge failed at level ${level}:`, e);
      return [];
    }

    // Add judge to conversation history
    conversationHistory.push({
      persona: 'judge',
      content: rawJudge.slice(0, 500),
      phase: level,
    });

    // Parse judge response
    let judgeResult: any;
    try {
      judgeResult = JSON.parse(rawJudge);
    } catch {
      const match = rawJudge.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
      if (match) {
        try { judgeResult = JSON.parse(match[0]); } catch { /* */ }
      }
    }

    if (!judgeResult) {
      console.error(`[Swarm] Judge parse failed at level ${level}`);
      return [];
    }

    console.log(`[Swarm] Level ${level} Judge: continue=${judgeResult.continue}, verdict="${(judgeResult.verdict || '').slice(0, 80)}"`);

    // Store DB
    if (this.sessionId) {
      insertLlmConversation({
        cycle_id: this.cycleId,
        session_id: this.sessionId,
        layer: 1,
        model: 'codex',
        method: 'swarm_consensus',
        label: `judge_level_${level}`,
        system_prompt: judgePrompt,
        user_prompt: userPrompt,
        raw_response: rawJudge,
      }).then((convId) => {
        for (const pp of pendingPersonas.filter(p => p.phase === level)) {
          insertSwarmPersona({ ...pp, conversation_id: convId }).catch(() => {});
        }
      }).catch(() => {});
    }

    const ncm = judgeResult.next_check_minutes;
    if (typeof ncm === 'number' && Number.isFinite(ncm) && ncm >= 1 && ncm <= 30) {
      this.llm.lastNextCheckMinutes = ncm;
    }

    if (!judgeResult.continue || level >= MAX_LEVELS) {
      finalDecisions = judgeResult.decisions || [];
      break;
    }

    // Set next speakers for next iteration
    (this as any)._nextSpeakers = judgeResult.next_speakers?.length
      ? judgeResult.next_speakers.filter((s: string) => allPersonas.includes(s as any))
      : allPersonas;
  }

  this.lastFingerprint = fp;
  this.lastDecisions = finalDecisions;
  this.lastDebateAt = Date.now();
  return finalDecisions;
}
```

**Step 5: Add import for buildLevelJudgePrompt**

In `src/llm/swarm-agent.ts` line 3, add `buildLevelJudgePrompt` to the import:

```typescript
import { buildUserPrompt, type EnrichedPromptData, buildExpertSystemPrompt, buildCritiquePrompt, buildRevisePrompt, type SwarmPersona, type ExpertSummary, buildLevelJudgePrompt } from './prompts.js';
```

**Step 6: Run tests**

```bash
npx vitest run tests/llm/swarm-agent.test.ts
```

Existing tests will need adjusting because the Judge response format changed (now requires `continue` field). Update `consensusResponse` at the top of the test file:

```typescript
const consensusResponse = JSON.stringify({
  continue: false,
  verdict: 'Consensus reached',
  decisions: [{ pair: 'BTCUSDT', action: 'HOLD', confidence: 70, reasoning: 'mixed' }],
  next_check_minutes: 15,
});
```

Re-run and verify ALL PASS.

**Step 7: Commit**

```bash
git add src/llm/swarm-agent.ts src/llm/prompts.ts tests/llm/swarm-agent.test.ts
git commit -m "feat(swarm): dynamic multi-level debate loop with Judge-as-moderator (max 5 levels)"
```

---

## Task 7: Update frontend to show multi-level data from DB

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (update query to use `phase` column)

**Step 1: Update Supabase query to fetch `phase` and `reply_to_id`**

In `dashboard/src/pages/Swarm.tsx`, update the persona query to include `phase`:

Change:
```typescript
.select('persona, vote, confidence, reasoning, created_at')
```
To:
```typescript
.select('persona, vote, confidence, reasoning, created_at, phase, reply_to_id')
```

**Step 2: Update message building to group by phase**

Replace the message-building loop to use `phase` from DB (falling back to 1 if null):

```typescript
for (const p of personaList) {
  messages.push({
    persona: p.persona,
    content: p.reasoning || '(no reasoning)',
    vote: p.vote,
    confidence: p.confidence,
    time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    phase: p.phase ?? 1,
  });
}
```

**Step 3: Fetch multiple judge conversations (one per level)**

Replace the single judge query with one that fetches all judge conversations for a cycle, labeled by `label` field (`judge_level_1`, `judge_level_2`, etc.):

```typescript
// After fetching personas, also get all judge conversations for this cycle
const { data: judgeConvs } = await supabase
  .from('llm_conversations')
  .select('raw_response, created_at, label')
  .eq('cycle_id', j.cycle_id)
  .eq('method', 'swarm_consensus')
  .order('created_at', { ascending: true });

// Insert judge messages after each level's persona messages
const judgeByLevel = new Map<number, typeof judgeConvs>();
for (const jc of judgeConvs ?? []) {
  const levelMatch = jc.label?.match(/judge_level_(\d+)/);
  const level = levelMatch ? parseInt(levelMatch[1]) : 1;
  const arr = judgeByLevel.get(level) ?? [];
  arr.push(jc);
  judgeByLevel.set(level, arr);
}

// Build messages sorted by phase, with judge after each level
const maxPhase = Math.max(...personaList.map(p => p.phase ?? 1), 1);
for (let phase = 1; phase <= maxPhase; phase++) {
  const phasePersonas = personaList.filter(p => (p.phase ?? 1) === phase);
  for (const p of phasePersonas) {
    messages.push({
      persona: p.persona,
      content: p.reasoning || '(no reasoning)',
      vote: p.vote,
      confidence: p.confidence,
      time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      phase,
    });
  }
  // Judge for this level
  const judges = judgeByLevel.get(phase) ?? [];
  for (const jc of judges) {
    messages.push({
      persona: 'judge',
      content: jc.raw_response || '(no verdict)',
      time: new Date(jc.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isJudge: true,
      phase,
    });
  }
}
```

**Step 4: Verify build**

```bash
cd dashboard && npm run build
```

**Step 5: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): Swarm page reads phase column, shows multi-level judge verdicts"
```

---

## Task 8: Add superuser injection API endpoint

**Files:**
- Modify: `src/webhook/server.ts` (add `/api/swarm/inject` route)
- Modify: `src/db/repository.ts` (add `insertSuperuserMessage` helper)

**Step 1: Add insertSuperuserMessage to repository**

Add to `src/db/repository.ts`:

```typescript
export async function insertSuperuserMessage(cycleId: number, message: string, conversationId?: number): Promise<number> {
  const { rows } = await q().query(
    `INSERT INTO swarm_personas (conversation_id, persona, model, raw_response, vote, confidence, reasoning, phase)
     VALUES ($1, 'superuser', 'human', $2, NULL, NULL, $2, (
       SELECT COALESCE(MAX(phase), 0) + 1 FROM swarm_personas WHERE conversation_id = $1
     )) RETURNING id`,
    [conversationId, message],
  );
  return rows[0].id;
}
```

**Step 2: Add API route to webhook server**

In `src/webhook/server.ts`, add after the existing `/webhook` route:

```typescript
app.post('/api/swarm/inject', async (req, res) => {
  const { cycle_id, message } = req.body;
  if (!cycle_id || !message) {
    res.status(400).json({ error: 'Missing cycle_id or message' });
    return;
  }
  try {
    // Find latest conversation for this cycle
    const { insertSuperuserMessage } = await import('../db/repository.js');
    const id = await insertSuperuserMessage(cycle_id, message);
    res.json({ ok: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Add CORS header for dashboard:

```typescript
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
```

**Step 3: Verify bot builds**

```bash
npm run build
```

**Step 4: Commit**

```bash
git add src/webhook/server.ts src/db/repository.ts
git commit -m "feat(webhook): add /api/swarm/inject endpoint for superuser messages"
```

---

## Task 9: Wire superuser input in dashboard

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (enable input bar)

**Step 1: Add state and handler for superuser input**

In `Swarm.tsx`, replace the disabled input bar placeholder with a working one:

```tsx
const [superInput, setSuperInput] = useState('');
const [sending, setSending] = useState(false);

const sendSuperuserMessage = async () => {
  if (!superInput.trim() || !current || sending) return;
  setSending(true);
  try {
    const webhookUrl = import.meta.env.VITE_WEBHOOK_URL || 'http://localhost:3000';
    await fetch(`${webhookUrl}/api/swarm/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cycle_id: current.cycleId, message: superInput.trim() }),
    });
    // Optimistically add message to chat
    const now = new Date();
    const newMsg: SwarmMessage = {
      persona: 'superuser',
      content: superInput.trim(),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isSuperuser: true,
      phase: Math.max(...current.messages.map(m => m.phase ?? 1), 1),
    };
    setDebates(prev => prev.map((d, i) =>
      i === selectedIdx ? { ...d, messages: [...d.messages, newMsg] } : d
    ));
    setSuperInput('');
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  } catch (err) {
    console.error('Failed to inject superuser message:', err);
  }
  setSending(false);
};
```

Replace the disabled input section:

```tsx
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
```

Also add `isSuperuser` check in `SwarmChatMessage` rendering — already supported by the component from Task 1.

**Step 2: Add `VITE_WEBHOOK_URL` to `.env.local`**

The user needs to add `VITE_WEBHOOK_URL=http://localhost:3000` (or production URL) to `dashboard/.env.local`. Do NOT create `.env` files — just document it.

**Step 3: Verify build**

```bash
cd dashboard && npm run build
```

**Step 4: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): wire superuser input bar — inject messages into active debate"
```

---

## Task 10: Add `isSuperuser` display support in SwarmChatMessage

**Files:**
- Modify: `dashboard/src/components/swarm/SwarmChatMessage.tsx`
- Modify: `dashboard/src/pages/Swarm.tsx`

**Step 1: Update message rendering to handle superuser persona from DB**

In the Swarm page, when building messages from DB personas, check for `persona === 'superuser'`:

```typescript
if (p.persona === 'superuser') {
  messages.push({
    persona: 'superuser',
    content: p.reasoning || '(no message)',
    time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    isSuperuser: true,
    phase: p.phase ?? 1,
  });
} else {
  // existing persona message handling
}
```

This is already supported by SwarmChatMessage from Task 1 (gold accent styling for `isSuperuser`).

**Step 2: Verify build**

```bash
cd dashboard && npm run build
```

**Step 3: Final visual smoke test**

```bash
cd dashboard && npm run dev
```

Click through Swarm page:
- Sidebar shows debates with vote dots
- Chat shows messages with emoji avatars
- Judge messages right-aligned
- Level dividers between phases
- Superuser input bar at bottom (sends to API)

**Step 4: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx dashboard/src/components/swarm/SwarmChatMessage.tsx
git commit -m "feat(dashboard): handle superuser messages from DB in Swarm chat"
```

---

## Task Summary

| Task | What | Phase |
|------|------|-------|
| 1 | SwarmChatMessage component — emoji avatars, votes, reply quotes | Frontend |
| 2 | DebateSidebar component — vote dots, time, summary | Frontend |
| 3 | LevelDivider component | Frontend |
| 4 | Rewrite Swarm.tsx — sidebar + chat layout | Frontend |
| 5 | DB migration — `phase` + `reply_to_id` columns | DB |
| 6 | SwarmAgent dynamic multi-level loop + Judge-as-moderator | Backend |
| 7 | Frontend reads `phase`, shows multi-level judges | Frontend |
| 8 | Superuser injection API endpoint | Backend |
| 9 | Wire superuser input in dashboard | Frontend |
| 10 | Handle superuser messages from DB | Frontend |
