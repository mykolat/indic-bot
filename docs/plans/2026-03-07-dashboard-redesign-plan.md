# Dashboard Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the raw 4-page dashboard into a 6-page decision-analytics platform with Binance-style PnL charts, decision funnel visualization, market data charts, and LLM cost tracking.

**Architecture:** React SPA with recharts for all visualizations. Data from Supabase REST API (existing `supabase` client). Each page is a route in react-router-dom. Shared data-fetching hooks in `dashboard/src/hooks/`. Shared chart components in `dashboard/src/components/charts/`. All queries use existing Supabase JS client — no backend changes needed.

**Tech Stack:** React 19, Vite 7, Tailwind 4, recharts, @supabase/supabase-js, react-router-dom 7

**Design doc:** `docs/plans/2026-03-07-dashboard-redesign-design.md`

---

## Existing File Map

```
dashboard/
  src/
    App.tsx                    — router + nav (4 routes)
    main.tsx                   — entry
    index.css                  — tailwind import
    lib/
      supabase.ts              — Supabase client
      chat.ts                  — chat streaming
    pages/
      Overview.tsx             — overview (stat cards + positions + errors)
      Trades.tsx               — trade decisions + timeline
      Swarm.tsx                — swarm debate viewer
      Chat.tsx                 — chat assistant
    components/
      StatCard.tsx             — metric card
      PositionTable.tsx        — positions table
      ErrorFeed.tsx            — error list
      TradeTimeline.tsx        — vertical timeline
      PersonaCard.tsx          — swarm persona card
      ChatMessage.tsx          — chat bubble
```

## DB Tables (key columns for queries)

- `cycles`: id, balance, session_pnl, volume_ratio, confluence_score, regime, regime_confidence, fear_greed_value, layer, filter_warning, created_at
- `trade_decisions`: id, cycle_id, pair, action, confidence, reasoning, regime, volume_ratio, created_at
- `risk_validations`: id, decision_id, passed, rejection_reason, created_at
- `trade_executions`: id, decision_id, pair, side, fill_price, quantity, leverage, sl_price, tp_price, size_usd, opened_at, entry_thesis
- `trade_closes`: id, execution_id, close_decision_id, pair, exit_price, exit_reason, pnl_usd, pnl_pct, held_hours, closed_at
- `errors`: id, cycle_id, code, message, created_at
- `market_snapshots`: id, pair, mark_price, open_interest, funding_rate, imbalance_pct, created_at
- `indicator_snapshots`: id, cycle_id, pair, timeframe, rsi, ema_short, ema_long, adx, volume_ratio, trend, created_at
- `llm_conversations`: id, cycle_id, layer, model, method, label, tokens_in, tokens_out, latency_ms, parsed_ok, created_at
- `token_usage`: id, model, method, label, tokens_in, tokens_out, cost_usd, created_at
- `swarm_personas`: id, conversation_id, persona, vote, confidence, reasoning, created_at
- `news_articles`: id, title, source, sentiment, published_at
- `memory_reviews`: id, trigger_reason, review_text, created_at

---

## Task 1: Install recharts + scaffold hooks directory

**Files:**
- Modify: `dashboard/package.json`
- Create: `dashboard/src/hooks/useSupabaseQuery.ts`

**Step 1: Install recharts**

```bash
cd dashboard && npm install recharts
```

**Step 2: Create generic Supabase query hook**

Create `dashboard/src/hooks/useSupabaseQuery.ts`:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';

interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useSupabaseQuery<T>(
  queryFn: () => Promise<{ data: T | null; error: any }>,
  deps: any[] = [],
): QueryResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    const { data, error } = await queryFn();
    setData(data);
    setError(error?.message ?? null);
    setLoading(false);
  }, deps);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch };
}

export { supabase };
```

**Step 3: Verify build**

```bash
cd dashboard && npm run build
```
Expected: success, no errors.

**Step 4: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/src/hooks/useSupabaseQuery.ts
git commit -m "feat(dashboard): install recharts + add useSupabaseQuery hook"
```

---

## Task 2: Shared chart components

**Files:**
- Create: `dashboard/src/components/charts/DailyPnlBar.tsx`
- Create: `dashboard/src/components/charts/EquityCurve.tsx`
- Create: `dashboard/src/components/charts/BalanceArea.tsx`
- Create: `dashboard/src/components/charts/FunnelBar.tsx`

**Step 1: DailyPnlBar — green/red bar chart**

Create `dashboard/src/components/charts/DailyPnlBar.tsx`:

```tsx
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface DailyPnl {
  date: string;
  pnl: number;
}

export function DailyPnlBar({ data }: { data: DailyPnl[] }) {
  if (!data.length) return <div className="text-zinc-500 text-sm p-4">No trade data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
        <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} />
        <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
          labelStyle={{ color: '#a1a1aa' }}
          itemStyle={{ color: '#e4e4e7' }}
        />
        <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.pnl >= 0 ? '#4ade80' : '#f87171'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
```

**Step 2: EquityCurve — cumulative PnL + BTC benchmark**

Create `dashboard/src/components/charts/EquityCurve.tsx`:

```tsx
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

interface EquityPoint {
  date: string;
  cumPnl: number;
  btcPct?: number;
}

export function EquityCurve({ data }: { data: EquityPoint[] }) {
  if (!data.length) return <div className="text-zinc-500 text-sm p-4">No equity data yet</div>;
  const hasBtc = data.some((d) => d.btcPct !== undefined);
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
        <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} />
        <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
          labelStyle={{ color: '#a1a1aa' }}
        />
        <Line type="monotone" dataKey="cumPnl" stroke="#eab308" dot={false} name="Cum. PnL $" />
        {hasBtc && <Line type="monotone" dataKey="btcPct" stroke="#60a5fa" dot={false} name="BTC %" />}
        <Legend wrapperStyle={{ fontSize: 11, color: '#a1a1aa' }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

**Step 3: BalanceArea — balance over time**

Create `dashboard/src/components/charts/BalanceArea.tsx`:

```tsx
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface BalancePoint {
  date: string;
  balance: number;
}

