# Dashboard "Engine Bay" Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign Overview + Swarm pages and main framework with premium "Bentley engine bay" aesthetic — showcase, not debugger.

**Architecture:** Replace generic zinc Tailwind with custom palette + Google Fonts. Swarm page transforms from chat-bubbles to persona card grid with blackboard as central element. Input context (what AI saw) shown at top. Judge verdict parsed, not raw JSON. Copy-to-clipboard for analysis.

**Tech Stack:** React 19, Tailwind 4, framer-motion 12, Supabase JS, Google Fonts (JetBrains Mono + DM Sans)

---

## Data context

**Supabase tables used:**
- `llm_conversations` — `cycle_id, created_at, label, user_prompt, raw_response, blackboard_state, method`
- `swarm_personas` — `persona, vote, confidence, reasoning, phase, conflicts_with, signals, created_at`
- `cycles`, `market_snapshots`, `errors`, `trade_executions`, `trade_closes`

**BlackboardState shape** (from `blackboard_state` JSONB column):
```ts
{
  market: { pairs: string[], regime: string, fearGreed: number, volumeRatio: number },
  signals: { bullish: string[], bearish: string[], neutral: string[] },
  votes: Record<string, { d: "HOLD"|"LONG"|"SHORT"|"CLOSE", c: number, prob: number, reason: string }>,
  risks: string[],
  conflicts: Array<{ between: [string, string], topic: string, severity: "low"|"medium"|"high" }>
}
```

**Persona codes:** RM (risk_manager), BT (bull_thesis), BA (bear_thesis), MS (market_structure), DA (devils_advocate), NE (narrative_expert)

**Persona colors (keep):** bull=#4ade80, bear=#f87171, risk=#eab308, structure=#60a5fa, devils=#a78bfa, narrative=#fb923c, judge=#e2e8f0, superuser=#f59e0b

---

## Task 1: Fonts + palette + CSS foundation

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/src/index.css`

**Step 1: Add Google Fonts to index.html**

In `<head>`, add before `</head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

Also update `<title>` to `Indic Bot`.

**Step 2: Add CSS custom properties and base styles to index.css**

Replace contents of `index.css` with:
```css
@import "tailwindcss";

@theme {
  --font-sans: 'DM Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  --color-surface-0: #08080d;
  --color-surface-1: #0f0f16;
  --color-surface-2: #16161f;
  --color-surface-3: #1e1e2a;
  --color-border: #252535;
  --color-border-subtle: #1a1a28;

  --color-accent: #c8a2ff;
  --color-accent-dim: #c8a2ff33;
  --color-bull: #4ade80;
  --color-bear: #f87171;
  --color-risk: #eab308;
  --color-structure: #60a5fa;
  --color-devils: #a78bfa;
  --color-narrative: #fb923c;
  --color-judge: #e2e8f0;
  --color-superuser: #f59e0b;
}

body {
  font-family: var(--font-sans);
  background: var(--color-surface-0);
  color: #e4e4ed;
  -webkit-font-smoothing: antialiased;
}
```

**Step 3: Verify** — run `cd dashboard && npm run dev`, check fonts load, background is darker than before.

**Step 4: Commit**
```bash
git add dashboard/index.html dashboard/src/index.css
git commit -m "feat(dashboard): add DM Sans + JetBrains Mono, custom palette CSS vars"
```

---

## Task 2: Shared theme config

**Files:**
- Create: `dashboard/src/lib/theme.ts`

**Step 1: Create theme constants**

