# Blackboard UI/UX Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken blackboard swarm UI — prompt returns structured decisions, UI uses inverted hierarchy (verdict first, signals board, compact votes).

**Architecture:** Two-part fix: (A) backend prompt changes so judge returns structured decisions and experts return sentence-level reasoning, (B) dashboard UI redesign replacing chat bubbles with a blackboard-first layout. Per-persona signals already exist in `swarm_personas.signals` column — just need to surface them.

**Tech Stack:** TypeScript, React, Tailwind CSS, Framer Motion, Supabase REST API

---

### Task 1: Fix judge prompt — structured decisions

**Files:**
- Modify: `src/llm/blackboard-prompts.ts:91-108`

**Step 1: Update `buildBlackboardJudgePrompt` output format**

Replace lines 106-107:

```typescript
  return `SWARM JUDGE. Round ${round}/${maxRounds}.

BLACKBOARD STATE:
${stateJson}

VOTE SUMMARY: ${voteSummary}

CONFLICT COUNT: ${totalConflicts} (high: ${highConflicts})

DECISION RULES:
- 3+ same direction AND no high-severity conflicts -> stop
- High-severity conflict AND round < max -> continue, next_speakers
- Risk Manager critical + DA agrees -> HOLD/CLOSE
- If final round, MUST produce decision

OUTPUT (JSON only):
{"continue": true|false, "verdict": "<1-sentence summary>", "next_speakers": ["CODE"], "decisions": [{"pair": "<PAIR>", "action": "HOLD|LONG|SHORT|CLOSE", "confidence": <0-100>, "reasoning": "<1-sentence>", "leverage": <number>, "stop_loss_pct": <number>, "take_profit_pct": <number>, "size_pct": <number>}], "next_check_minutes": <1-30>}

RULES:
- decisions array: one object per pair from the blackboard market.pairs list.
- For HOLD: leverage, stop_loss_pct, take_profit_pct, size_pct = 0.
- verdict: human-readable sentence, not a slug.`;
```

**Step 2: Run bot locally to verify prompt compiles**

Run: `npx tsx --eval "import { buildBlackboardJudgePrompt } from './src/llm/blackboard-prompts.js'; console.log('OK')"`
Expected: OK (no import errors)

**Step 3: Commit**

```bash
git add src/llm/blackboard-prompts.ts
git commit -m "fix(swarm): judge prompt requires structured decisions with pair/action/confidence"
```

---

### Task 2: Fix expert prompt — sentence reasoning

**Files:**
- Modify: `src/llm/blackboard-prompts.ts:50-69`

**Step 1: Update `buildBlackboardExpertPrompt` output format and rules**

Replace the OUTPUT and RULES section (lines 58-69):

```typescript
  return `ROLE: ${role}
CODE: ${code}

BLACKBOARD STATE:
${stateJson}

Read the blackboard. Analyze the market data provided separately. Write YOUR section update.

OUTPUT (JSON only):
{
  "signals": { "bullish": ["tag1"], "bearish": ["tag2"], "neutral": [] },
  "vote": { "d": "HOLD|LONG|SHORT|CLOSE", "c": <0-100>, "prob": <0-100>, "reason": "<1-2 sentence explanation>" },
  "risks": ["risk_tag"],
  "conflicts_with": { "<CODE>": "<reason_slug>" }
}

RULES:
- signals: short tags, max 5 words per tag.
- vote.reason: 1-2 full sentences explaining your position. NOT a slug.
- risks: short tags.
- conflicts_with: reference persona CODEs you disagree with. Empty {} if no conflict.
- ONLY valid JSON.`;
```

**Step 2: Commit**

```bash
git add src/llm/blackboard-prompts.ts
git commit -m "fix(swarm): expert prompt requires sentence-level reasoning instead of slugs"
```

---

### Task 3: Deploy prompt fixes (hotfix)

**Step 1: Deploy to production**

```bash
npm run deploy
```

**Step 2: Verify in pm2 logs that next swarm cycle produces structured judge output**

```bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 "pm2 logs indic-bot --lines 50"
```

Look for `[Swarm] Round 1 Judge:` with structured decisions.

---

### Task 4: Fix sidebar extractSummary

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx:40-51`

**Step 1: Update `extractSummary` to handle both string and object decisions**

Replace the function:

```typescript
function extractSummary(judgeResponse?: string): string {
  if (!judgeResponse) return 'No verdict';
  try {
    const parsed = JSON.parse(judgeResponse);
    // New blackboard format: decisions can be strings or objects
    if (parsed.decisions?.[0]) {
      const d = parsed.decisions[0];
      if (typeof d === 'string') {
        // Blackboard format: ["HOLD", "SHORT"]
        const actions = parsed.decisions as string[];
        const unique = [...new Set(actions)];
        const conf = Object.values(parsed.votes ?? {}).reduce(
          (acc: number, v: any) => acc + (v?.c ?? 0), 0
        ) / Math.max(Object.keys(parsed.votes ?? {}).length, 1);
        return `${unique.join('/')} conf:${Math.round(conf) || '?'}`;
      }
      // Legacy format: [{pair, action, confidence}]
      return `${d.action} ${d.pair ?? ''} conf:${d.confidence ?? '?'}`;
    }
    if (parsed.verdict) return parsed.verdict.slice(0, 60);
  } catch { /* not JSON */ }
  return judgeResponse.slice(0, 60).replace(/\n/g, ' ') + '\u2026';
}
```

**Step 2: Verify in browser — sidebar should show proper summaries**

Run: `cd dashboard && npm run dev`
Check sidebar entries no longer show "undefined conf:?"

**Step 3: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "fix(dashboard): extractSummary handles blackboard string decisions"
```

---

### Task 5: Create VerdictBar component

**Files:**
- Create: `dashboard/src/components/swarm/VerdictBar.tsx`

**Step 1: Create the component**

```tsx
import { VOTE_COLORS } from '../../lib/theme';

interface VerdictBarProps {
  rawResponse: string;
  isIntermediate?: boolean;
}

interface ParsedVerdict {
  action: string;
  pair?: string;
  confidence?: number;
  reasoning?: string;
  verdict?: string;
  nextCheck?: number;
  continues?: boolean;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  sizePct?: number;
}

function parseVerdict(raw: string): ParsedVerdict | null {
  try {
    const parsed = JSON.parse(raw);
    const d = parsed.decisions?.[0];
    if (typeof d === 'string') {
      return {
        action: d,
        verdict: parsed.verdict,
        nextCheck: parsed.next_check_minutes,
        continues: parsed.continue,
      };
    }
    if (d?.action) {
      return {
        action: d.action,
        pair: d.pair,
        confidence: d.confidence,
        reasoning: d.reasoning,
        verdict: parsed.verdict,
        nextCheck: parsed.next_check_minutes,
        continues: parsed.continue,
        leverage: d.leverage,
        stopLoss: d.stop_loss_pct,
        takeProfit: d.take_profit_pct,
        sizePct: d.size_pct,
      };
    }
    if (parsed.verdict) {
      return { action: 'HOLD', verdict: parsed.verdict, nextCheck: parsed.next_check_minutes, continues: parsed.continue };
    }
  } catch { /* */ }
  return null;
}

export function VerdictBar({ rawResponse, isIntermediate }: VerdictBarProps) {
  const v = parseVerdict(rawResponse);
  if (!v) return null;

  const color = VOTE_COLORS[v.action] ?? '#71717a';
  const showParams = v.action !== 'HOLD' && (v.leverage || v.stopLoss || v.takeProfit);

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ borderColor: `${color}30`, backgroundColor: `${color}08` }}
    >
      {!isIntermediate && <div className="h-0.5" style={{ backgroundColor: color }} />}
      <div className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isIntermediate && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-mono">CONTINUE</span>
            )}
            <span className="text-2xl font-mono font-bold" style={{ color }}>{v.action}</span>
            {v.pair && <span className="text-lg font-mono text-zinc-300">{v.pair}</span>}
            {v.confidence != null && v.confidence > 0 && (
              <span className="text-sm font-mono text-zinc-500">conf:{v.confidence}</span>
            )}
          </div>
          {v.nextCheck && (
            <span className="text-[10px] text-zinc-600 font-mono">next: {v.nextCheck} min</span>
          )}
        </div>

        {showParams && (
          <div className="flex gap-4 mt-2 text-xs font-mono text-zinc-500">
            {v.leverage ? <span>Lev: {v.leverage}x</span> : null}
            {v.sizePct ? <span>Size: {v.sizePct}%</span> : null}
            {v.stopLoss ? <span>SL: {v.stopLoss}%</span> : null}
            {v.takeProfit ? <span>TP: {v.takeProfit}%</span> : null}
          </div>
        )}

        {v.reasoning && (
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">{v.reasoning}</p>
        )}
        {v.verdict && !v.reasoning && (
          <p className="text-xs text-zinc-500 mt-1 font-mono">{v.verdict.replace(/_/g, ' ')}</p>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/VerdictBar.tsx
git commit -m "feat(dashboard): VerdictBar component — verdict first with structured display"
```

