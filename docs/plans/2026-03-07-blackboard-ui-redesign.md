# Blackboard View UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the Blackboard View from a text-heavy tag wall to an Apple-minimalist UI with a semicircle gauge, dot personas, larger fonts, and light/dark theme support.

**Architecture:** Replace SignalBoard (22 tags) with a SemiGauge component. Replace VoteRow (text cards) with colored dots. Add CSS variable theme system. Keep all data — just change presentation.

**Tech Stack:** React, Tailwind CSS, CSS variables, framer-motion (already used)

---

### Task 1: Add CSS variable theme system

**Files:**
- Modify: `dashboard/src/index.css`
- Modify: `dashboard/src/App.tsx` (theme toggle)

**Step 1: Add CSS variables to index.css**

Add at the top of the file:

```css
:root {
  --bg: #ffffff;
  --bg-surface: #f9fafb;
  --text: #18181b;
  --text-muted: #71717a;
  --text-faint: #a1a1aa;
  --border: #e4e4e7;
  --accent-bull: #16a34a;
  --accent-bear: #dc2626;
  --accent-warn: #d97706;
  --surface-1: #ffffff;
  --surface-2: #f4f4f5;
  --surface-3: #e4e4e7;
}

.dark {
  --bg: #09090b;
  --bg-surface: #18181b;
  --text: #fafafa;
  --text-muted: #a1a1aa;
  --text-faint: #52525b;
  --border: #27272a;
  --accent-bull: #4ade80;
  --accent-bear: #f87171;
  --accent-warn: #fbbf24;
  --surface-1: #18181b;
  --surface-2: #1c1c1f;
  --surface-3: #27272a;
}
```

**Step 2: Add theme toggle to App.tsx**

Add a simple toggle button in the header area that toggles `dark` class on `<html>` element:

```typescript
const [dark, setDark] = useState(true);
useEffect(() => {
  document.documentElement.classList.toggle('dark', dark);
}, [dark]);
```

Add a button: sun/moon icon, toggles dark state.

**Step 3: Commit**

```bash
git add dashboard/src/index.css dashboard/src/App.tsx
git commit -m "feat(dashboard): CSS variable theme system with light/dark toggle"
```

---

### Task 2: Create SemiGauge component

**Files:**
- Create: `dashboard/src/components/swarm/SemiGauge.tsx`

**Step 1: Build the component**

Props:
```typescript
interface SemiGaugeProps {
  bullCount: number;
  bearCount: number;
  bullSignals: string[];
  bearSignals: string[];
}
```

SVG semicircle (~200px wide):
- Left half green (bull), right half red (bear)
- Needle angle calculated from bull/(bull+bear) ratio
- Center: 0 (neutral), left: full bull, right: full bear
- Below gauge: `{bullCount} bullish · {bearCount} bearish` in 14px muted text
- Hover on green zone: tooltip with bull signal list
- Hover on red zone: tooltip with bear signal list
- Use CSS variables for colors (var(--accent-bull), var(--accent-bear))

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/SemiGauge.tsx
git commit -m "feat(dashboard): SemiGauge component for bull/bear balance"
```

---

### Task 3: Create PersonaDots component

**Files:**
- Create: `dashboard/src/components/swarm/PersonaDots.tsx`

**Step 1: Build the component**

Props: same as VoteRow (votes array with persona, vote, confidence, reasoning)

Render: horizontal row of 8px colored circles
- Green = LONG, gray = HOLD, red = SHORT
- Hover tooltip: "{Label} · {vote} · {confidence}%"
- Use CSS variables for dot colors

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/PersonaDots.tsx
git commit -m "feat(dashboard): PersonaDots — compact vote indicators"
```

---

### Task 4: Create RiskSummary component

**Files:**
- Create: `dashboard/src/components/swarm/RiskSummary.tsx`

**Step 1: Build the component**

Props:
```typescript
interface RiskSummaryProps {
  risks: string[];
}
```

Render:
- If 0 risks: nothing
- Top 3 risks as text (14px, muted), comma-separated
- If more: `+{n}` badge after the 3rd risk, clickable to expand full list
- Use CSS variables

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/RiskSummary.tsx
git commit -m "feat(dashboard): RiskSummary — top-3 risks with expandable badge"
```

---

### Task 5: Update VerdictBar for larger fonts

**Files:**
- Modify: `dashboard/src/components/swarm/VerdictBar.tsx`

**Step 1: Update font sizes**

- Action (HOLD/LONG/SHORT): `text-2xl` → `text-[32px]`
- Pair name: `text-lg` → `text-xl`
- Confidence: `text-sm` → `text-base`
- Reasoning: `text-sm` → `text-base` (16px)
- Next check: `text-[10px]` → `text-sm`
- Use CSS variables for colors: `style={{ color }}` → keep as is (action-specific)
- Background: use `var(--bg-surface)` instead of hardcoded

**Step 2: Commit**

```bash
git add dashboard/src/components/swarm/VerdictBar.tsx
git commit -m "feat(dashboard): VerdictBar larger fonts + CSS var backgrounds"
```

---

### Task 6: Wire new components into BlackboardView

**Files:**
- Modify: `dashboard/src/components/swarm/BlackboardView.tsx`

**Step 1: Replace imports and usage**

Replace:
- `SignalBoard` → `SemiGauge` (pass aggregated bull/bear counts and signal lists)
- `VoteRow` → `PersonaDots`
- Add `RiskSummary` below gauge

Layout (top to bottom):
1. Round divider (keep)
2. VerdictBar (updated fonts)
3. SemiGauge (new)
4. PersonaDots (new)
5. RiskSummary (new)

**Step 2: Aggregate signals for gauge**

```typescript
const allBullish = personaSignals.flatMap(p => p.signals.bullish ?? []);
const allBearish = personaSignals.flatMap(p => p.signals.bearish ?? []);
const uniqueBull = [...new Set(allBullish.map(s => s.toLowerCase().replace(/_/g, ' ')))];
const uniqueBear = [...new Set(allBearish.map(s => s.toLowerCase().replace(/_/g, ' ')))];
```

**Step 3: Commit**

```bash
git add dashboard/src/components/swarm/BlackboardView.tsx
git commit -m "feat(dashboard): wire SemiGauge + PersonaDots + RiskSummary into BlackboardView"
```

---

### Task 7: Update base font sizes across dashboard

**Files:**
- Modify: `dashboard/src/index.css`

**Step 1: Set base font size**

Add to body styles:
```css
body {
  font-size: 16px;
  background-color: var(--bg);
  color: var(--text);
}
```

**Step 2: Commit**

```bash
git add dashboard/src/index.css
git commit -m "feat(dashboard): base 16px font + CSS var body colors"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | CSS theme system + toggle | index.css, App.tsx |
| 2 | SemiGauge component | SemiGauge.tsx (new) |
| 3 | PersonaDots component | PersonaDots.tsx (new) |
| 4 | RiskSummary component | RiskSummary.tsx (new) |
| 5 | VerdictBar larger fonts | VerdictBar.tsx |
| 6 | Wire into BlackboardView | BlackboardView.tsx |
| 7 | Base font + body CSS vars | index.css |

**Execution order:** 1 → 2,3,4 (parallel) → 5 → 6 → 7