export function BalanceArea({ data }: { data: BalancePoint[] }) {
  if (!data.length) return <div className="text-zinc-500 text-sm p-4">No balance data yet</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
        <defs>
          <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#eab308" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#eab308" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="date" tick={{ fill: '#71717a', fontSize: 11 }} />
        <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
        <Tooltip
          contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
          labelStyle={{ color: '#a1a1aa' }}
        />
        <Area type="monotone" dataKey="balance" stroke="#eab308" fill="url(#balGrad)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

**Step 4: FunnelBar — horizontal funnel steps**

Create `dashboard/src/components/charts/FunnelBar.tsx`:

```tsx
interface FunnelStep {
  label: string;
  count: number;
  color: string;
}

export function FunnelBar({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.count), 1);
  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-xs text-zinc-400 w-32 text-right shrink-0">{step.label}</span>
          <div className="flex-1 h-6 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-full rounded transition-all"
              style={{ width: `${(step.count / max) * 100}%`, backgroundColor: step.color }}
            />
          </div>
          <span className="text-sm font-mono text-zinc-300 w-12">{step.count}</span>
          {i > 0 && (
            <span className="text-xs text-zinc-500 w-12">
              {steps[i - 1].count > 0
                ? `${Math.round((step.count / steps[i - 1].count) * 100)}%`
                : '—'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

**Step 5: Verify build**

```bash
cd dashboard && npm run build
```

**Step 6: Commit**

```bash
git add dashboard/src/components/charts/
git commit -m "feat(dashboard): add recharts chart components — DailyPnlBar, EquityCurve, BalanceArea, FunnelBar"
```

---

## Task 3: PnL Header component

**Files:**
- Create: `dashboard/src/components/PnlHeader.tsx`

**Step 1: Create PnlHeader**

Create `dashboard/src/components/PnlHeader.tsx`:

```tsx
import { useState } from 'react';

interface PnlHeaderProps {
  todayPnl: number;
  todayPct: number;
  weekPnl: number;
  monthPnl: number;
  allTimePnl: number;
  totalProfit: number;
  totalLoss: number;
  onRangeChange: (range: '7D' | '1M' | '3M' | 'ALL') => void;
  selectedRange: '7D' | '1M' | '3M' | 'ALL';
}

const pnlColor = (v: number) => (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-zinc-300');

export function PnlHeader({
  todayPnl, todayPct, weekPnl, monthPnl, allTimePnl,
  totalProfit, totalLoss, onRangeChange, selectedRange,
}: PnlHeaderProps) {
  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
      {/* Today's PnL — hero */}
      <div className="mb-4">
        <div className="text-zinc-400 text-sm mb-1">Today's PnL</div>
        <div className="flex items-baseline gap-3">
          <span className={`text-3xl font-bold font-mono ${pnlColor(todayPct)}`}>
            {todayPct >= 0 ? '+' : ''}{todayPct.toFixed(2)}%
          </span>
          <span className={`text-sm ${pnlColor(todayPnl)}`}>
            {todayPnl >= 0 ? '+' : ''}{todayPnl.toFixed(2)} USD
          </span>
        </div>
      </div>

      {/* Period PnLs */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        {[
          { label: '7D PnL', value: weekPnl },
          { label: '30D PnL', value: monthPnl },
          { label: 'All-time PnL', value: allTimePnl },
        ].map(({ label, value }) => (
          <div key={label}>
            <div className="text-zinc-500 text-xs">{label}</div>
            <div className={`text-lg font-mono font-semibold ${pnlColor(value)}`}>
              {value >= 0 ? '+' : ''}{value.toFixed(2)}
            </div>
            <div className={`text-xs ${pnlColor(value)}`}>{value.toFixed(2)} USD</div>
          </div>
        ))}
      </div>

      {/* Range tabs */}
      <div className="flex gap-2 mb-3">
        {(['7D', '1M', '3M', 'ALL'] as const).map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`text-xs px-3 py-1 rounded ${
              selectedRange === r ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Profit/Loss summary */}
      <div className="border-t border-zinc-800 pt-3 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-zinc-400">Total Profit</span>
          <span className="text-green-400 font-mono">{totalProfit.toFixed(2)} USD</span>
        </div>
        <div className="flex justify-between">
          <span className="text-zinc-400">Total Loss</span>
          <span className="text-red-400 font-mono">{totalLoss.toFixed(2)} USD</span>
        </div>
        <div className="flex justify-between font-semibold">
          <span className="text-zinc-300">Net Profit/Loss</span>
          <span className={`font-mono ${pnlColor(totalProfit + totalLoss)}`}>
            {(totalProfit + totalLoss).toFixed(2)} USD
          </span>
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
git add dashboard/src/components/PnlHeader.tsx
git commit -m "feat(dashboard): add PnlHeader component — Binance-style PnL metrics"
```

---

## Task 4: Data hooks for Overview + Decisions pages

**Files:**
- Create: `dashboard/src/hooks/usePnlData.ts`
- Create: `dashboard/src/hooks/useFunnelData.ts`
- Create: `dashboard/src/hooks/useBalanceHistory.ts`

**Step 1: usePnlData — fetches trade_closes, computes daily/cumulative/period PnL**

Create `dashboard/src/hooks/usePnlData.ts`:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';

interface TradeClose {
  pnl_usd: number;
  pnl_pct: number;
  closed_at: string;
}

interface DailyPnl { date: string; pnl: number; }

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export function usePnlData(range: '7D' | '1M' | '3M' | 'ALL') {
  const [closes, setCloses] = useState<TradeClose[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      let query = supabase
        .from('trade_closes')
        .select('pnl_usd, pnl_pct, closed_at')
        .order('closed_at', { ascending: true });

      if (range !== 'ALL') {
        const days = range === '7D' ? 7 : range === '1M' ? 30 : 90;
        query = query.gte('closed_at', daysAgo(days));
      }

      const { data } = await query;
      setCloses(data ?? []);
      setLoading(false);
    };
    load();
  }, [range]);

  const dailyPnl: DailyPnl[] = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of closes) {
      const date = c.closed_at.slice(0, 10);
      map.set(date, (map.get(date) ?? 0) + Number(c.pnl_usd));
    }
    return Array.from(map, ([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }));
  }, [closes]);

  const cumulative = useMemo(() => {
    let sum = 0;
    return closes.map((c) => {
      sum += Number(c.pnl_usd);
      return { date: c.closed_at.slice(0, 10), cumPnl: Math.round(sum * 100) / 100 };
    });
  }, [closes]);

  const totalProfit = useMemo(
    () => closes.filter((c) => Number(c.pnl_usd) > 0).reduce((s, c) => s + Number(c.pnl_usd), 0),
    [closes],
  );
  const totalLoss = useMemo(
    () => closes.filter((c) => Number(c.pnl_usd) < 0).reduce((s, c) => s + Number(c.pnl_usd), 0),
    [closes],
  );

  const todayPnl = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return closes
      .filter((c) => c.closed_at.startsWith(today))
      .reduce((s, c) => s + Number(c.pnl_usd), 0);
  }, [closes]);

  const periodPnl = (days: number) =>
    closes
      .filter((c) => new Date(c.closed_at).getTime() > Date.now() - days * 86400_000)
      .reduce((s, c) => s + Number(c.pnl_usd), 0);

  return {
    loading,
    dailyPnl,
    cumulative,
    totalProfit,
    totalLoss,
    todayPnl,
    weekPnl: periodPnl(7),
    monthPnl: periodPnl(30),
    allTimePnl: closes.reduce((s, c) => s + Number(c.pnl_usd), 0),
  };
}
```

**Step 2: useFunnelData — fetches decision pipeline counts**

Create `dashboard/src/hooks/useFunnelData.ts`:

```tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface FunnelData {
  totalCycles: number;
  totalDecisions: number;
  preflightRejected: number;
  riskPassed: number;
  riskRejected: number;
  executed: number;
  orderFailed: number;
  closedTp: number;
  closedSl: number;
  closedManual: number;
  rejectionReasons: { reason: string; count: number }[];
}