```ts
export const PERSONA_CONFIG = {
  bull_thesis:      { code: 'BT', label: 'Bull Thesis',      emoji: '\u{1F402}', color: '#4ade80' },
  bear_thesis:      { code: 'BA', label: 'Bear Thesis',      emoji: '\u{1F43B}', color: '#f87171' },
  risk_manager:     { code: 'RM', label: 'Risk Manager',     emoji: '\u{1F6E1}\uFE0F', color: '#eab308' },
  market_structure: { code: 'MS', label: 'Market Structure',  emoji: '\u{1F52C}', color: '#60a5fa' },
  devils_advocate:  { code: 'DA', label: "Devil's Advocate",  emoji: '\u{1F608}', color: '#a78bfa' },
  narrative_expert: { code: 'NE', label: 'Narrative Expert',  emoji: '\u{1F4F0}', color: '#fb923c' },
  judge:            { code: 'JG', label: 'Judge',             emoji: '\u{2696}\uFE0F', color: '#e2e8f0' },
  superuser:        { code: 'SU', label: 'Superuser',         emoji: '\u{1F451}', color: '#f59e0b' },
} as const;

export type PersonaKey = keyof typeof PERSONA_CONFIG;

export const VOTE_COLORS: Record<string, string> = {
  LONG:  '#4ade80',
  SHORT: '#f87171',
  HOLD:  '#71717a',
  CLOSE: '#eab308',
};

export function getPersona(name: string) {
  return PERSONA_CONFIG[name as PersonaKey] ?? { code: name.slice(0, 2).toUpperCase(), label: name.replace(/_/g, ' '), emoji: '\u{1F916}', color: '#a1a1aa' };
}
```

**Step 2: Commit**
```bash
git add dashboard/src/lib/theme.ts
git commit -m "feat(dashboard): shared persona/vote theme config"
```

---

## Task 3: Navigation redesign

**Files:**
- Modify: `dashboard/src/App.tsx`

**Step 1: Rewrite App.tsx navigation**

Replace the `<nav>` block with premium styled navigation:
- Background: `bg-[var(--color-surface-1)]`
- Logo: "Indic" in `font-mono font-bold text-[var(--color-accent)]` with small "Bot" label
- Active tab: bottom border accent, not bg highlight
- All page wrappers: `bg-[var(--color-surface-0)]` instead of `bg-zinc-950`
- Main container max-w stays `max-w-7xl`

Key changes:
```tsx
<nav className="border-b border-[var(--color-border)] px-6 py-3 flex items-center gap-1">
  <span className="font-mono font-bold text-[var(--color-accent)] text-base mr-6 tracking-tight">
    Indic<span className="text-zinc-500 font-normal text-xs ml-1">bot</span>
  </span>
  {navItems.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      className={({ isActive }) =>
        `text-sm px-3 py-1.5 border-b-2 transition-colors ${
          isActive
            ? 'border-[var(--color-accent)] text-white'
            : 'border-transparent text-zinc-500 hover:text-zinc-300'
        }`
      }
    >
      {item.label}
    </NavLink>
  ))}
</nav>
<main className="max-w-7xl mx-auto p-6">
```

Body wrapper: `<div className="min-h-screen bg-[var(--color-surface-0)] text-[#e4e4ed]">`

**Step 2: Verify** — nav renders with accent underline on active tab, logo has purple accent.

**Step 3: Commit**
```bash
git add dashboard/src/App.tsx
git commit -m "feat(dashboard): premium navigation with accent underlines"
```

---

## Task 4: Overview page polish

**Files:**
- Modify: `dashboard/src/components/StatCard.tsx`
- Modify: `dashboard/src/components/PnlHeader.tsx`
- Modify: `dashboard/src/pages/Overview.tsx`

**Step 1: Update StatCard to new palette**

Replace `bg-zinc-900` with `bg-[var(--color-surface-1)]`, border with `border-[var(--color-border)]`. Font for value: `font-mono`.

**Step 2: Update PnlHeader to new palette**

Same surface/border swap. Add subtle top gradient:
```tsx
<div className="bg-[var(--color-surface-1)] rounded-xl border border-[var(--color-border)] p-5 relative overflow-hidden">
  <div className="absolute inset-0 bg-gradient-to-br from-[var(--color-accent-dim)] to-transparent pointer-events-none" />
  <div className="relative"> {/* ...existing content... */} </div>
</div>
```

**Step 3: Update Overview page**

Replace all `bg-zinc-900 border-zinc-800` with `bg-[var(--color-surface-1)] border-[var(--color-border)]`.
Update heading font: `text-xl font-semibold`.

**Step 4: Verify** — Overview renders with new colors, subtle gradient on PnL header.

**Step 5: Commit**
```bash
git add dashboard/src/components/StatCard.tsx dashboard/src/components/PnlHeader.tsx dashboard/src/pages/Overview.tsx
git commit -m "feat(dashboard): Overview page polish with new palette"
```

---

## Task 5: Swarm — InputContextCard

**Files:**
- Create: `dashboard/src/components/swarm/InputContextCard.tsx`

