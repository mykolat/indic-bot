# Swarm Engine UX Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix persona dots (sorted, grouped by round, labeled), add market price (was→current) to debate context, and fix minor UX bugs in the Engine page.

**Architecture:** Fix data loading to eagerly fetch ALL phase votes (not just phase 1), sort dots by a fixed persona order, group by round with visual separators in sidebar, add persona code labels in main view, fetch mark_price from market_snapshots for debate time window to show price at debate time vs current.

**Tech Stack:** React, TypeScript, Tailwind CSS, Supabase REST API

---

## Bug Summary (from screenshots)

| # | Issue | Where | Root Cause |
|---|-------|-------|------------|
| 1 | Dots change on click (3→6, 6→9) | Sidebar | Eager load uses `conversation_id` + `phase=1`; detail load uses time-window query and re-sets votes (Swarm.tsx:394-399) |
| 2 | Dot order inconsistent | Sidebar + Main | No sort — uses DB insertion order |
| 3 | No round separation | Sidebar | All votes flattened into single `flex gap-1` row |
| 4 | Dots unreadable when >6 | Main view | 12 identical small circles in a row with no labels |
| 5 | No legend / context | Both | Only native `title` tooltip on sidebar; hover tooltip on main — no persistent labels |
| 6 | No market price in debate context | InputContextCard | `mark_price` exists in `market_snapshots` but not fetched/displayed |
| 7 | "CONTINUE" badge looks clickable | VerdictBar | Styled like a button (bg + rounded) but is informational only |

---

## Task 1: Add fixed persona sort order to theme

**Files:**
- Modify: `dashboard/src/lib/theme.ts`

**Step 1: Add PERSONA_ORDER constant**

Add after `VOTE_COLORS` (line 19):

```typescript
/** Fixed display order for persona dots */
export const PERSONA_ORDER: string[] = [
  'risk_manager',
  'market_structure',
  'bull_thesis',
  'bear_thesis',
  'narrative_expert',
  'devils_advocate',
];

export function sortPersonas<T extends { persona: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ai = PERSONA_ORDER.indexOf(a.persona);
    const bi = PERSONA_ORDER.indexOf(b.persona);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}
```

**Step 2: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add dashboard/src/lib/theme.ts
git commit -m "feat(dashboard): add fixed persona sort order"
```

---

## Task 2: Fix sidebar eager loading — fetch ALL phases, not just phase 1

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (lines 154-174, 394-399)

**Problem:** Eager load (line 158) filters `.eq('phase', 1)`, so sidebar shows only round 1 dots. Then `loadDetail` (line 394-399) re-fetches by time window and updates votes — causing dots to change on click.

**Step 1: Remove phase filter from eager load**

In `Swarm.tsx`, change line 157-158 from:
```typescript
              .select('conversation_id, persona, vote, phase')
              .eq('phase', 1)
```
to:
```typescript
              .select('conversation_id, persona, vote, phase')
```

**Step 2: Group votes by phase in the cycleVotes map**

Change the vote mapping (lines 165-174) from:
```typescript
      const cycleVotes = new Map<number, Array<{ persona: string; vote: string | null }>>();
      const convToCycle = new Map<number, number>();
      for (const j of judges ?? []) convToCycle.set(j.id, j.cycle_id);
      for (const v of allVotes ?? []) {
        const cid = convToCycle.get(v.conversation_id);
        if (!cid) continue;
        const arr = cycleVotes.get(cid) ?? [];
        arr.push({ persona: v.persona, vote: v.vote });
        cycleVotes.set(cid, arr);
      }
```
to:
```typescript
      const cycleVotes = new Map<number, Array<{ persona: string; vote: string | null; phase: number }>>();
      const convToCycle = new Map<number, number>();
      for (const j of judges ?? []) convToCycle.set(j.id, j.cycle_id);
      for (const v of allVotes ?? []) {
        const cid = convToCycle.get(v.conversation_id);
        if (!cid) continue;
        const arr = cycleVotes.get(cid) ?? [];
        arr.push({ persona: v.persona, vote: v.vote, phase: v.phase ?? 1 });
        cycleVotes.set(cid, arr);
      }