export function useFunnelData() {
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const [cycles, decisions, riskVals, executions, closes, preflightErrors, orderErrors] =
        await Promise.all([
          supabase.from('cycles').select('id', { count: 'exact', head: true }),
          supabase.from('trade_decisions').select('id, action'),
          supabase.from('risk_validations').select('passed, rejection_reason'),
          supabase.from('trade_executions').select('id'),
          supabase.from('trade_closes').select('exit_reason'),
          supabase.from('errors').select('id').eq('code', 'LLM_PREFLIGHT_WARNING'),
          supabase.from('errors').select('id').eq('code', 'ORDER_FAIL'),
        ]);

      // Only count LONG/SHORT decisions (not HOLD/CLOSE/ADJUST)
      const tradeDecisions = (decisions.data ?? []).filter(
        (d) => d.action === 'LONG' || d.action === 'SHORT',
      );

      const riskArr = riskVals.data ?? [];
      const riskPassed = riskArr.filter((r) => r.passed).length;
      const riskRejected = riskArr.filter((r) => !r.passed).length;

      // Rejection reason aggregation
      const reasonMap = new Map<string, number>();
      riskArr.filter((r) => !r.passed).forEach((r) => {
        const reason = r.rejection_reason || 'unknown';
        reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
      });
      // Add preflight as a reason
      const preflightCount = preflightErrors.data?.length ?? 0;
      if (preflightCount > 0) reasonMap.set('preflight_filter', preflightCount);
      const orderFailCount = orderErrors.data?.length ?? 0;
      if (orderFailCount > 0) reasonMap.set('order_fail', orderFailCount);

      const closesArr = closes.data ?? [];

      setData({
        totalCycles: cycles.count ?? 0,
        totalDecisions: tradeDecisions.length,
        preflightRejected: preflightCount,
        riskPassed,
        riskRejected,
        executed: executions.data?.length ?? 0,
        orderFailed: orderFailCount,
        closedTp: closesArr.filter((c) => c.exit_reason === 'TP').length,
        closedSl: closesArr.filter((c) => c.exit_reason === 'SL').length,
        closedManual: closesArr.filter((c) => c.exit_reason !== 'TP' && c.exit_reason !== 'SL').length,
        rejectionReasons: Array.from(reasonMap, ([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      });
      setLoading(false);
    };
    load();
  }, []);

  return { data, loading };
}
```

**Step 3: useBalanceHistory**

Create `dashboard/src/hooks/useBalanceHistory.ts`:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';

interface CycleBalance {
  balance: number;
  created_at: string;
}

export function useBalanceHistory() {
  const [raw, setRaw] = useState<CycleBalance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('cycles')
      .select('balance, created_at')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setRaw(data ?? []);
        setLoading(false);
      });
  }, []);

  // Deduplicate by date — keep last balance per day
  const data = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of raw) {
      map.set(c.created_at.slice(0, 10), Number(c.balance));
    }
    return Array.from(map, ([date, balance]) => ({ date, balance }));
  }, [raw]);

  return { data, loading };
}
```

**Step 4: Verify build**

```bash
cd dashboard && npm run build
```

**Step 5: Commit**

```bash
git add dashboard/src/hooks/
git commit -m "feat(dashboard): add data hooks — usePnlData, useFunnelData, useBalanceHistory"
```

---