**Step 1: Create component**

Parses the `user_prompt` string from `llm_conversations` and displays key info. The user_prompt contains structured text sections:
- `Current time:`, `Session P&L:`, `Risk status:`, `Last order:`
- `## Recent Decisions` section
- Market data sections

```tsx
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface InputContextCardProps {
  userPrompt: string;
  pair: string;
  regime: string;
  fearGreed: number;
  volumeRatio: number;
}

function extractField(text: string, field: string): string {
  const re = new RegExp(`${field}:\\s*(.+?)(?:\\n|\\\\n|$)`);
  const m = text.match(re);
  return m?.[1]?.trim() ?? '—';
}

export function InputContextCard({ userPrompt, pair, regime, fearGreed, volumeRatio }: InputContextCardProps) {
  const [expanded, setExpanded] = useState(false);

  const sessionPnl = extractField(userPrompt, 'Session P&L');
  const riskStatus = extractField(userPrompt, 'Risk status');
  const time = extractField(userPrompt, 'Current time');
  const lastOrder = extractField(userPrompt, 'Last order');

  return (
    <div className="bg-[var(--color-surface-1)] rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Input Context
          </h3>
          <span className="text-[10px] text-zinc-600 font-mono">{time}</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Pair', value: pair, color: 'text-white' },
            { label: 'Regime', value: regime, color: 'text-[var(--color-accent)]' },
            { label: 'F&G', value: String(fearGreed), color: fearGreed < 25 ? 'text-red-400' : fearGreed > 60 ? 'text-green-400' : 'text-yellow-400' },
            { label: 'Volume', value: `${volumeRatio.toFixed(2)}x`, color: volumeRatio > 1.5 ? 'text-green-400' : 'text-zinc-300' },
            { label: 'Session', value: sessionPnl, color: sessionPnl.includes('-') ? 'text-red-400' : 'text-green-400' },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wide">{label}</div>
              <div className={`text-sm font-mono font-semibold ${color}`}>{value}</div>
            </div>
          ))}
        </div>

        {lastOrder !== '—' && (
          <div className="mt-3 text-xs text-zinc-500 font-mono truncate">
            Last: {lastOrder}
          </div>
        )}
      </div>

      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-5 py-2 text-[10px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400 border-t border-[var(--color-border-subtle)] transition-colors text-left"
      >
        {expanded ? 'Hide full prompt' : 'Show full prompt'}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <pre className="px-5 pb-4 text-[11px] text-zinc-500 font-mono whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">
              {userPrompt}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

**Step 2: Verify** — import in Swarm.tsx temporarily, pass mock data, check rendering.

**Step 3: Commit**
```bash
git add dashboard/src/components/swarm/InputContextCard.tsx
git commit -m "feat(dashboard): InputContextCard — parsed market context display"
```

---

## Task 6: Swarm — PersonaVoteCard

**Files:**
- Create: `dashboard/src/components/swarm/PersonaVoteCard.tsx`

**Step 1: Create component**

Each persona is a card in a grid — like a polished engine component.

```tsx
import { useState } from 'react';
import { motion } from 'framer-motion';
import { getPersona, VOTE_COLORS } from '../../lib/theme';

interface PersonaVoteCardProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
}