---

### Task 6: Create VoteRow component

**Files:**
- Create: `dashboard/src/components/swarm/VoteRow.tsx`

**Step 1: Create the component**

```tsx
import { getPersona, VOTE_COLORS } from '../../lib/theme';

interface VoteItem {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  conflictsWith?: Record<string, string> | null;
}

interface VoteRowProps {
  votes: VoteItem[];
}

export function VoteRow({ votes }: VoteRowProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {votes.map((v) => {
        const p = getPersona(v.persona);
        const color = VOTE_COLORS[v.vote ?? 'HOLD'] ?? '#71717a';
        const hasConflict = v.conflictsWith && Object.keys(v.conflictsWith).length > 0;

        return (
          <div
            key={v.persona}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2 border border-border-subtle group relative"
          >
            <span className="text-sm" title={p.label}>{p.emoji}</span>
            <span className="text-[11px] font-semibold text-zinc-400">{p.label}</span>
            <span
              className="text-[10px] font-mono font-bold px-1.5 py-px rounded"
              style={{ color, backgroundColor: `${color}15` }}
            >
              {v.vote ?? 'N/A'}
            </span>
            {v.confidence != null && (
              <span className="text-[10px] text-zinc-600 font-mono">{v.confidence}%</span>
            )}
            {hasConflict && (
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" title={`Conflicts: ${Object.keys(v.conflictsWith!).join(', ')}`} />
            )}

            {/* Tooltip with reasoning on hover */}
            <div className="absolute bottom-full left-0 mb-2 hidden group-hover:block z-10 max-w-xs">
              <div className="bg-surface-3 border border-border rounded-lg px-3 py-2 text-[11px] text-zinc-400 shadow-lg">
                {v.reasoning.replace(/_/g, ' ')}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/VoteRow.tsx
git commit -m "feat(dashboard): VoteRow component — compact persona votes with hover tooltip"
```

---

### Task 7: Create SignalBoard component

**Files:**
- Create: `dashboard/src/components/swarm/SignalBoard.tsx`

**Step 1: Create the component**

