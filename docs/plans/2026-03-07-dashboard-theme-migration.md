# Dashboard Theme Migration — Light/Dark Support

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the entire dashboard properly support light and dark themes by unifying the CSS color system and replacing all 303 hardcoded color references.

**Architecture:** Make Tailwind `@theme` reference CSS custom properties that switch with `.dark` class. Add semantic color aliases (`fg`, `fg-muted`, `fg-faint`) so Tailwind classes respond to theme changes. Then batch-replace hardcoded `text-zinc-*` classes across all 29 component files.

**Tech Stack:** Tailwind CSS v4 (`@theme`), CSS custom properties, React

---

### Task 1: Unify CSS color system

**Files:**
- Modify: `dashboard/src/index.css`

**Step 1: Rewrite `index.css` with unified system**

Replace the entire file with:

```css
@import "tailwindcss";

/* ── Theme tokens ──────────────────────────────────────── */

:root {
  --bg:          #ffffff;
  --bg-surface:  #f5f5f7;
  --surface-1:   #ffffff;
  --surface-2:   #f5f5f7;
  --surface-3:   #e5e5ea;
  --border:      #d1d1d6;
  --border-subtle:#e5e5ea;
  --text:        #1d1d1f;
  --text-muted:  #6e6e73;
  --text-faint:  #aeaeb2;
  --accent:      #8b5cf6;
  --accent-dim:  rgba(139, 92, 246, 0.12);
  --accent-bull: #16a34a;
  --accent-bear: #dc2626;
  --accent-warn: #d97706;
}

.dark {
  --bg:          #09090b;
  --bg-surface:  #111113;
  --surface-1:   #18181b;
  --surface-2:   #1c1c1f;
  --surface-3:   #27272a;
  --border:      #2e2e33;
  --border-subtle:#222226;
  --text:        #fafafa;
  --text-muted:  #a1a1aa;
  --text-faint:  #52525b;
  --accent:      #c8a2ff;
  --accent-dim:  rgba(200, 162, 255, 0.12);
  --accent-bull: #4ade80;
  --accent-bear: #f87171;
  --accent-warn: #fbbf24;
}

/* ── Tailwind theme: reference CSS vars ────────────────── */

@theme {
  --font-sans: 'DM Sans', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  --color-bg:             var(--bg);
  --color-surface-0:      var(--bg);
  --color-surface-1:      var(--surface-1);
  --color-surface-2:      var(--surface-2);
  --color-surface-3:      var(--surface-3);
  --color-border:         var(--border);
  --color-border-subtle:  var(--border-subtle);

  --color-fg:       var(--text);
  --color-fg-muted: var(--text-muted);
  --color-fg-faint: var(--text-faint);

  --color-accent:     var(--accent);
  --color-accent-dim: var(--accent-dim);
  --color-bull:       var(--accent-bull);
  --color-bear:       var(--accent-bear);
  --color-risk:       var(--accent-warn);

  --color-structure:  #60a5fa;
  --color-narrative:  #fb923c;
  --color-judge:      #e2e8f0;
  --color-superuser:  #f59e0b;
}

body {
  font-family: var(--font-sans);
  font-size: 16px;
  background-color: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
```

**Why this works:** Now `bg-surface-1` in Tailwind references `var(--surface-1)` which switches with `.dark`. And new semantic classes: `text-fg`, `text-fg-muted`, `text-fg-faint` replace hardcoded zinc colors.

**Step 2: Verify dev server starts without CSS errors**

Run: `cd dashboard && npm run dev`
Expected: No errors, page renders

**Step 3: Commit**

```bash
git add dashboard/src/index.css
git commit -m "feat(dashboard): unified CSS var theme system — light/dark support"
```

---

### Task 2: Migrate App.tsx and nav

**Files:**
- Modify: `dashboard/src/App.tsx`

**Step 1: Replace hardcoded colors**

Color mapping for this file:
- `bg-surface-0` -> `bg-bg` (or `bg-surface-0` — now theme-aware)
- `text-[#e4e4ed]` -> `text-fg`
- `text-white` -> `text-fg`
- `text-zinc-500` -> `text-fg-muted`
- `text-zinc-300` -> `text-fg-muted`
- `text-zinc-400` -> `text-fg-muted`
- `text-zinc-600` -> `text-fg-faint`
- `text-zinc-200` -> `text-fg`
- `bg-surface-2` -> `bg-surface-2` (already theme-aware after Task 1)
- `bg-surface-3` -> `bg-surface-3` (already theme-aware)
- `border-accent` stays (theme-aware)
- `border-border` stays (theme-aware)