export function PersonaVoteCard({ persona, vote, confidence, reasoning, probability, conflictsWith }: PersonaVoteCardProps) {
  const [expanded, setExpanded] = useState(false);
  const p = getPersona(persona);
  const voteColor = VOTE_COLORS[vote ?? 'HOLD'] ?? '#71717a';
  const confPct = confidence ?? 0;
  const hasConflicts = conflictsWith && Object.keys(conflictsWith).length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] overflow-hidden hover:border-[color:var(--hover-color)] transition-colors cursor-pointer"
      style={{ '--hover-color': `${p.color}44` } as React.CSSProperties}
      onClick={() => setExpanded(e => !e)}
    >
      {/* Top accent line */}
      <div className="h-0.5" style={{ background: p.color }} />

      <div className="p-3">
        {/* Header: emoji + name + vote badge */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-base" title={p.label}>{p.emoji}</span>
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: p.color }}>
              {p.code}
            </span>
          </div>
          {vote && (
            <span
              className="text-xs font-mono font-bold px-2 py-0.5 rounded"
              style={{ color: voteColor, backgroundColor: `${voteColor}18` }}
            >
              {vote}
            </span>
          )}
        </div>

        {/* Confidence bar */}
        {confidence != null && (
          <div className="mb-2">
            <div className="flex justify-between text-[10px] text-zinc-600 mb-0.5">
              <span>Confidence</span>
              <span className="font-mono">{confPct}%</span>
            </div>
            <div className="h-1 rounded-full bg-[var(--color-surface-0)] overflow-hidden">
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: p.color }}
                initial={{ width: 0 }}
                animate={{ width: `${confPct}%` }}
                transition={{ duration: 0.5, delay: 0.1 }}
              />
            </div>
          </div>
        )}

        {/* Probability */}
        {probability != null && (
          <div className="flex justify-between text-[10px] text-zinc-600 mb-2">
            <span>Probability</span>
            <span className="font-mono">{probability}%</span>
          </div>
        )}

        {/* Conflict indicator */}
        {hasConflicts && (
          <div className="flex items-center gap-1 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-[10px] text-amber-500/80">
              Conflicts: {Object.keys(conflictsWith!).join(', ')}
            </span>
          </div>
        )}

        {/* Reasoning — truncated or full */}
        <p className={`text-xs text-zinc-400 leading-relaxed ${expanded ? '' : 'line-clamp-2'}`}>
          {reasoning}
        </p>
      </div>
    </motion.div>
  );
}
```

**Step 2: Commit**
```bash
git add dashboard/src/components/swarm/PersonaVoteCard.tsx
git commit -m "feat(dashboard): PersonaVoteCard — polished persona card with confidence bar"
```

---

## Task 7: Swarm — JudgeVerdictCard

**Files:**
- Create: `dashboard/src/components/swarm/JudgeVerdictCard.tsx`

**Step 1: Create component**

Parses raw JSON judge response and renders beautifully — no more raw JSON.

```tsx
import { motion } from 'framer-motion';
import { VOTE_COLORS } from '../../lib/theme';

interface JudgeVerdictCardProps {
  rawResponse: string;
  isIntermediate?: boolean;
}

interface ParsedDecision {
  pair: string;
  action: string;
  confidence: number;
  reasoning: string;
  leverage?: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  size_pct?: number;
}

function parseJudgeResponse(raw: string): { decisions: ParsedDecision[]; nextCheck?: number; verdict?: string; continues?: boolean } | null {
  try {
    const parsed = JSON.parse(raw);
    return {
      decisions: parsed.decisions ?? [],
      nextCheck: parsed.next_check_minutes,
      verdict: parsed.verdict,
      continues: parsed.continue,
    };
  } catch {
    const match = raw.match(/\{[\s\S]*"decisions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return { decisions: parsed.decisions ?? [], nextCheck: parsed.next_check_minutes, verdict: parsed.verdict, continues: parsed.continue };
      } catch { /* */ }
    }
  }
  return null;
}

