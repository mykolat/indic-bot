# Trade Details Dashboard Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add peak PnL, worst PnL, and adjust count to the Trades tab in the dashboard — giving full position lifecycle visibility.

**Architecture:** Create a Supabase DB view that pre-computes trade stats (peak/worst price from market_snapshots, adjust count from sl_tp_adjustments). Dashboard fetches this view alongside existing trade data.

**Tech Stack:** Supabase PostgreSQL (view/function), React + TypeScript (dashboard), Supabase JS client

---

### Task 1: Create Supabase view for trade stats

**Why:** Computing peak/worst PnL from market_snapshots for each trade is expensive as a join. A view encapsulates the logic and can be called once per page load.

**Files:**
- Migration via Supabase MCP

**Step 1: Create the view**

```sql
CREATE OR REPLACE VIEW trade_stats AS
SELECT
  te.id AS execution_id,
  te.pair,
  te.side,
  te.fill_price,
  te.opened_at,
  tc.closed_at,
  tc.exit_reason,
  tc.pnl_pct AS actual_pnl_pct,
  tc.pnl_usd AS actual_pnl_usd,
  -- Peak and worst prices during position lifetime
  ps.low_price,
  ps.high_price,
  -- Peak PnL %: best unrealized profit
  CASE WHEN te.side = 'BUY'
    THEN ROUND(((ps.high_price - te.fill_price::numeric) / te.fill_price::numeric * 100)::numeric, 2)
    ELSE ROUND(((te.fill_price::numeric - ps.low_price) / te.fill_price::numeric * 100)::numeric, 2)
  END AS peak_pnl_pct,
  -- Worst PnL %: worst unrealized drawdown
  CASE WHEN te.side = 'BUY'
    THEN ROUND(((ps.low_price - te.fill_price::numeric) / te.fill_price::numeric * 100)::numeric, 2)
    ELSE ROUND(((te.fill_price::numeric - ps.high_price) / te.fill_price::numeric * 100)::numeric, 2)
  END AS worst_pnl_pct,
  -- Adjust count
  COALESCE(adj.adjust_count, 0) AS adjust_count
FROM trade_executions te
LEFT JOIN trade_closes tc ON tc.execution_id = te.id
LEFT JOIN LATERAL (
  SELECT MIN(ms.mark_price) AS low_price, MAX(ms.mark_price) AS high_price
  FROM market_snapshots ms
  WHERE ms.pair = te.pair
    AND ms.created_at >= te.opened_at
    AND ms.created_at <= COALESCE(tc.closed_at, NOW())
) ps ON true
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS adjust_count
  FROM sl_tp_adjustments sa
  WHERE sa.execution_id = te.id
) adj ON true
WHERE te.fill_price IS NOT NULL;
```

**Step 2: Verify view works**

```sql
SELECT * FROM trade_stats ORDER BY opened_at DESC LIMIT 10;
```

**Step 3: Commit** (migration applied via Supabase MCP)

---

### Task 2: Fetch trade stats in dashboard

**Why:** Dashboard needs the new stats alongside existing trade data.

**Files:**
- Modify: `dashboard/src/pages/Trades.tsx`

**Step 1: After fetching closes, also fetch trade_stats**

In the `load()` function, after `closes` fetch, add:

```typescript
const { data: tradeStats } = execIds.length
  ? await supabase.from('trade_stats').select('execution_id, peak_pnl_pct, worst_pnl_pct, adjust_count').in('execution_id', execIds)
  : { data: [] };
const statsMap = new Map((tradeStats ?? []).map((s: any) => [s.execution_id, s]));
```

**Step 2: Add fields to DecisionRow interface**

```typescript
peak_pnl_pct?: number;
worst_pnl_pct?: number;
adjust_count?: number;
```

**Step 3: Enrich decisions with stats**

In the `enriched` mapping, add:

```typescript
const stat = exec ? statsMap.get(exec.id) : undefined;
// Add to return object:
peak_pnl_pct: stat?.peak_pnl_pct != null ? Number(stat.peak_pnl_pct) : undefined,
worst_pnl_pct: stat?.worst_pnl_pct != null ? Number(stat.worst_pnl_pct) : undefined,
adjust_count: stat?.adjust_count != null ? Number(stat.adjust_count) : undefined,
```

**Step 4: Commit**

```bash
git add dashboard/src/pages/Trades.tsx
git commit -m "feat(dashboard): fetch trade stats (peak/worst PnL, adjusts)"
```

---

### Task 3: Display trade stats in trade list items

**Why:** Show peak PnL, worst PnL, and adjust count inline on each trade row for quick scanning.

**Files:**
- Modify: `dashboard/src/pages/Trades.tsx`

**Step 1: Add stats to the trade row metadata line**

After the existing `held_hours` display (around line 429-432), add:

```tsx
{d.peak_pnl_pct != null && (
  <span className="text-[10px] text-zinc-400 font-mono">
    <span className="text-zinc-600">peak</span>{' '}
    <span className="text-green-400/70">+{d.peak_pnl_pct.toFixed(1)}%</span>
  </span>
)}
{d.worst_pnl_pct != null && (
  <span className="text-[10px] text-zinc-400 font-mono">
    <span className="text-zinc-600">dip</span>{' '}
    <span className="text-red-400/70">{d.worst_pnl_pct.toFixed(1)}%</span>
  </span>
)}
{(d.adjust_count ?? 0) > 0 && (
  <span className="text-[10px] text-zinc-400 font-mono">
    <span className="text-zinc-600">adj</span> {d.adjust_count}
  </span>
)}
```

**Step 2: Verify in browser**

Open dashboard, go to Trades tab. Each closed trade should show:
- `peak +2.3%` in green
- `dip -0.4%` in red
- `adj 3` if adjustments were made

**Step 3: Commit**

```bash
git add dashboard/src/pages/Trades.tsx
git commit -m "feat(dashboard): display peak/worst PnL and adjust count in trade list"
```

---

### Task 4: Add trade stats to timeline detail panel

**Why:** When a trade is selected, the right panel should show a summary card with full position stats.

**Files:**
- Modify: `dashboard/src/pages/Trades.tsx`

**Step 1: Add a stats summary card at the top of the timeline panel**

After the `Trade Lifecycle` header div (line 463-472), before `<TradeTimeline>`, add:

```tsx
{selectedDecision.executed && (
  <div className="px-4 py-3 border-b border-border grid grid-cols-4 gap-3">
    <div>
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Entry</div>
      <div className="text-xs font-mono text-zinc-300">${selectedDecision.fill_price}</div>
    </div>
    <div>
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Peak</div>
      <div className="text-xs font-mono text-green-400">
        {selectedDecision.peak_pnl_pct != null ? `+${selectedDecision.peak_pnl_pct.toFixed(1)}%` : '—'}
      </div>
    </div>
    <div>
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Worst</div>
      <div className="text-xs font-mono text-red-400">
        {selectedDecision.worst_pnl_pct != null ? `${selectedDecision.worst_pnl_pct.toFixed(1)}%` : '—'}
      </div>
    </div>
    <div>
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider">Adjusts</div>
      <div className="text-xs font-mono text-zinc-300">{selectedDecision.adjust_count ?? 0}</div>
    </div>
  </div>
)}
```

**Step 2: Verify**

Select a trade in dashboard. Should see a 4-column stats bar: Entry | Peak | Worst | Adjusts.

**Step 3: Commit**

```bash
git add dashboard/src/pages/Trades.tsx
git commit -m "feat(dashboard): trade stats summary card in timeline panel"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | DB view `trade_stats` | Supabase migration |
| 2 | Fetch stats in dashboard | Trades.tsx (data layer) |
| 3 | Show stats in trade list | Trades.tsx (list items) |
| 4 | Show stats in detail panel | Trades.tsx (timeline panel) |

**Execution order:** 1 → 2 → 3 → 4 (sequential)