Apply these replacements. Also ensure the theme toggle `useState(true)` initializes from `localStorage` or `prefers-color-scheme`:

```typescript
const [dark, setDark] = useState(() => {
  const stored = localStorage.getItem('theme');
  if (stored) return stored === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
});
useEffect(() => {
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}, [dark]);
```

**Step 2: Commit**

```bash
git add dashboard/src/App.tsx
git commit -m "feat(dashboard): App.tsx semantic colors + theme persistence"
```

---

### Task 3: Migrate Overview page components

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx`
- Modify: `dashboard/src/components/StatCard.tsx`
- Modify: `dashboard/src/components/PnlHeader.tsx`
- Modify: `dashboard/src/components/PositionTable.tsx`
- Modify: `dashboard/src/components/ErrorFeed.tsx`
- Modify: `dashboard/src/components/CycleSummary.tsx`

**Step 1: Apply color mapping across all files**

Use these global replacements in every file:
- `text-white` -> `text-fg`
- `text-zinc-200` -> `text-fg`
- `text-zinc-300` -> `text-fg`
- `text-zinc-400` -> `text-fg-muted`
- `text-zinc-500` -> `text-fg-muted`
- `text-zinc-600` -> `text-fg-faint`
- `text-zinc-700` -> `text-fg-faint`
- `bg-zinc-*` -> `bg-surface-2` or `bg-surface-3` (context-dependent)
- `border-zinc-*` -> `border-border`
- Keep `text-green-400`, `text-red-400`, `text-amber-400` as-is (semantic)
- Keep `bg-green-*`, `bg-red-*`, `bg-amber-*` as-is (semantic)

**StatCard.tsx** specific fix — colorMap:
```typescript
const colorMap = {
  green: 'text-bull',
  red: 'text-bear',
  yellow: 'text-risk',
  default: 'text-fg',
};
```

And the card itself:
```tsx
<div className="bg-surface-1 rounded-lg p-4 border border-border">
  <div className="text-fg-muted text-sm">{label}</div>
  <div className={`text-2xl font-mono font-bold ${colorMap[color]}`}>{value}</div>
  {subtitle && <div className="text-fg-faint text-xs mt-1">{subtitle}</div>}
</div>
```

**Step 2: Verify in browser — switch between light and dark**

**Step 3: Commit**

```bash
git add dashboard/src/pages/Overview.tsx dashboard/src/components/StatCard.tsx dashboard/src/components/PnlHeader.tsx dashboard/src/components/PositionTable.tsx dashboard/src/components/ErrorFeed.tsx dashboard/src/components/CycleSummary.tsx
git commit -m "feat(dashboard): migrate Overview page to semantic theme colors"
```

---

### Task 4: Migrate Swarm page components

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx`
- Modify: `dashboard/src/components/swarm/VerdictBar.tsx`
- Modify: `dashboard/src/components/swarm/BlackboardView.tsx`
- Modify: `dashboard/src/components/swarm/InputContextCard.tsx`
- Modify: `dashboard/src/components/swarm/DebateSidebar.tsx`
- Modify: `dashboard/src/components/swarm/RoundSection.tsx`
- Modify: `dashboard/src/components/PersonaCard.tsx`
- Modify: `dashboard/src/components/HeroBlock.tsx`

**Step 1: Same color mapping as Task 3**

VerdictBar.tsx additionally: replace inline `style={{ color }}` where color comes from `VOTE_COLORS` — keep as-is (these are action-specific, not theme colors).

Replace `bg-amber-900/30` -> `bg-risk/20`, `text-amber-400` -> `text-risk`.

For components using `style={{ color: 'var(--text-muted)' }}` etc — keep these, they already use CSS vars.

**Step 2: Verify Swarm page in both themes**

**Step 3: Commit**

```bash
git add dashboard/src/pages/Swarm.tsx dashboard/src/components/swarm/VerdictBar.tsx dashboard/src/components/swarm/BlackboardView.tsx dashboard/src/components/swarm/InputContextCard.tsx dashboard/src/components/swarm/DebateSidebar.tsx dashboard/src/components/swarm/RoundSection.tsx dashboard/src/components/PersonaCard.tsx dashboard/src/components/HeroBlock.tsx
git commit -m "feat(dashboard): migrate Swarm page to semantic theme colors"
```