## Task 5: Rewrite Overview page

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx` (full rewrite)

**Step 1: Rewrite Overview.tsx**

Replace entire content of `dashboard/src/pages/Overview.tsx` with:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { PnlHeader } from '../components/PnlHeader';
import { DailyPnlBar } from '../components/charts/DailyPnlBar';
import { EquityCurve } from '../components/charts/EquityCurve';
import { BalanceArea } from '../components/charts/BalanceArea';
import { FunnelBar } from '../components/charts/FunnelBar';
import { StatCard } from '../components/StatCard';
import { PositionTable } from '../components/PositionTable';
import { ErrorFeed } from '../components/ErrorFeed';
import { usePnlData } from '../hooks/usePnlData';
import { useFunnelData } from '../hooks/useFunnelData';
import { useBalanceHistory } from '../hooks/useBalanceHistory';

export function Overview() {
  const [range, setRange] = useState<'7D' | '1M' | '3M' | 'ALL'>('7D');
  const pnl = usePnlData(range);
  const funnel = useFunnelData();
  const balance = useBalanceHistory();

  // Existing: cycle, positions, errors, watchdog
  const [cycle, setCycle] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [lastSnapshotAge, setLastSnapshotAge] = useState<number | null>(null);

  const fetchLive = useCallback(() => {
    supabase.from('cycles').select('*').order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => data?.[0] && setCycle(data[0]));
    supabase.rpc('get_open_positions').then(({ data }) => data && setPositions(data));
    const twoH = new Date(Date.now() - 7200_000).toISOString();
    supabase.from('errors').select('code, message, created_at')
      .gte('created_at', twoH).order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => data && setErrors(data));
    const oneH = new Date(Date.now() - 3600_000).toISOString();
    supabase.from('market_snapshots').select('id', { count: 'exact', head: true })
      .gte('created_at', oneH).then(({ count }) => setSnapshotCount(count ?? 0));
    supabase.from('market_snapshots').select('created_at')
      .order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data?.[0]) setLastSnapshotAge(Math.round((Date.now() - new Date(data[0].created_at).getTime()) / 1000));
      });
  }, []);

  useEffect(() => { fetchLive(); const iv = setInterval(fetchLive, 30_000); return () => clearInterval(iv); }, [fetchLive]);

  useEffect(() => {
    const ch = supabase.channel('errors-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'errors' },
        (p) => setErrors((prev) => [p.new as any, ...prev].slice(0, 20)))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const cycleAge = cycle?.created_at ? Math.round((Date.now() - new Date(cycle.created_at).getTime()) / 60_000) : null;
  const watchdogOk = lastSnapshotAge !== null && lastSnapshotAge < 120;
  const pnlColor = (cycle?.session_pnl ?? 0) > 0 ? 'green' : (cycle?.session_pnl ?? 0) < 0 ? 'red' : 'default' as const;

  // Compute todayPct from balance
  const balanceNum = Number(cycle?.balance || 1);
  const todayPct = balanceNum > 0 ? (pnl.todayPnl / balanceNum) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold">Overview</h1>
        {cycleAge !== null && <span className="text-xs text-zinc-500">Last cycle: {cycleAge}m ago</span>}
      </div>

      {/* PnL Header */}
      <PnlHeader
        todayPnl={pnl.todayPnl}
        todayPct={todayPct}
        weekPnl={pnl.weekPnl}
        monthPnl={pnl.monthPnl}
        allTimePnl={pnl.allTimePnl}
        totalProfit={pnl.totalProfit}
        totalLoss={Math.abs(pnl.totalLoss)}
        onRangeChange={setRange}
        selectedRange={range}
      />

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Daily PnL</h3>
          <DailyPnlBar data={pnl.dailyPnl} />
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Cumulative PnL</h3>
          <EquityCurve data={pnl.cumulative} />
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Balance</h3>
          <BalanceArea data={balance.data} />
        </div>
      </div>

      {/* Bot Status Strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Wallet Balance" value={`$${Number(cycle?.balance || 0).toFixed(2)}`} />
        <StatCard label="Session PnL" value={`$${Number(cycle?.session_pnl || 0).toFixed(2)}`} color={pnlColor} />
        <StatCard label="Regime" value={cycle?.regime || '—'} subtitle={`F&G: ${cycle?.fear_greed_value ?? '—'} | Layer: ${cycle?.layer ?? '—'}`} />
        <StatCard label="Watchdog" value={watchdogOk ? 'Healthy' : 'Stale'} subtitle={`${snapshotCount} snaps/h`} color={watchdogOk ? 'green' : 'red'} />
      </div>

      {/* Mini Funnel */}
      {funnel.data && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Decision Pipeline</h3>
          <FunnelBar steps={[
            { label: 'Cycles', count: funnel.data.totalCycles, color: '#71717a' },
            { label: 'Decisions', count: funnel.data.totalDecisions, color: '#60a5fa' },
            { label: 'Risk Passed', count: funnel.data.riskPassed, color: '#eab308' },
            { label: 'Executed', count: funnel.data.executed, color: '#4ade80' },
            { label: 'Closed', count: funnel.data.closedTp + funnel.data.closedSl + funnel.data.closedManual, color: '#a78bfa' },
          ]} />
        </div>
      )}

      {/* Positions + Errors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-zinc-900 rounded-lg border border-zinc-800">
          <div className="p-3 border-b border-zinc-800 text-sm font-semibold text-zinc-300">Open Positions</div>
          <PositionTable positions={positions} />
        </div>
        <div className="bg-zinc-900 rounded-lg border border-zinc-800">
          <div className="p-3 border-b border-zinc-800 text-sm font-semibold text-zinc-300">Recent Errors (2h)</div>
          <ErrorFeed errors={errors} />
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

**Step 3: Visually test**

```bash
cd dashboard && npm run dev
```
Open http://localhost:5173/ — verify PnL header, 3 charts, status strip, funnel, positions, errors render.

**Step 4: Commit**

```bash
git add dashboard/src/pages/Overview.tsx
git commit -m "feat(dashboard): rewrite Overview — PnL header, charts, decision funnel, status strip"
```

---

## Task 6: Add Decisions page (Analytics)

**Files:**
- Create: `dashboard/src/pages/Decisions.tsx`
- Modify: `dashboard/src/App.tsx:7-12,33-37` — add route

**Step 1: Create Decisions page**

Create `dashboard/src/pages/Decisions.tsx`:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { FunnelBar } from '../components/charts/FunnelBar';
import { useFunnelData } from '../hooks/useFunnelData';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line } from 'recharts';

export function Decisions() {
  const funnel = useFunnelData();

  // Volume filter trend: preflight warnings per hour
  const [volumeTrend, setVolumeTrend] = useState<{ hour: string; count: number }[]>([]);
  useEffect(() => {
    supabase
      .from('errors')
      .select('created_at')
      .eq('code', 'LLM_PREFLIGHT_WARNING')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        const map = new Map<string, number>();
        for (const e of data) {
          const h = e.created_at.slice(0, 13); // YYYY-MM-DDTHH
          map.set(h, (map.get(h) ?? 0) + 1);
        }
        setVolumeTrend(Array.from(map, ([hour, count]) => ({
          hour: hour.slice(5, 16).replace('T', ' '),
          count,
        })));
      });
  }, []);

  // Regime performance
  const [regimePerf, setRegimePerf] = useState<any[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase
        .from('trade_decisions')
        .select('id, regime, action, confidence');
      const { data: execs } = await supabase
        .from('trade_executions')
        .select('decision_id');
      const { data: closes } = await supabase
        .from('trade_closes')
        .select('execution_id, pnl_usd, exit_reason');
      const { data: execFull } = await supabase
        .from('trade_executions')
        .select('id, decision_id');

      if (!decs) return;
      const execSet = new Set((execs ?? []).map((e) => e.decision_id));
      const execMap = new Map((execFull ?? []).map((e) => [e.id, e.decision_id]));
      const closesByDecision = new Map<number, typeof closes>();
      for (const c of closes ?? []) {
        const decId = execMap.get(c.execution_id);
        if (decId) {
          const arr = closesByDecision.get(decId) ?? [];
          arr.push(c);
          closesByDecision.set(decId, arr);
        }
      }

      const regimeMap = new Map<string, { decisions: number; executed: number; wins: number; totalPnl: number }>();
      for (const d of decs) {
        if (d.action !== 'LONG' && d.action !== 'SHORT') continue;
        const r = d.regime || 'Unknown';
        const entry = regimeMap.get(r) ?? { decisions: 0, executed: 0, wins: 0, totalPnl: 0 };
        entry.decisions++;
        if (execSet.has(d.id)) {
          entry.executed++;
          const cls = closesByDecision.get(d.id) ?? [];
          for (const c of cls) {
            const pnl = Number(c.pnl_usd);
            entry.totalPnl += pnl;
            if (pnl > 0) entry.wins++;
          }
        }
        regimeMap.set(r, entry);
      }

      setRegimePerf(Array.from(regimeMap, ([regime, v]) => ({
        regime,
        ...v,
        convPct: v.decisions > 0 ? Math.round((v.executed / v.decisions) * 100) : 0,
        winRate: v.executed > 0 ? Math.round((v.wins / v.executed) * 100) : 0,
      })));
    };
    load();
  }, []);

  // Pair performance
  const [pairPerf, setPairPerf] = useState<any[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data: closes } = await supabase
        .from('trade_closes')
        .select('pair, pnl_usd, held_hours, exit_reason');
      if (!closes) return;
      const map = new Map<string, { trades: number; wins: number; totalPnl: number; totalHours: number }>();
      for (const c of closes) {
        const entry = map.get(c.pair) ?? { trades: 0, wins: 0, totalPnl: 0, totalHours: 0 };
        entry.trades++;
        const pnl = Number(c.pnl_usd);
        entry.totalPnl += pnl;
        if (pnl > 0) entry.wins++;
        entry.totalHours += Number(c.held_hours ?? 0);
        map.set(c.pair, entry);
      }
      setPairPerf(Array.from(map, ([pair, v]) => ({
        pair,
        ...v,
        winRate: v.trades > 0 ? Math.round((v.wins / v.trades) * 100) : 0,
        avgHold: v.trades > 0 ? (v.totalHours / v.trades).toFixed(1) : '—',
      })));
    };
    load();
  }, []);

  // Confidence distribution
  const [confDist, setConfDist] = useState<{ bucket: string; passed: number; failed: number }[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase
        .from('trade_decisions')
        .select('id, confidence, action');
      const { data: risks } = await supabase
        .from('risk_validations')
        .select('decision_id, passed');
      if (!decs || !risks) return;

      const riskMap = new Map(risks.map((r) => [r.decision_id, r.passed]));
      const buckets = new Map<string, { passed: number; failed: number }>();

      for (const d of decs) {
        if (d.action !== 'LONG' && d.action !== 'SHORT') continue;
        const conf = d.confidence ?? 0;
        const bucket = `${Math.floor(conf / 10) * 10}-${Math.floor(conf / 10) * 10 + 9}`;
        const entry = buckets.get(bucket) ?? { passed: 0, failed: 0 };
        if (riskMap.get(d.id)) entry.passed++;
        else entry.failed++;
        buckets.set(bucket, entry);
      }

      setConfDist(
        Array.from(buckets, ([bucket, v]) => ({ bucket, ...v }))
          .sort((a, b) => a.bucket.localeCompare(b.bucket)),
      );
    };
    load();
  }, []);

  // LLM Layer usage
  const [layerUsage, setLayerUsage] = useState<{ layer: string; count: number }[]>([]);
  useEffect(() => {
    supabase.from('cycles').select('layer').then(({ data }) => {
      if (!data) return;
      const map = new Map<string, number>();
      for (const c of data) {
        const l = `Layer ${c.layer ?? '?'}`;
        map.set(l, (map.get(l) ?? 0) + 1);
      }
      setLayerUsage(Array.from(map, ([layer, count]) => ({ layer, count })));
    });
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Decision Analytics</h1>

      {/* Funnel */}
      {funnel.data && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Decision Pipeline Funnel</h3>
          <FunnelBar steps={[
            { label: 'Cycles', count: funnel.data.totalCycles, color: '#71717a' },
            { label: 'Trade Decisions', count: funnel.data.totalDecisions, color: '#60a5fa' },
            { label: 'Risk Passed', count: funnel.data.riskPassed, color: '#eab308' },
            { label: 'Executed', count: funnel.data.executed, color: '#4ade80' },
            { label: 'Closed TP', count: funnel.data.closedTp, color: '#4ade80' },
            { label: 'Closed SL', count: funnel.data.closedSl, color: '#f87171' },
            { label: 'Closed Other', count: funnel.data.closedManual, color: '#a78bfa' },
          ]} />
        </div>
      )}

      {/* Rejection Breakdown */}
      {funnel.data && funnel.data.rejectionReasons.length > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Rejection Breakdown</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={funnel.data.rejectionReasons} layout="vertical" margin={{ left: 120 }}>
              <XAxis type="number" tick={{ fill: '#71717a', fontSize: 11 }} />
              <YAxis type="category" dataKey="reason" tick={{ fill: '#a1a1aa', fontSize: 11 }} width={120} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Bar dataKey="count" fill="#f87171" radius={[0, 3, 3, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Confidence Distribution */}
        {confDist.length > 0 && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4">Confidence Distribution</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={confDist}>
                <XAxis dataKey="bucket" tick={{ fill: '#71717a', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
                <Bar dataKey="passed" stackId="a" fill="#4ade80" name="Passed" />
                <Bar dataKey="failed" stackId="a" fill="#f87171" name="Failed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Volume Filter Trend */}
        {volumeTrend.length > 0 && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4">Preflight Rejections Over Time</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={volumeTrend}>
                <XAxis dataKey="hour" tick={{ fill: '#71717a', fontSize: 10 }} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
                <Line type="monotone" dataKey="count" stroke="#f59e0b" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* LLM Layer Usage */}
        {layerUsage.length > 0 && (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4">LLM Layer Usage</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={layerUsage}>
                <XAxis dataKey="layer" tick={{ fill: '#71717a', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
                <Bar dataKey="count" fill="#60a5fa" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Regime Performance Table */}
      {regimePerf.length > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Regime Performance</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-400 border-b border-zinc-800 text-left">
                <th className="p-2">Regime</th>
                <th className="p-2 text-right">Decisions</th>
                <th className="p-2 text-right">Conv%</th>
                <th className="p-2 text-right">Win Rate</th>
                <th className="p-2 text-right">Total PnL</th>
              </tr>
            </thead>
            <tbody>
              {regimePerf.map((r) => (
                <tr key={r.regime} className="border-b border-zinc-800/50">
                  <td className="p-2 font-mono">{r.regime}</td>
                  <td className="p-2 text-right">{r.decisions}</td>
                  <td className="p-2 text-right">{r.convPct}%</td>
                  <td className="p-2 text-right">{r.executed > 0 ? `${r.winRate}%` : '—'}</td>
                  <td className={`p-2 text-right font-mono ${r.totalPnl > 0 ? 'text-green-400' : r.totalPnl < 0 ? 'text-red-400' : ''}`}>
                    {r.totalPnl !== 0 ? `$${r.totalPnl.toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pair Performance Table */}
      {pairPerf.length > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Pair Performance</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-400 border-b border-zinc-800 text-left">
                <th className="p-2">Pair</th>
                <th className="p-2 text-right">Trades</th>
                <th className="p-2 text-right">Win Rate</th>
                <th className="p-2 text-right">Avg Hold</th>
                <th className="p-2 text-right">Total PnL</th>
              </tr>
            </thead>
            <tbody>
              {pairPerf.map((p) => (
                <tr key={p.pair} className="border-b border-zinc-800/50">
                  <td className="p-2 font-mono">{p.pair}</td>
                  <td className="p-2 text-right">{p.trades}</td>
                  <td className="p-2 text-right">{p.winRate}%</td>
                  <td className="p-2 text-right">{p.avgHold}h</td>
                  <td className={`p-2 text-right font-mono ${p.totalPnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    ${p.totalPnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Add route in App.tsx**

In `dashboard/src/App.tsx`:
- Add import: `import { Decisions } from './pages/Decisions';`
- Add nav item: `{ to: '/decisions', label: 'Decisions' }` after Overview
- Add Route: `<Route path="/decisions" element={<Decisions />} />`

**Step 3: Verify build + visual test**

```bash
cd dashboard && npm run build && npm run dev
```
Open http://localhost:5173/decisions — verify funnel, charts, tables render.

**Step 4: Commit**

```bash
git add dashboard/src/pages/Decisions.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): add Decisions analytics page — funnel, rejection breakdown, regime/pair tables"
```

---

## Task 7: Enhance Trades page with status badges + filters

**Files:**
- Modify: `dashboard/src/pages/Trades.tsx` (rewrite)

**Step 1: Rewrite Trades.tsx with status badges and decision funnel per trade**

Replace entire content of `dashboard/src/pages/Trades.tsx`:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { TradeTimeline } from '../components/TradeTimeline';

interface DecisionRow {
  id: number;
  pair: string;
  action: string;
  confidence: number;
  reasoning: string;
  regime: string;
  created_at: string;
  cycle_id: number;
  // joined
  risk_passed?: boolean;
  risk_reason?: string;
  executed?: boolean;
  close_pnl?: number;
  close_reason?: string;
}

type StatusBadge = 'PREFLIGHT_FAIL' | 'RISK_REJECTED' | 'ORDER_FAIL' | 'OPEN' | 'TP' | 'SL' | 'MANUAL' | 'PENDING';

const badgeColors: Record<StatusBadge, string> = {
  PREFLIGHT_FAIL: 'bg-orange-900 text-orange-300',
  RISK_REJECTED: 'bg-red-900 text-red-300',
  ORDER_FAIL: 'bg-red-900 text-red-300',
  OPEN: 'bg-blue-900 text-blue-300',
  TP: 'bg-green-900 text-green-300',
  SL: 'bg-red-900 text-red-300',
  MANUAL: 'bg-zinc-700 text-zinc-300',
  PENDING: 'bg-zinc-800 text-zinc-400',
};

interface TimelineEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

export function Trades() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [filterPair, setFilterPair] = useState('');
  const [filterAction, setFilterAction] = useState('');

  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase
        .from('trade_decisions')
        .select('id, pair, action, confidence, reasoning, regime, created_at, cycle_id')
        .order('created_at', { ascending: false })
        .limit(100);
      if (!decs) return;

      const decIds = decs.map((d) => d.id);
      const [risks, execs] = await Promise.all([
        supabase.from('risk_validations').select('decision_id, passed, rejection_reason').in('decision_id', decIds),
        supabase.from('trade_executions').select('id, decision_id').in('decision_id', decIds),
      ]);

      const execIds = (execs.data ?? []).map((e) => e.id);
      const { data: closes } = execIds.length
        ? await supabase.from('trade_closes').select('execution_id, pnl_usd, exit_reason').in('execution_id', execIds)
        : { data: [] };

      const riskMap = new Map((risks.data ?? []).map((r) => [r.decision_id, r]));
      const execMap = new Map((execs.data ?? []).map((e) => [e.decision_id, e]));
      const closeMap = new Map((closes ?? []).map((c) => [c.execution_id, c]));

      const enriched = decs.map((d) => {
        const risk = riskMap.get(d.id);
        const exec = execMap.get(d.id);
        const close = exec ? closeMap.get(exec.id) : undefined;
        return {
          ...d,
          risk_passed: risk?.passed,
          risk_reason: risk?.rejection_reason,
          executed: !!exec,
          close_pnl: close ? Number(close.pnl_usd) : undefined,
          close_reason: close?.exit_reason,
        };
      });

      setDecisions(enriched);
    };
    load();
  }, []);

  const getStatus = (d: DecisionRow): StatusBadge => {
    if (d.action === 'HOLD' || d.action === 'ADJUST' || d.action === 'CLOSE') return 'PENDING';
    if (d.risk_passed === false) return 'RISK_REJECTED';
    if (!d.executed && d.risk_passed) return 'ORDER_FAIL';
    if (!d.executed) return 'PENDING';
    if (d.close_reason === 'TP') return 'TP';
    if (d.close_reason === 'SL') return 'SL';
    if (d.close_reason) return 'MANUAL';
    return 'OPEN';
  };

  const pairs = useMemo(() => [...new Set(decisions.map((d) => d.pair))], [decisions]);
  const filtered = useMemo(() => {
    return decisions.filter((d) => {
      if (filterPair && d.pair !== filterPair) return false;
      if (filterAction && d.action !== filterAction) return false;
      return true;
    });
  }, [decisions, filterPair, filterAction]);

  // Timeline loader (existing logic, kept)
  useEffect(() => {
    if (!selectedId) return;
    const decision = decisions.find((d) => d.id === selectedId);
    if (!decision) return;

    const loadTimeline = async () => {
      const events: TimelineEvent[] = [
        { type: 'decision', time: decision.created_at, data: decision },
      ];
      const [risk, exec, err] = await Promise.all([
        supabase.from('risk_validations').select('*').eq('decision_id', selectedId),
        supabase.from('trade_executions').select('*').eq('decision_id', selectedId),
        supabase.from('errors').select('*').eq('cycle_id', decision.cycle_id).eq('code', 'ORDER_FAIL'),
      ]);
      risk.data?.forEach((r) => events.push({ type: 'risk', time: r.created_at, data: r }));
      err.data?.forEach((e) => events.push({ type: 'error', time: e.created_at, data: e }));
      for (const ex of exec.data || []) {
        events.push({ type: 'execution', time: ex.opened_at, data: ex });
        const { data: closes } = await supabase.from('trade_closes').select('*').eq('execution_id', ex.id);
        closes?.forEach((c) => events.push({ type: 'close', time: c.closed_at, data: c }));
      }
      setTimeline(events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()));
    };
    loadTimeline();
  }, [selectedId, decisions]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Trade Decisions</h1>

      {/* Filters */}
      <div className="flex gap-3 text-sm">
        <select value={filterPair} onChange={(e) => setFilterPair(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1">
          <option value="">All Pairs</option>
          {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1">
          <option value="">All Actions</option>
          {['LONG', 'SHORT', 'CLOSE', 'HOLD', 'ADJUST'].map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="text-zinc-500 self-center">{filtered.length} decisions</span>
      </div>

      <div className="flex gap-6">
        {/* Decision list */}
        <div className="w-2/5 space-y-1 max-h-[75vh] overflow-y-auto">
          {filtered.map((d) => {
            const status = getStatus(d);
            return (
              <button
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className={`w-full text-left p-3 rounded text-sm ${
                  selectedId === d.id ? 'bg-zinc-800 border border-zinc-700' : 'hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex justify-between items-center">
                  <span className="font-mono">{d.pair}</span>
                  <div className="flex gap-2 items-center">
                    <span className={`text-xs px-2 py-0.5 rounded ${badgeColors[status]}`}>{status}</span>
                    <span className={
                      d.action === 'HOLD' ? 'text-zinc-500' :
                      d.action === 'CLOSE' ? 'text-purple-400' :
                      d.action === 'SHORT' ? 'text-red-400' : 'text-green-400'
                    }>{d.action}</span>
                  </div>
                </div>
                <div className="text-zinc-500 text-xs mt-1">
                  {new Date(d.created_at).toLocaleString()} | conf:{d.confidence} | {d.regime}
                  {d.close_pnl !== undefined && (
                    <span className={d.close_pnl > 0 ? ' text-green-400' : ' text-red-400'}>
                      {' '}| ${d.close_pnl.toFixed(2)}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Timeline */}
        <div className="flex-1">
          <h2 className="text-lg font-bold mb-3">Decision Lifecycle</h2>
          {selectedId ? (
            <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
              <TradeTimeline events={timeline} />
            </div>
          ) : (
            <div className="text-zinc-500 text-sm">Select a decision to see its full lifecycle funnel</div>
          )}
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
git add dashboard/src/pages/Trades.tsx
git commit -m "feat(dashboard): enhance Trades page — status badges, filters, enriched decision cards"
```

---

## Task 8: Add Market page

**Files:**
- Create: `dashboard/src/pages/Market.tsx`
- Modify: `dashboard/src/App.tsx` — add route

**Step 1: Create Market page**

Create `dashboard/src/pages/Market.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#eab308', '#a78bfa', '#fb923c', '#2dd4bf', '#f472b6'];

export function Market() {
  const [pairs, setPairs] = useState<string[]>([]);
  const [selectedPair, setSelectedPair] = useState('BTCUSDT');
  const [priceData, setPriceData] = useState<any[]>([]);
  const [fundingData, setFundingData] = useState<any[]>([]);
  const [oiData, setOiData] = useState<any[]>([]);
  const [regimeData, setRegimeData] = useState<any[]>([]);

  // Get available pairs
  useEffect(() => {
    supabase
      .from('market_snapshots')
      .select('pair')
      .then(({ data }) => {
        if (!data) return;
        const unique = [...new Set(data.map((d) => d.pair))].sort();
        setPairs(unique);
      });
  }, []);

  // Fetch pair-specific data
  useEffect(() => {
    const last24h = new Date(Date.now() - 86400_000).toISOString();

    // Price
    supabase
      .from('market_snapshots')
      .select('mark_price, created_at')
      .eq('pair', selectedPair)
      .gte('created_at', last24h)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setPriceData(
          (data ?? []).map((d) => ({
            time: d.created_at.slice(11, 16),
            price: Number(d.mark_price),
          })),
        );
      });

    // Funding rate
    supabase
      .from('market_snapshots')
      .select('funding_rate, created_at')
      .eq('pair', selectedPair)
      .gte('created_at', last24h)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setFundingData(
          (data ?? []).map((d) => ({
            time: d.created_at.slice(11, 16),
            rate: Number(d.funding_rate) * 100,
          })),
        );
      });

    // OI
    supabase
      .from('market_snapshots')
      .select('open_interest, created_at')
      .eq('pair', selectedPair)
      .gte('created_at', last24h)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        setOiData(
          (data ?? []).map((d) => ({
            time: d.created_at.slice(11, 16),
            oi: Number(d.open_interest),
          })),
        );
      });
  }, [selectedPair]);

  // Regime timeline
  useEffect(() => {
    supabase
      .from('cycles')
      .select('regime, regime_confidence, created_at')
      .order('created_at', { ascending: true })
      .limit(200)
      .then(({ data }) => {
        setRegimeData(
          (data ?? []).map((d) => ({
            time: d.created_at.slice(5, 16).replace('T', ' '),
            regime: d.regime,
            confidence: Number(d.regime_confidence ?? 0),
          })),
        );
      });
  }, []);

  const regimeColors: Record<string, string> = {
    BullTrend: '#4ade80', BearTrend: '#f87171', Range: '#eab308',
    Breakout: '#a78bfa', Capitulation: '#ef4444',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Market Data</h1>
        <select
          value={selectedPair}
          onChange={(e) => setSelectedPair(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
        >
          {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Price chart */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">{selectedPair} Price (24h)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={priceData}>
              <XAxis dataKey="time" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis domain={['auto', 'auto']} tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Line type="monotone" dataKey="price" stroke="#60a5fa" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Funding rate */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Funding Rate %</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={fundingData}>
              <XAxis dataKey="time" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Line type="monotone" dataKey="rate" stroke="#eab308" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* OI */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Open Interest</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={oiData}>
              <XAxis dataKey="time" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Line type="monotone" dataKey="oi" stroke="#4ade80" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Regime timeline */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Regime Over Time</h3>
          <div className="flex gap-px h-8 rounded overflow-hidden mb-2">
            {regimeData.map((d, i) => (
              <div
                key={i}
                className="flex-1"
                style={{ backgroundColor: regimeColors[d.regime] ?? '#3f3f46' }}
                title={`${d.time}: ${d.regime} (${d.confidence}%)`}
              />
            ))}
          </div>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(regimeColors).map(([r, c]) => (
              <div key={r} className="flex items-center gap-1 text-xs text-zinc-400">
                <div className="w-3 h-3 rounded" style={{ backgroundColor: c }} />
                {r}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Add route in App.tsx**

Add import and route for Market page (after Decisions):
- `import { Market } from './pages/Market';`
- Nav item: `{ to: '/market', label: 'Market' }`
- Route: `<Route path="/market" element={<Market />} />`

**Step 3: Verify build**

```bash
cd dashboard && npm run build
```

**Step 4: Commit**

```bash
git add dashboard/src/pages/Market.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): add Market page — price, funding, OI charts + regime timeline"
```

---

## Task 9: Add LLM & Costs page

**Files:**
- Create: `dashboard/src/pages/LlmCosts.tsx`
- Modify: `dashboard/src/App.tsx` — add route

**Step 1: Create LlmCosts page**

Create `dashboard/src/pages/LlmCosts.tsx`:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend } from 'recharts';

export function LlmCosts() {
  const [tokensByDay, setTokensByDay] = useState<any[]>([]);
  const [costByMethod, setCostByMethod] = useState<any[]>([]);
  const [parseErrors, setParseErrors] = useState<{ day: string; total: number; failed: number }[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ in: 0, out: 0 });

  useEffect(() => {
    // Tokens per day
    supabase
      .from('token_usage')
      .select('tokens_in, tokens_out, cost_usd, method, created_at')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!data) return;

        // Daily aggregation
        const dayMap = new Map<string, { tokens_in: number; tokens_out: number; cost: number }>();
        const methodMap = new Map<string, number>();
        let tIn = 0, tOut = 0, tCost = 0;

        for (const row of data) {
          const day = row.created_at.slice(0, 10);
          const entry = dayMap.get(day) ?? { tokens_in: 0, tokens_out: 0, cost: 0 };
          entry.tokens_in += row.tokens_in ?? 0;
          entry.tokens_out += row.tokens_out ?? 0;
          entry.cost += Number(row.cost_usd ?? 0);
          dayMap.set(day, entry);

          const method = row.method || 'unknown';
          methodMap.set(method, (methodMap.get(method) ?? 0) + Number(row.cost_usd ?? 0));

          tIn += row.tokens_in ?? 0;
          tOut += row.tokens_out ?? 0;
          tCost += Number(row.cost_usd ?? 0);
        }

        setTokensByDay(
          Array.from(dayMap, ([day, v]) => ({
            day,
            tokens: v.tokens_in + v.tokens_out,
            cost: Math.round(v.cost * 1000) / 1000,
          })),
        );

        const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#eab308', '#a78bfa', '#fb923c', '#2dd4bf'];
        setCostByMethod(
          Array.from(methodMap, ([method, cost], i) => ({
            name: method,
            value: Math.round(cost * 1000) / 1000,
            fill: COLORS[i % COLORS.length],
          })).sort((a, b) => b.value - a.value),
        );

        setTotalCost(tCost);
        setTotalTokens({ in: tIn, out: tOut });
      });
  }, []);

  // Parse error rate
  useEffect(() => {
    supabase
      .from('llm_conversations')
      .select('parsed_ok, created_at')
      .then(({ data }) => {
        if (!data) return;
        const map = new Map<string, { total: number; failed: number }>();
        for (const row of data) {
          const day = row.created_at.slice(0, 10);
          const entry = map.get(day) ?? { total: 0, failed: 0 };
          entry.total++;
          if (row.parsed_ok === false) entry.failed++;
          map.set(day, entry);
        }
        setParseErrors(Array.from(map, ([day, v]) => ({ day, ...v })));
      });
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">LLM & Costs</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
          <div className="text-zinc-400 text-sm">Total Cost</div>
          <div className="text-2xl font-mono font-bold text-yellow-400">${totalCost.toFixed(3)}</div>
        </div>
        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
          <div className="text-zinc-400 text-sm">Tokens In</div>
          <div className="text-2xl font-mono font-bold">{(totalTokens.in / 1000).toFixed(0)}K</div>
        </div>
        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
          <div className="text-zinc-400 text-sm">Tokens Out</div>
          <div className="text-2xl font-mono font-bold">{(totalTokens.out / 1000).toFixed(0)}K</div>
        </div>
        <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
          <div className="text-zinc-400 text-sm">LLM Calls</div>
          <div className="text-2xl font-mono font-bold">{parseErrors.reduce((s, d) => s + d.total, 0)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Tokens per day */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Daily Token Usage</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tokensByDay}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Bar dataKey="tokens" fill="#60a5fa" radius={[3, 3, 0, 0]} name="Tokens" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Cost by method */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Cost by Method ($)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={costByMethod} dataKey="value" nameKey="name" cx="50%" cy="50%"
                outerRadius={80} label={({ name, value }) => `${name}: $${value}`}
                labelLine={{ stroke: '#71717a' }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Daily cost */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Daily Cost ($)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tokensByDay}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Bar dataKey="cost" fill="#eab308" radius={[3, 3, 0, 0]} name="Cost $" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Parse error rate */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Parse Error Rate</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={parseErrors}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }} />
              <Bar dataKey="total" fill="#60a5fa" radius={[3, 3, 0, 0]} name="Total calls" />
              <Bar dataKey="failed" fill="#f87171" radius={[3, 3, 0, 0]} name="Parse failures" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Add route in App.tsx**

Add import and route for LlmCosts page:
- `import { LlmCosts } from './pages/LlmCosts';`
- Nav item: `{ to: '/costs', label: 'LLM Costs' }`
- Route: `<Route path="/costs" element={<LlmCosts />} />`

**Step 3: Verify build**

```bash
cd dashboard && npm run build
```

**Step 4: Commit**

```bash
git add dashboard/src/pages/LlmCosts.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): add LLM Costs page — token usage, cost breakdown, parse errors"
```

---

## Task 10: Enhance Swarm page

**Files:**
- Modify: `dashboard/src/pages/Swarm.tsx` (rewrite)

**Step 1: Rewrite Swarm.tsx with visual vote bars**

Replace entire content of `dashboard/src/pages/Swarm.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface SwarmCycle {
  cycle_id: number;
  created_at: string;
  personas: Array<{
    persona: string;
    vote: string | null;
    confidence: number | null;
    reasoning: string;
  }>;
  judge_response?: string;
}

const personaColors: Record<string, string> = {
  risk_manager: '#eab308',
  bull_thesis: '#4ade80',
  bear_thesis: '#f87171',
  market_structure: '#60a5fa',
  devils_advocate: '#a78bfa',
  narrative_expert: '#fb923c',
};

const voteColors: Record<string, string> = {
  LONG: '#4ade80', SHORT: '#f87171', HOLD: '#71717a',
};

export function Swarm() {
  const [cycles, setCycles] = useState<SwarmCycle[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    const load = async () => {
      const { data: judges } = await supabase
        .from('llm_conversations')
        .select('cycle_id, raw_response, created_at')
        .eq('method', 'swarm_consensus')
        .order('created_at', { ascending: false })
        .limit(20);
      if (!judges?.length) return;

      const result: SwarmCycle[] = [];
      for (const j of judges) {
        const windowStart = new Date(new Date(j.created_at).getTime() - 600_000).toISOString();
        const windowEnd = new Date(new Date(j.created_at).getTime() + 600_000).toISOString();
        const { data: personas } = await supabase
          .from('swarm_personas')
          .select('persona, vote, confidence, reasoning')
          .gte('created_at', windowStart)
          .lte('created_at', windowEnd)
          .order('created_at', { ascending: true });
        result.push({
          cycle_id: j.cycle_id,
          created_at: j.created_at,
          personas: personas || [],
          judge_response: j.raw_response,
        });
      }
      setCycles(result);
    };
    load();
  }, []);

  const current = cycles[selectedIdx];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Swarm Debate</h1>
        {cycles.length > 0 && (
          <select
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(Number(e.target.value))}
          >
            {cycles.map((c, i) => (
              <option key={i} value={i}>
                Cycle {c.cycle_id} — {new Date(c.created_at).toLocaleString()} ({c.personas.length} experts)
              </option>
            ))}
          </select>
        )}
      </div>

      {current ? (
        <>
          {/* Visual vote bars */}
          {current.personas.length > 0 && (
            <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300 mb-2">Expert Votes</h3>
              {current.personas.map((p, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-36 text-xs text-right shrink-0 truncate"
                    style={{ color: personaColors[p.persona] ?? '#a1a1aa' }}>
                    {p.persona.replace(/_/g, ' ').toUpperCase()}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <div className="flex-1 h-5 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className="h-full rounded transition-all"
                        style={{
                          width: `${p.confidence ?? 0}%`,
                          backgroundColor: voteColors[p.vote ?? 'HOLD'] ?? '#71717a',
                        }}
                      />
                    </div>
                    <span className="text-xs font-mono w-8 text-right text-zinc-400">{p.confidence ?? 0}%</span>
                    <span className="text-xs w-12" style={{ color: voteColors[p.vote ?? 'HOLD'] }}>
                      {p.vote ?? '—'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Expert cards with reasoning */}
          {current.personas.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {current.personas.map((p, i) => (
                <div key={i} className="bg-zinc-900 rounded-lg border-l-4 p-4"
                  style={{ borderColor: personaColors[p.persona] ?? '#3f3f46' }}>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold text-sm">{p.persona.replace(/_/g, ' ').toUpperCase()}</span>
                    <div className="flex gap-2 text-xs">
                      {p.vote && (
                        <span style={{ color: voteColors[p.vote] ?? '#a1a1aa' }}>{p.vote}</span>
                      )}
                      {p.confidence !== null && <span className="text-zinc-500">conf: {p.confidence}</span>}
                    </div>
                  </div>
                  <p className="text-zinc-400 text-xs leading-relaxed">{p.reasoning}</p>
                </div>
              ))}
            </div>
          )}

          {/* Judge response */}
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <h3 className="text-sm font-semibold mb-2 text-zinc-300">Judge Consensus</h3>
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap max-h-64 overflow-y-auto">
              {current.judge_response}
            </pre>
          </div>
        </>
      ) : (
        <div className="text-zinc-500">No swarm debates found</div>
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
git add dashboard/src/pages/Swarm.tsx
git commit -m "feat(dashboard): enhance Swarm page — visual vote bars per persona"
```

---

## Task 11: Update App.tsx with final 6-page navigation

**Files:**
- Modify: `dashboard/src/App.tsx`

**Step 1: Final App.tsx with all 6 routes**

Replace entire `dashboard/src/App.tsx`:

```tsx
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Overview } from './pages/Overview';
import { Decisions } from './pages/Decisions';
import { Trades } from './pages/Trades';
import { Market } from './pages/Market';
import { LlmCosts } from './pages/LlmCosts';
import { Swarm } from './pages/Swarm';
import { Chat } from './pages/Chat';

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/decisions', label: 'Decisions' },
  { to: '/trades', label: 'Trades' },
  { to: '/market', label: 'Market' },
  { to: '/costs', label: 'LLM Costs' },
  { to: '/swarm', label: 'Swarm' },
  { to: '/chat', label: 'Chat' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-zinc-950 text-white">
        <nav className="border-b border-zinc-800 px-4 py-2 flex gap-1 items-center">
          <span className="text-sm font-bold text-zinc-300 mr-4">Indic Bot</span>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `text-sm px-3 py-1 rounded ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-white'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <main className="max-w-7xl mx-auto p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/market" element={<Market />} />
            <Route path="/costs" element={<LlmCosts />} />
            <Route path="/swarm" element={<Swarm />} />
            <Route path="/chat" element={<Chat />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
```

**Step 2: Final build verification**

```bash
cd dashboard && npm run build
```
Expected: success, zero errors.

**Step 3: Visual smoke test**

```bash
cd dashboard && npm run dev
```
Click through all 7 pages: Overview, Decisions, Trades, Market, LLM Costs, Swarm, Chat.

**Step 4: Commit**

```bash
git add dashboard/src/App.tsx
git commit -m "feat(dashboard): finalize 7-page navigation — Overview, Decisions, Trades, Market, LLM Costs, Swarm, Chat"
```

---

## Task Summary

| Task | What | Files |
|------|------|-------|
| 1 | Install recharts + useSupabaseQuery hook | package.json, hooks/ |
| 2 | Chart components (DailyPnlBar, EquityCurve, BalanceArea, FunnelBar) | components/charts/ |
| 3 | PnlHeader component | components/PnlHeader.tsx |
| 4 | Data hooks (usePnlData, useFunnelData, useBalanceHistory) | hooks/ |
| 5 | Rewrite Overview page | pages/Overview.tsx |
| 6 | New Decisions page | pages/Decisions.tsx |
| 7 | Enhance Trades page | pages/Trades.tsx |
| 8 | New Market page | pages/Market.tsx |
| 9 | New LLM Costs page | pages/LlmCosts.tsx |
| 10 | Enhance Swarm page | pages/Swarm.tsx |
| 11 | Final App.tsx routing | App.tsx |