```

**Step 3: Update SidebarItem type to include phase**

Change the `SidebarItem` interface (line 14) from:
```typescript
  votes: Array<{ persona: string; vote: string | null }>;
```
to:
```typescript
  votes: Array<{ persona: string; vote: string | null; phase: number }>;
```

**Step 4: Remove the vote re-set in loadDetail**

Delete lines 393-399 (the block that overwrites sidebar votes on detail load):
```typescript
    // Update sidebar votes for this item (only if we got new data)
    const votes = personaList
      .filter(p => p.persona !== 'superuser' && (p.phase ?? 1) === 1)
      .map(p => ({ persona: p.persona, vote: p.vote }));
    if (votes.length > 0) {
      setSidebarItems(prev => prev.map((si, i) => i === idx ? { ...si, votes } : si));
    }
```

**Step 5: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: Type error in DebateSidebar (votes now has `phase`) — will fix in next task.

**Step 6: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx
git commit -m "fix(dashboard): eagerly load all phase votes, stop re-setting on click"
```

---

## Task 3: Redesign sidebar dots — sorted, grouped by round

**Files:**
- Modify: `dashboard/src/components/swarm/DebateSidebar.tsx`

**Step 1: Update DebateItem interface and rewrite dot rendering**

Replace the entire `DebateSidebar.tsx` with:

```typescript
import { VOTE_COLORS, getPersona, sortPersonas } from '../../lib/theme';

interface DebateItem {
  cycleId: number;
  createdAt: string;
  votes: Array<{ persona: string; vote: string | null; phase: number }>;
  summary: string;
  isSkip?: boolean;
  skipReason?: string;
}

interface DebateSidebarProps {
  debates: DebateItem[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}

/** Group votes by phase, sort personas within each phase */
function groupByRound(votes: DebateItem['votes']) {
  const rounds = new Map<number, DebateItem['votes']>();
  for (const v of votes) {
    const arr = rounds.get(v.phase) ?? [];
    arr.push(v);
    rounds.set(v.phase, arr);
  }
  return Array.from(rounds.entries())
    .sort(([a], [b]) => a - b)
    .map(([phase, vs]) => ({ phase, votes: sortPersonas(vs) }));
}

export function DebateSidebar({ debates, selectedIdx, onSelect }: DebateSidebarProps) {
  return (
    <div className="w-64 shrink-0 border-r border-border overflow-y-auto bg-surface-1">
      <div className="p-4 border-b border-border">
        <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Debates</h2>
      </div>
      {debates.map((d, i) => {
        const isSelected = selectedIdx === i;

        if (d.isSkip) {
          return (
            <button
              key={i}
              onClick={() => onSelect(i)}
              className={`w-full text-left px-4 py-3 border-b border-border-subtle transition-all ${
                isSelected
                  ? 'bg-yellow-950/20 border-l-2 border-l-yellow-500'
                  : 'border-l-2 border-l-yellow-600/40 bg-yellow-950/10 hover:bg-yellow-950/20'
              }`}
            >
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-mono text-yellow-600/70">
                  {(() => {
                    const ids = (d.skipReason ?? '').split(',').filter(Boolean);
                    return ids.length > 1 ? `#${ids[ids.length - 1]}–${ids[0]}` : `#${d.cycleId}`;
                  })()}
                </span>
                <span className="text-[10px] text-zinc-600 font-mono">
                  {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 truncate">{d.summary}</p>
            </button>
          );
        }

        const rounds = groupByRound(d.votes);
        const totalRounds = rounds.length;

        return (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={`w-full text-left px-4 py-3 border-b border-border-subtle transition-all ${
              isSelected
                ? 'bg-surface-2 border-l-2 border-l-accent'
                : 'hover:bg-surface-2/50 border-l-2 border-l-transparent'
            }`}
          >
            <div className="flex justify-between items-center mb-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-zinc-400">#{d.cycleId}</span>
                {totalRounds > 1 && (
                  <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-surface-3 text-zinc-500">
                    {totalRounds}R
                  </span>
                )}
              </div>
              <span className="text-[10px] text-zinc-600 font-mono">
                {new Date(d.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            {/* Dots grouped by round with separator */}
            <div className="flex items-center gap-0.5 mb-1.5 flex-wrap">
              {rounds.map((r, ri) => (
                <div key={r.phase} className="flex items-center gap-0.5">
                  {ri > 0 && (
                    <div className="w-px h-2 mx-0.5" style={{ backgroundColor: 'var(--border)' }} />
                  )}
                  {r.votes.map((v, j) => (
                    <div
                      key={j}
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: VOTE_COLORS[v.vote ?? 'HOLD'] ?? '#71717a' }}
                      title={`R${r.phase} ${getPersona(v.persona).label}: ${v.vote ?? 'N/A'}`}
                    />
                  ))}
                </div>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500 truncate">{d.summary}</p>
          </button>
        );
      })}
      {debates.length === 0 && (
        <div className="space-y-0 animate-pulse">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="px-4 py-3 border-b border-border-subtle">
              <div className="flex justify-between mb-1.5">
                <div className="h-3 bg-surface-3 rounded w-12" />
                <div className="h-3 bg-surface-2 rounded w-10" />
              </div>
              <div className="flex gap-1 mb-1.5">
                {Array.from({ length: 5 }).map((_, j) => (
                  <div key={j} className="w-2 h-2 rounded-full bg-surface-3" />
                ))}
              </div>
              <div className="h-2.5 bg-surface-2 rounded w-3/4" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

Key changes:
- Dots grouped by round with `|` vertical separator between rounds
- Badge `3R` shows round count when >1
- Fixed persona order via `sortPersonas()`
- Tooltip shows round number: `R1 Risk Manager: HOLD`

**Step 2: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/DebateSidebar.tsx
git commit -m "feat(dashboard): group sidebar dots by round with separators and fixed sort"
```

---

## Task 4: Improve main-view PersonaDots — add persona code labels

**Files:**
- Modify: `dashboard/src/components/swarm/PersonaDots.tsx`

**Problem:** Main view shows 12 identical dots in a row. Unreadable. Need persona code labels (RM, MS, BT, BA, NE, DA) next to each dot.

**Step 1: Rewrite PersonaDots with code labels**

Replace entire `PersonaDots.tsx`:

```typescript
import { useState } from 'react';
import { getPersona, sortPersonas } from '../../lib/theme.js';

interface PersonaDotProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
}

interface PersonaDotsProps {
  votes: PersonaDotProps[];
}

const DOT_COLORS: Record<string, string> = {
  LONG: 'var(--accent-bull)',
  SHORT: 'var(--accent-bear)',
  HOLD: 'var(--text-faint)',
  CLOSE: 'var(--accent-warn)',
};

export function PersonaDots({ votes }: PersonaDotsProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const sorted = sortPersonas(votes);

  return (
    <div className="flex items-center gap-2 justify-center flex-wrap relative">
      {sorted.map((v, i) => {
        const p = getPersona(v.persona);
        const color = DOT_COLORS[v.vote ?? 'HOLD'] ?? 'var(--text-faint)';
        return (
          <div
            key={v.persona}
            className="relative flex items-center gap-1"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <div
              className="w-2.5 h-2.5 rounded-full cursor-pointer transition-transform"
              style={{
                backgroundColor: color,
                transform: hovered === i ? 'scale(1.5)' : 'scale(1)',
              }}
            />
            <span
              className="text-[9px] font-mono font-semibold cursor-pointer"
              style={{ color, opacity: hovered === i ? 1 : 0.6 }}
            >
              {p.code}
            </span>
            {hovered === i && (
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs z-10"
                style={{
                  backgroundColor: 'var(--surface-1)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-muted)',
                }}
              >
                {p.label} · {v.vote ?? 'N/A'} · {v.confidence ?? '?'}%
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

Key changes:
- Sorted by fixed persona order
- Each dot has a 2-letter code label (RM, MS, BT, BA, NE, DA)
- Code label colored same as dot
- Better gap (2 instead of 3) + flex-wrap for many personas

**Step 2: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/PersonaDots.tsx
git commit -m "feat(dashboard): add persona code labels to main-view dots"
```

---

## Task 5: Fix Swarm.tsx sidebar data plumbing to pass `phase`

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (line 527)

**Step 1: Ensure votes passed to sidebar include phase**

The `.map()` on line 527 already passes `votes` as-is, but the `SidebarItem` type already has `phase` from Task 2. Verify the plumbing works by checking the `debates` prop mapping:

Line 527 currently:
```typescript
        debates={sidebarItems.map(d => ({ cycleId: d.cycleId, createdAt: d.createdAt, votes: d.votes, summary: d.summary, isSkip: d.isSkip, skipReason: d.skipReason }))}
```

This already passes `d.votes` which now includes `phase` from Task 2. No change needed here.

But ensure the `SwarmMessage` type also doesn't filter out superuser in the neq. Check line 159:
```typescript
              .neq('persona', 'superuser')
```
This is correct — superuser should not appear as a dot.

**Step 2: Full build + visual check**

Run: `cd dashboard && npm run build`
Expected: build succeeds

**Step 3: Commit (if any changes)**

```bash
git add -A dashboard/src/
git commit -m "fix(dashboard): plumbing for phase-aware sidebar votes"
```

---

## Task 6: Add market price (was→current) to InputContextCard

**Files:**
- Modify: `dashboard/src/components/swarm/InputContextCard.tsx`
- Modify: `dashboard/src/pages/Swarm.tsx` (data fetching)

**Problem:** The debate happened at a specific price. User wants to see "price at debate time" vs "current price" to understand how the market moved since the decision.

**Step 1: Extend InputContextCard props with price data**

In `InputContextCard.tsx`, add to the interface:
```typescript
interface InputContextCardProps {
  userPrompt: string;
  pair: string;
  regime: string;
  fearGreed: number;
  volumeRatio: number;
  debatePrice?: number | null;   // mark_price at debate time
  currentPrice?: number | null;  // latest mark_price
}
```

**Step 2: Add price column to the grid**

In the grid array (line 32-37), add a price entry after the Pair entry:

```typescript
{ label: 'Pair', value: pair, sub: '', color: 'text-white' },
// Add this entry:
...(debatePrice != null ? [{
  label: 'Market Price',
  value: `$${debatePrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
  sub: currentPrice != null
    ? `Now $${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${((currentPrice - debatePrice) / debatePrice * 100).toFixed(2)}%)`
    : '',
  color: currentPrice != null && currentPrice > debatePrice ? 'text-green-400' : currentPrice != null && currentPrice < debatePrice ? 'text-red-400' : 'text-zinc-300',
}] : []),
```

Change grid from `grid-cols-2 md:grid-cols-5` to `grid-cols-2 md:grid-cols-6` to fit the extra column.

**Step 3: Fetch mark_price in Swarm.tsx loadDetail**

In the `loadDetail` function, after the existing `Promise.all` for personas and judge convs (line 321), add a market snapshot fetch:

```typescript
const [personasRes, judgeConvsRes, priceRes] = await Promise.all([
  // ... existing persona query ...
  // ... existing judge query ...
  supabase
    .from('market_snapshots')
    .select('mark_price, pair, created_at')
    .eq('pair', 'BTCUSDT')
    .lte('created_at', windowEnd)
    .order('created_at', { ascending: false })
    .limit(1),
]);
```

Store the price in the `DebateDetail`:

Add to `DebateDetail` interface:
```typescript
interface DebateDetail {
  // ... existing fields ...
  debatePrice?: number | null;
}
```

Set it in the detail object:
```typescript
const detail: DebateDetail = {
  // ... existing fields ...
  debatePrice: priceRes.data?.[0]?.mark_price ? Number(priceRes.data[0].mark_price) : null,
};
```

**Step 4: Fetch current price once (latest snapshot)**

Add a `currentPrice` state in Swarm component:
```typescript
const [currentPrice, setCurrentPrice] = useState<number | null>(null);
```

In the sidebar useEffect, after fetching debates, also fetch latest price:
```typescript
const { data: latestSnapshot } = await supabase
  .from('market_snapshots')
  .select('mark_price')
  .eq('pair', 'BTCUSDT')
  .order('created_at', { ascending: false })
  .limit(1);
setCurrentPrice(latestSnapshot?.[0]?.mark_price ? Number(latestSnapshot[0].mark_price) : null);
```

**Step 5: Pass prices to InputContextCard**

Update the JSX where `InputContextCard` is rendered (line 579):
```typescript
<InputContextCard
  userPrompt={currentDetail.userPrompt}
  pair={ctx.pair}
  regime={ctx.regime}
  fearGreed={ctx.fearGreed}
  volumeRatio={ctx.volumeRatio}
  debatePrice={currentDetail.debatePrice}
  currentPrice={currentPrice}
/>
```

**Step 6: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors

**Step 7: Commit**

```bash
git add dashboard/src/components/swarm/InputContextCard.tsx dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): show market price (was→now) in debate context card"
```

---

## Task 7: Fix "CONTINUE" badge visual affordance

**Files:**
- Modify: `dashboard/src/components/swarm/VerdictBar.tsx` (line 73)

**Problem:** The green `CONTINUE` badge has `rounded-full bg-amber-900/30` styling that makes it look like a clickable button/pill. It's purely informational.

**Step 1: Change CONTINUE badge to a more label-like style**

In `VerdictBar.tsx` line 73, change from:
```typescript
<span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/30 text-amber-400 font-mono">CONTINUE</span>
```
to:
```typescript
<span className="text-[10px] px-1.5 py-px rounded border border-amber-800/40 text-amber-500/70 font-mono uppercase tracking-wider">continue</span>
```

Key changes:
- Smaller text (10px vs 12px)
- Border instead of background fill — reads as label, not button
- Lowercase + tracking — less prominent
- Muted opacity (70%) — secondary information

**Step 2: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/VerdictBar.tsx
git commit -m "fix(dashboard): make CONTINUE badge look like a label, not a button"
```

---

## Task 8: Add hindsight outcome badge to sidebar debates

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (data fetching + sidebar item)
- Modify: `dashboard/src/components/swarm/DebateSidebar.tsx` (render badge)

**Problem:** User can't tell if a HOLD/LONG/SHORT decision was good. Need a hindsight badge showing price movement 6-24h after the debate — did the market validate or invalidate the decision?

**Step 1: Add outcome fields to SidebarItem**

In `Swarm.tsx`, extend `SidebarItem`:
```typescript
interface SidebarItem {
  // ... existing fields ...
  outcome?: { pricePct: number; hoursAfter: number } | null;
}
```

**Step 2: Fetch price snapshots for hindsight in sidebar useEffect**

After building sidebar items, fetch the price at debate time and 6-24h later for each debate. Use batch query:

```typescript
// Hindsight: for each debate, get price at debate time and ~12h later
const debateItems = items.filter(i => !i.isSkip);
if (debateItems.length > 0) {
  const hindsightPromises = debateItems.map(async (item) => {
    const debateTime = new Date(item.createdAt);
    const afterTime = new Date(debateTime.getTime() + 12 * 60 * 60_000); // 12h later
    const now = new Date();
    // Only compute for debates older than 6h
    if (now.getTime() - debateTime.getTime() < 6 * 60 * 60_000) return null;
    const actualAfter = afterTime > now ? now : afterTime;

    const [{ data: atDebate }, { data: atAfter }] = await Promise.all([
      supabase
        .from('market_snapshots')
        .select('mark_price')
        .eq('pair', 'BTCUSDT')
        .lte('created_at', debateTime.toISOString())
        .order('created_at', { ascending: false })
        .limit(1),
      supabase
        .from('market_snapshots')
        .select('mark_price, created_at')
        .eq('pair', 'BTCUSDT')
        .gte('created_at', actualAfter.toISOString())
        .order('created_at', { ascending: true })
        .limit(1),
    ]);

    const pBefore = atDebate?.[0]?.mark_price ? Number(atDebate[0].mark_price) : null;
    const pAfter = atAfter?.[0]?.mark_price ? Number(atAfter[0].mark_price) : null;
    if (!pBefore || !pAfter) return null;
    const hoursAfter = (new Date(atAfter[0].created_at).getTime() - debateTime.getTime()) / 3_600_000;
    return { cycleId: item.cycleId, pricePct: ((pAfter - pBefore) / pBefore) * 100, hoursAfter };
  });

  const outcomes = await Promise.all(hindsightPromises);
  const outcomeMap = new Map<number, { pricePct: number; hoursAfter: number }>();
  for (const o of outcomes) {
    if (o) outcomeMap.set(o.cycleId, { pricePct: o.pricePct, hoursAfter: o.hoursAfter });
  }

  setSidebarItems(prev => prev.map(si => ({
    ...si,
    outcome: outcomeMap.get(si.cycleId) ?? null,
  })));
}
```

**Step 3: Update DebateItem in DebateSidebar to show outcome**

Add to DebateItem interface:
```typescript
interface DebateItem {
  // ... existing ...
  outcome?: { pricePct: number; hoursAfter: number } | null;
}
```

Add outcome badge after the summary line, inside the debate button:

```typescript
{d.outcome && (
  <div className="flex items-center gap-1 mt-1">
    <span className={`text-[9px] font-mono ${
      d.outcome.pricePct > 0 ? 'text-green-500' : d.outcome.pricePct < 0 ? 'text-red-500' : 'text-zinc-500'
    }`}>
      {d.outcome.pricePct > 0 ? '+' : ''}{d.outcome.pricePct.toFixed(1)}%
    </span>
    <span className="text-[8px] text-zinc-600">
      {d.outcome.hoursAfter.toFixed(0)}h later
    </span>
  </div>
)}
```

**Interpretation logic:** Compare the outcome with the decision:
- HOLD + flat (<0.5%) → correct (no badge color change)
- HOLD + big move (>1%) → missed opportunity (subtle yellow)
- LONG + price up → correct
- SHORT + price down → correct

For now, just show raw % — keep it simple. The user can visually compare with the decision summary.

**Step 4: Pass outcome to sidebar**

In the `debates` prop mapping (Swarm.tsx line 527), add `outcome: d.outcome`:
```typescript
debates={sidebarItems.map(d => ({
  cycleId: d.cycleId, createdAt: d.createdAt, votes: d.votes,
  summary: d.summary, isSkip: d.isSkip, skipReason: d.skipReason,
  outcome: d.outcome,
}))}
```

**Step 5: Verify build**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no errors

**Step 6: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx dashboard/src/components/swarm/DebateSidebar.tsx
git commit -m "feat(dashboard): add hindsight price outcome badge to debate sidebar"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `dashboard/src/lib/theme.ts` | Add `PERSONA_ORDER` + `sortPersonas()` |
| `dashboard/src/pages/Swarm.tsx` | Remove phase=1 filter; add phase to votes; delete vote re-set; fetch mark_price + currentPrice + hindsight outcomes |
| `dashboard/src/components/swarm/DebateSidebar.tsx` | Group dots by round with `\|` separator; round count badge; fixed sort; hindsight badge |
| `dashboard/src/components/swarm/PersonaDots.tsx` | Add 2-letter persona code labels; fixed sort |
| `dashboard/src/components/swarm/InputContextCard.tsx` | Add Market Price column (was→now with % delta) |
| `dashboard/src/components/swarm/VerdictBar.tsx` | CONTINUE badge: label style instead of button |

## Expected Visual Result

**Sidebar before:** `●●●●●●●●●` (9 identical gray dots, no structure)
**Sidebar after:** `●●●●● | ●●●● 2R` (5 dots round 1, separator, 4 dots round 2, badge "2R") + `+0.3% 12h later`

**Main view before:** `● ● ● ● ● ● ● ● ● ● ● ●` (12 dots, no labels)
**Main view after:** `●RM ●MS ●BT ●BA ●NE ●DA` (6 labeled dots per round, sorted consistently)

**Context card before:** Pair | Regime | F&G | Volume Ratio | Session PnL
**Context card after:** Pair | **$87,234** (Now $87,890 +0.75%) | Regime | F&G | Volume Ratio | Session PnL