---

### Task 5: Migrate Trades page

**Files:**
- Modify: `dashboard/src/pages/Trades.tsx` (48 occurrences — largest file)
- Modify: `dashboard/src/components/TradeTimeline.tsx`

**Step 1: Same color mapping**

Trades.tsx has 48 hardcoded colors — this is the biggest file. Apply:
- All `text-zinc-*` -> semantic equivalents
- Keep all PnL color logic (`text-green-400`/`text-red-400`)
- `bg-zinc-900/50` -> `bg-surface-2/50`
- `border-zinc-*` -> `border-border`

**Step 2: Verify trades list and timeline in both themes**

**Step 3: Commit**

```bash
git add dashboard/src/pages/Trades.tsx dashboard/src/components/TradeTimeline.tsx
git commit -m "feat(dashboard): migrate Trades page to semantic theme colors"
```

---

### Task 6: Migrate remaining pages

**Files:**
- Modify: `dashboard/src/pages/Decisions.tsx`
- Modify: `dashboard/src/pages/Market.tsx`
- Modify: `dashboard/src/pages/LlmCosts.tsx`
- Modify: `dashboard/src/pages/Chat.tsx`
- Modify: `dashboard/src/pages/Wiki.tsx`
- Modify: `dashboard/src/components/ChatMessage.tsx`
- Modify: `dashboard/src/components/charts/FunnelBar.tsx`
- Modify: `dashboard/src/components/charts/DailyPnlBar.tsx`
- Modify: `dashboard/src/components/charts/EquityCurve.tsx`
- Modify: `dashboard/src/components/charts/BalanceArea.tsx`

**Step 1: Same color mapping**

Charts (Recharts): check if they use hardcoded hex colors in the JSX. If so, use CSS var values by reading them at runtime:
```typescript
const style = getComputedStyle(document.documentElement);
const bullColor = style.getPropertyValue('--accent-bull').trim();
```

Or for Recharts, pass the color string directly since it accepts hex.

**Step 2: Verify all pages in both themes**

**Step 3: Commit**

```bash
git add dashboard/src/pages/Decisions.tsx dashboard/src/pages/Market.tsx dashboard/src/pages/LlmCosts.tsx dashboard/src/pages/Chat.tsx dashboard/src/pages/Wiki.tsx dashboard/src/components/ChatMessage.tsx dashboard/src/components/charts/FunnelBar.tsx dashboard/src/components/charts/DailyPnlBar.tsx dashboard/src/components/charts/EquityCurve.tsx dashboard/src/components/charts/BalanceArea.tsx
git commit -m "feat(dashboard): migrate remaining pages to semantic theme colors"
```

---

### Task 7: Final verification and cleanup

**Step 1: Search for remaining hardcoded colors**

Run: `grep -rn "text-zinc-\|text-white\|bg-zinc-" dashboard/src/ --include="*.tsx" | grep -v node_modules`

Expected: 0 results (or only intentional exceptions like chart tick colors)

**Step 2: Test both themes end-to-end**

- Toggle to Light, verify: Overview, Trades, Swarm, Market, Decisions, Costs, Chat, Wiki
- Toggle to Dark, verify same pages
- Check charts render correctly in both themes

**Step 3: Commit any fixes**

```bash
git add -A dashboard/src/
git commit -m "fix(dashboard): final theme migration cleanup"
```

---

## Summary

| Task | What | Files | Hardcoded refs |
|------|------|-------|----------------|
| 1 | CSS foundation | index.css | 0 (foundation) |
| 2 | App + nav | App.tsx | ~8 |
| 3 | Overview page | 6 files | ~40 |
| 4 | Swarm page | 8 files | ~60 |
| 5 | Trades page | 2 files | ~62 |
| 6 | Remaining pages | 10 files | ~120 |
| 7 | Verification | grep + test | cleanup |

**Execution order:** 1 -> 2 -> 3,4,5,6 (parallel batches) -> 7

**Color mapping cheat sheet** (for all tasks):
```
text-white    -> text-fg
text-zinc-200 -> text-fg
text-zinc-300 -> text-fg
text-zinc-400 -> text-fg-muted
text-zinc-500 -> text-fg-muted
text-zinc-600 -> text-fg-faint
text-zinc-700 -> text-fg-faint
text-[#e4e4ed]-> text-fg
bg-zinc-*     -> bg-surface-2 or bg-surface-3
border-zinc-* -> border-border
```