```tsx
import { getPersona } from '../../lib/theme';

interface PerPersonaSignals {
  persona: string;
  signals: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
}

interface SignalBoardProps {
  personaSignals: PerPersonaSignals[];
  risks: string[];
}

interface AttributedSignal {
  text: string;
  personas: string[];
}

function aggregateSignals(personaSignals: PerPersonaSignals[], type: 'bullish' | 'bearish' | 'neutral'): AttributedSignal[] {
  const map = new Map<string, string[]>();
  for (const ps of personaSignals) {
    for (const sig of ps.signals[type] ?? []) {
      const normalized = sig.toLowerCase().replace(/_/g, ' ');
      const existing = map.get(normalized) ?? [];
      existing.push(ps.persona);
      map.set(normalized, existing);
    }
  }
  // Sort by number of personas (most agreement first)
  return Array.from(map.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .map(([text, personas]) => ({ text, personas }));
}

function SignalTag({ signal, color, bgColor }: { signal: AttributedSignal; color: string; bgColor: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-mono" style={{ color, backgroundColor: bgColor }}>
      {signal.text}
      {signal.personas.map(p => (
        <span key={p} className="text-[9px] opacity-70" title={getPersona(p).label}>
          {getPersona(p).emoji}
        </span>
      ))}
    </span>
  );
}

export function SignalBoard({ personaSignals, risks }: SignalBoardProps) {
  const bullish = aggregateSignals(personaSignals, 'bullish');
  const bearish = aggregateSignals(personaSignals, 'bearish');

  if (bullish.length === 0 && bearish.length === 0 && risks.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
      <div className="grid grid-cols-2 divide-x divide-border">
        {/* Bullish column */}
        <div className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-green-500/60 mb-2">
            Bullish ({bullish.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bullish.map(s => (
              <SignalTag key={s.text} signal={s} color="#4ade80" bgColor="rgba(74,222,128,0.1)" />
            ))}
          </div>
        </div>

        {/* Bearish column */}
        <div className="p-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-red-500/60 mb-2">
            Bearish ({bearish.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {bearish.map(s => (
              <SignalTag key={s.text} signal={s} color="#f87171" bgColor="rgba(248,113,113,0.1)" />
            ))}
          </div>
        </div>
      </div>

      {/* Risks bar */}
      {risks.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-yellow-500/60">Risks</span>
            {risks.map(r => (
              <span key={r} className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-900/20 text-yellow-500/80 font-mono">
                {r.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/SignalBoard.tsx
git commit -m "feat(dashboard): SignalBoard component — 2-column bullish/bearish with persona attribution"
```

---

### Task 8: Create BlackboardView and wire into RoundSection

**Files:**
- Create: `dashboard/src/components/swarm/BlackboardView.tsx`
- Modify: `dashboard/src/components/swarm/RoundSection.tsx`

**Step 1: Create BlackboardView**

```tsx
import { motion } from 'framer-motion';
import { VerdictBar } from './VerdictBar';
import { VoteRow } from './VoteRow';
import { SignalBoard } from './SignalBoard';

interface BlackboardPersona {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  conflictsWith?: Record<string, string> | null;
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
  time?: string;
}

interface BlackboardViewProps {
  round: number;
  personas: BlackboardPersona[];
  judgeRawResponse?: string;
  isFinalRound: boolean;
  risks: string[];
}

const ROUND_LABELS: Record<number, string> = { 1: 'Analysis', 2: 'Conflict Resolution', 3: 'Deep Dive', 4: 'Final Round' };

export function BlackboardView({ round, personas, judgeRawResponse, isFinalRound, risks }: BlackboardViewProps) {
  const personaSignals = personas
    .filter(p => p.signals)
    .map(p => ({ persona: p.persona, signals: p.signals! }));

  return (
    <div className="space-y-3">
      {/* Round divider */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 py-1">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-surface-3 border border-border flex items-center justify-center">
            <span className="text-[9px] font-mono font-bold text-accent">{round}</span>
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            {ROUND_LABELS[round] ?? `Round ${round}`}
          </span>
        </div>
        <div className="flex-1 h-px bg-border" />
      </motion.div>

      {/* 1. Verdict FIRST */}
      {judgeRawResponse && (
        <VerdictBar rawResponse={judgeRawResponse} isIntermediate={!isFinalRound} />
      )}

      {/* 2. Compact votes */}
      <VoteRow votes={personas} />

      {/* 3. Signal board with persona attribution */}
      <SignalBoard personaSignals={personaSignals} risks={risks} />
    </div>
  );
}
```

**Step 2: Rewrite RoundSection to use BlackboardView**

Replace `dashboard/src/components/swarm/RoundSection.tsx`:

```tsx
import { BlackboardView } from './BlackboardView';

interface RoundPersona {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
  time?: string;
  signals?: { bullish?: string[]; bearish?: string[]; neutral?: string[] };
}

interface RoundSectionProps {
  round: number;
  personas: RoundPersona[];
  judgeRawResponse?: string;
  isFinalRound: boolean;
  blackboardSignals?: { bullish: string[]; bearish: string[]; neutral: string[] };
  blackboardRisks?: string[];
}

export function RoundSection({ round, personas, judgeRawResponse, isFinalRound, blackboardRisks }: RoundSectionProps) {
  return (
    <BlackboardView
      round={round}
      personas={personas}
      judgeRawResponse={judgeRawResponse}
      isFinalRound={isFinalRound}
      risks={blackboardRisks ?? []}
    />
  );
}
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/BlackboardView.tsx dashboard/src/components/swarm/RoundSection.tsx
git commit -m "feat(dashboard): BlackboardView — inverted hierarchy layout (verdict > votes > signals)"
```

---

### Task 9: Wire per-persona signals in Swarm.tsx

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx:167-172` (loadDetail query)
- Modify: `dashboard/src/pages/Swarm.tsx:199-216` (message building)
- Modify: `dashboard/src/pages/Swarm.tsx:309-321` (getRounds — pass signals)

**Step 1: The `swarm_personas` query already fetches `signals`** (line 171). Just need to pass it through.

Update the message building (around line 211) to include signals on SwarmMessage:

Add `signals` to the `SwarmMessage` interface (line 18):

```typescript
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
```

Update persona message push (around line 211-216):

```typescript
          messages.push({
            persona: p.persona, content: p.reasoning || '(no reasoning)',
            vote: p.vote, confidence: p.confidence,
            time: new Date(p.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            phase, conflictsWith: p.conflicts_with as Record<string, string> | null,
            signals: p.signals as { bullish?: string[]; bearish?: string[]; neutral?: string[] } | null,
          });
```

Update `getRounds` (around line 313) to pass signals:

```typescript
          personas: data.personas.map(p => ({
            persona: p.persona,
            vote: p.vote ?? null,
            confidence: p.confidence ?? null,
            reasoning: p.content,
            probability: null,
            conflictsWith: p.conflictsWith ?? null,
            time: p.time,
            signals: p.signals ?? undefined,
          })),
```

**Step 2: Verify in browser — signals should appear attributed to personas**

**Step 3: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): pass per-persona signals through to BlackboardView"
```

---

### Task 10: Clean up old components

**Files:**
- Delete: `dashboard/src/components/swarm/PersonaVoteCard.tsx`
- Delete: `dashboard/src/components/swarm/JudgeVerdictCard.tsx`

**Step 1: Verify no other files import these components**

```bash
grep -r "PersonaVoteCard\|JudgeVerdictCard" dashboard/src/ --include="*.tsx" --include="*.ts"
```

Expected: only `RoundSection.tsx` (already rewritten) and the files themselves.

**Step 2: Delete old components**

```bash
rm dashboard/src/components/swarm/PersonaVoteCard.tsx
rm dashboard/src/components/swarm/JudgeVerdictCard.tsx
```

**Step 3: Build dashboard to verify no broken imports**

```bash
cd dashboard && npm run build
```

Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add -A dashboard/src/components/swarm/
git commit -m "refactor(dashboard): remove PersonaVoteCard and JudgeVerdictCard (replaced by BlackboardView)"
```

---

### Task 11: Visual verification and final commit

**Step 1: Run dashboard dev server**

```bash
cd dashboard && npm run dev
```

**Step 2: Check these scenarios:**
- Sidebar: no more "undefined conf:?" entries
- New blackboard cycles (#292+): VerdictBar at top, VoteRow compact, SignalBoard 2-column with persona emojis, RiskBar
- Old legacy cycles (#129 and earlier): still render (graceful fallback — signals may be empty but layout works)
- Multi-round debates: each round has its own BlackboardView

**Step 3: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "feat(dashboard): blackboard UI redesign complete — inverted hierarchy"
```