export function JudgeVerdictCard({ rawResponse, isIntermediate }: JudgeVerdictCardProps) {
  const parsed = parseJudgeResponse(rawResponse);

  if (!parsed) {
    return (
      <div className="bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] p-4">
        <span className="text-xs text-zinc-600">Judge response (unparseable)</span>
        <pre className="text-[11px] text-zinc-500 font-mono mt-2 whitespace-pre-wrap max-h-40 overflow-y-auto">{rawResponse}</pre>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      className={`rounded-xl border overflow-hidden ${
        isIntermediate
          ? 'bg-[var(--color-surface-2)] border-[var(--color-border)]'
          : 'bg-[var(--color-surface-1)] border-[var(--color-accent-dim)]'
      }`}
    >
      {!isIntermediate && (
        <div className="h-0.5 bg-gradient-to-r from-[var(--color-accent)] via-[var(--color-judge)] to-[var(--color-accent)]" />
      )}

      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-base">{'\u{2696}\uFE0F'}</span>
          <span className="text-xs font-bold uppercase tracking-widest text-zinc-400">
            {isIntermediate ? 'Intermediate Verdict' : 'Final Verdict'}
          </span>
          {parsed.continues && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-mono">
              CONTINUE
            </span>
          )}
        </div>

        {parsed.decisions.map((d, i) => {
          const actionColor = VOTE_COLORS[d.action] ?? '#a1a1aa';
          return (
            <div key={i} className="mb-4 last:mb-0">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="text-2xl font-mono font-bold" style={{ color: actionColor }}>
                  {d.action}
                </span>
                <span className="text-lg font-mono text-zinc-300">{d.pair}</span>
                <span className="text-sm font-mono text-zinc-500">conf:{d.confidence}</span>
              </div>

              {(d.leverage || d.stop_loss_pct || d.take_profit_pct) && (
                <div className="flex gap-4 mb-2 text-xs font-mono text-zinc-500">
                  {d.leverage && <span>Lev: {d.leverage}x</span>}
                  {d.size_pct != null && <span>Size: {d.size_pct}%</span>}
                  {d.stop_loss_pct && <span>SL: {d.stop_loss_pct}%</span>}
                  {d.take_profit_pct && <span>TP: {d.take_profit_pct}%</span>}
                </div>
              )}

              <p className="text-sm text-zinc-400 leading-relaxed">{d.reasoning}</p>
            </div>
          );
        })}

        {parsed.verdict && (
          <div className="mt-3 pt-3 border-t border-[var(--color-border-subtle)]">
            <span className="text-xs text-zinc-600">Verdict: </span>
            <span className="text-xs text-zinc-400 font-mono">{parsed.verdict}</span>
          </div>
        )}

        {parsed.nextCheck && (
          <div className="mt-2 text-[10px] text-zinc-600 font-mono">
            Next check: {parsed.nextCheck} min
          </div>
        )}
      </div>
    </motion.div>
  );
}
```

**Step 2: Commit**
```bash
git add dashboard/src/components/swarm/JudgeVerdictCard.tsx
git commit -m "feat(dashboard): JudgeVerdictCard — parsed verdict display"
```

---

## Task 8: Swarm — RoundSection

**Files:**
- Create: `dashboard/src/components/swarm/RoundSection.tsx`

**Step 1: Create component**

Wraps a round's personas in a grid with a round header.

```tsx
import { motion } from 'framer-motion';
import { PersonaVoteCard } from './PersonaVoteCard';
import { JudgeVerdictCard } from './JudgeVerdictCard';

interface RoundPersona {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
  probability?: number | null;
  conflictsWith?: Record<string, string> | null;
}

interface RoundSectionProps {
  round: number;
  personas: RoundPersona[];
  judgeRawResponse?: string;
  isFinalRound: boolean;
  blackboardSignals?: { bullish: string[]; bearish: string[]; neutral: string[] };
  blackboardRisks?: string[];
}

const ROUND_LABELS: Record<number, string> = {
  1: 'Analysis',
  2: 'Conflict Resolution',
  3: 'Deep Dive',
  4: 'Final Round',
};

export function RoundSection({ round, personas, judgeRawResponse, isFinalRound, blackboardSignals, blackboardRisks }: RoundSectionProps) {
  return (
    <div className="space-y-4">
      {/* Round header */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex items-center gap-3"
      >
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-border)] flex items-center justify-center">
            <span className="text-[10px] font-mono font-bold text-[var(--color-accent)]">{round}</span>
          </div>
          <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            {ROUND_LABELS[round] ?? `Round ${round}`}
          </span>
        </div>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
        <span className="text-[10px] text-zinc-600 font-mono">{personas.length} experts</span>
      </motion.div>

      {/* Persona grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {personas.map((p, i) => (
          <PersonaVoteCard
            key={`${p.persona}-${i}`}
            persona={p.persona}
            vote={p.vote}
            confidence={p.confidence}
            reasoning={p.reasoning}
            probability={p.probability}
            conflictsWith={p.conflictsWith}
          />
        ))}
      </div>

      {/* Signals snapshot */}
      {blackboardSignals && (blackboardSignals.bullish.length > 0 || blackboardSignals.bearish.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {blackboardSignals.bullish.map(s => (
            <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/30 text-green-400 font-mono">{s.replace(/_/g, ' ')}</span>
          ))}
          {blackboardSignals.bearish.map(s => (
            <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/30 text-red-400 font-mono">{s.replace(/_/g, ' ')}</span>
          ))}
          {blackboardSignals.neutral.map(s => (
            <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-500 font-mono">{s.replace(/_/g, ' ')}</span>
          ))}
        </div>
      )}

      {/* Risks */}
      {blackboardRisks && blackboardRisks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {blackboardRisks.map(r => (
            <span key={r} className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-900/20 text-yellow-500/80 font-mono">{r.replace(/_/g, ' ')}</span>
          ))}
        </div>
      )}

      {/* Judge verdict */}
      {judgeRawResponse && (
        <JudgeVerdictCard rawResponse={judgeRawResponse} isIntermediate={!isFinalRound} />
      )}
    </div>
  );
}
```

**Step 2: Commit**
```bash
git add dashboard/src/components/swarm/RoundSection.tsx
git commit -m "feat(dashboard): RoundSection — round layout with persona grid + signals"
```

---

## Task 9: Swarm — DebateSidebar redesign

**Files:**
- Modify: `dashboard/src/components/swarm/DebateSidebar.tsx`

**Step 1: Rewrite with new palette and better layout**

```tsx
import { VOTE_COLORS, getPersona } from '../../lib/theme';

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

export function DebateSidebar({ debates, selectedIdx, onSelect }: DebateSidebarProps) {
  return (
    <div className="w-64 shrink-0 border-r border-[var(--color-border)] overflow-y-auto bg-[var(--color-surface-1)]">
      <div className="p-4 border-b border-[var(--color-border)]">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Debates</h2>
      </div>
      {debates.map((d, i) => {
        const isSelected = selectedIdx === i;
        return (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={`w-full text-left px-4 py-3 border-b border-[var(--color-border-subtle)] transition-all ${
              isSelected
                ? 'bg-[var(--color-surface-2)] border-l-2 border-l-[var(--color-accent)]'
                : 'hover:bg-[var(--color-surface-2)]/50 border-l-2 border-l-transparent'
            }`}
          >
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-xs font-mono text-zinc-400">#{d.cycleId}</span>
              <span className="text-[10px] text-zinc-600 font-mono">
                {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="flex gap-1 mb-1.5">
              {d.votes.map((v, j) => (
                <div
                  key={j}
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: VOTE_COLORS[v.vote ?? 'HOLD'] ?? '#71717a' }}
                  title={`${getPersona(v.persona).label}: ${v.vote ?? 'N/A'}`}
                />
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 truncate">{d.summary}</p>
          </button>
        );
      })}
      {debates.length === 0 && (
        <div className="p-6 text-zinc-600 text-xs text-center">No debates</div>
      )}
    </div>
  );
}
```

**Step 2: Commit**
```bash
git add dashboard/src/components/swarm/DebateSidebar.tsx
git commit -m "feat(dashboard): DebateSidebar redesign with accent selection"
```

---

## Task 10: Swarm — page rewrite

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx`

**Step 1: Rewrite Swarm page**

Replace chat-bubble layout with Engine Bay layout:
- **Header bar**: cycle info + Copy All button
- **InputContextCard**: parsed user_prompt at top
- **RoundSection** for each round: persona grid + signals + judge verdict
- **Superuser input** at bottom (keep existing functionality)

Key changes to data flow:
- Fetch `user_prompt` from `llm_conversations` (already fetched, just not displayed)
- Group messages by `phase` (round)
- Extract `blackboard_state` per round for signals/risks
- Pass to new components instead of SwarmChatMessage

The page structure:
```tsx
<div className="flex h-[calc(100vh-5rem)]">
  <DebateSidebar ... />
  <div className="flex-1 flex flex-col min-w-0">
    {/* Header */}
    <div className="px-5 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
      <div className="flex items-center gap-3">
        <h1 className="text-sm font-semibold text-zinc-300">Swarm Debate</h1>
        {current && <span className="text-xs text-zinc-600 font-mono">Cycle {current.cycleId} ...</span>}
      </div>
      {current && <CopyButton debate={current} />}
    </div>

    {/* Scrollable content */}
    <div className="flex-1 overflow-y-auto p-5 space-y-6">
      {current && <InputContextCard ... />}
      {rounds.map(round => <RoundSection key={round.number} ... />)}
    </div>

    {/* Superuser input */}
    <div className="p-3 border-t border-[var(--color-border)]">...</div>
  </div>
</div>
```

Must update the data fetching to also store `user_prompt` in the DebateData interface and pass `blackboard_state` per round.

Add to `DebateData`:
```ts
userPrompt: string;
```

In the fetch loop, extract from the first judge conversation:
```ts
userPrompt: judgeConvs[0]?.user_prompt ?? '',
```

Also fetch `user_prompt` in the `judgeConvsRes` select:
```ts
.select('raw_response, created_at, label, blackboard_state, user_prompt')
```

Group personas by round, build RoundSection data structure.

**Step 2: Add CopyButton component inline**

```tsx
function CopyButton({ debate }: { debate: DebateData }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = formatDebateForCopy(debate);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-zinc-400 hover:text-white hover:border-[var(--color-accent-dim)] transition-colors font-mono"
    >
      {copied ? 'Copied!' : 'Copy All'}
    </button>
  );
}

function formatDebateForCopy(d: DebateData): string {
  const lines: string[] = [];
  lines.push(`=== Swarm Debate — Cycle ${d.cycleId} ===`);
  lines.push(`Date: ${new Date(d.createdAt).toLocaleString()}`);
  lines.push('');
  if (d.userPrompt) {
    lines.push('--- INPUT CONTEXT ---');
    lines.push(d.userPrompt);
    lines.push('');
  }
  const byRound = new Map<number, typeof d.messages>();
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
```

**Step 3: Remove old imports** — delete imports of `SwarmChatMessage`, `ConflictCard`, `BlackboardStateCard` from Swarm.tsx (components kept in repo for now but unused).

**Step 4: Verify** — `npm run dev`, navigate to /swarm, check:
- InputContextCard shows parsed market data
- Personas render as grid cards per round
- Judge verdict is parsed, not raw JSON
- Copy button works
- Sidebar selection works

**Step 5: Commit**
```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): Swarm page rewrite — Engine Bay layout with persona grid"
```

---

## Task 11: Cleanup old components + LevelDivider removal

**Files:**
- Delete: `dashboard/src/components/swarm/SwarmChatMessage.tsx`
- Delete: `dashboard/src/components/swarm/LevelDivider.tsx`
- Keep (still used in BlackboardStateCard internally): `dashboard/src/components/swarm/ConflictCard.tsx`, `dashboard/src/components/swarm/BlackboardStateCard.tsx`

**Step 1:** Verify no imports remain in Swarm.tsx for deleted files. If `ConflictCard` and `BlackboardStateCard` are no longer imported anywhere, delete them too.

**Step 2: Commit**
```bash
git rm dashboard/src/components/swarm/SwarmChatMessage.tsx dashboard/src/components/swarm/LevelDivider.tsx
git commit -m "chore(dashboard): remove old chat-bubble swarm components"
```

---

## Task 12: Final polish pass

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx` — ensure all `bg-zinc-900` / `border-zinc-800` replaced
- Modify: `dashboard/src/components/charts/DailyPnlBar.tsx` — update grid/axis colors if they use zinc
- Modify: `dashboard/src/components/charts/EquityCurve.tsx` — same
- Modify: `dashboard/src/components/charts/BalanceArea.tsx` — same
- Modify: `dashboard/src/components/ErrorFeed.tsx` — same
- Modify: `dashboard/src/components/PositionTable.tsx` — same

**Step 1:** Global find-replace in dashboard/src:
- `bg-zinc-950` -> `bg-[var(--color-surface-0)]`
- `bg-zinc-900` -> `bg-[var(--color-surface-1)]`
- `bg-zinc-800` -> `bg-[var(--color-surface-2)]` (for surfaces, not borders)
- `border-zinc-800` -> `border-[var(--color-border)]`
- `border-zinc-800/50` -> `border-[var(--color-border-subtle)]`

**Step 2: Verify** — check all pages render correctly with new colors.

**Step 3: Commit**
```bash
git add -A dashboard/src
git commit -m "feat(dashboard): global palette migration to CSS variables"
```

---

## Task 13: Build verification

**Step 1:** Run `cd dashboard && npm run build` — ensure no TypeScript errors.

**Step 2:** Fix any type errors found.

**Step 3: Commit** if fixes needed.

```bash
git add -A dashboard
git commit -m "fix(dashboard): resolve build errors from redesign"
```
