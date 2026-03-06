# Indic Bot Dashboard — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a web dashboard (Vite + React SPA) that visualizes all bot telemetry from Supabase and provides an LLM chat interface for natural-language DB exploration ("why did the bot close ADA?").

**Architecture:** React SPA reads Supabase PostgreSQL via `@supabase/supabase-js` (anon key, RLS disabled for reads). LLM chat goes through a Supabase Edge Function that receives user question + recent DB context, calls Claude API, returns streaming response. No separate backend needed.

**Tech Stack:** Vite, React 19, TypeScript, TailwindCSS v4, shadcn/ui, Recharts, @supabase/supabase-js, Supabase Edge Functions (Deno), Claude API (claude-sonnet-4-6)

---

### Task 1: Scaffold Vite + React project

**Files:**
- Create: `dashboard/` directory at repo root
- Create: `dashboard/package.json`, `dashboard/vite.config.ts`, `dashboard/tsconfig.json`
- Create: `dashboard/index.html`, `dashboard/src/main.tsx`, `dashboard/src/App.tsx`
- Create: `dashboard/src/lib/supabase.ts`
- Create: `dashboard/.env.example`

**Step 1: Initialize project**

```bash
cd /Users/mykolat/Documents/Projects/00_Amikus/04_Indic
npm create vite@latest dashboard -- --template react-ts
cd dashboard
npm install
npm install @supabase/supabase-js
npm install -D tailwindcss @tailwindcss/vite
```

**Step 2: Configure Tailwind**

In `dashboard/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
});
```

In `dashboard/src/index.css`:
```css
@import "tailwindcss";
```

**Step 3: Create Supabase client**

Create `dashboard/src/lib/supabase.ts`:
```typescript
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

Create `dashboard/.env.example`:
```
VITE_SUPABASE_URL=https://kyuyqfbjeopyysxeltxl.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

**Step 4: Create `.env` with actual values**

Get anon key from Supabase dashboard (Settings > API). Create `dashboard/.env` (gitignored).

**Step 5: Verify dev server starts**

```bash
cd dashboard && npm run dev
```

Expected: Vite dev server on localhost:5173

**Step 6: Commit**

```bash
git add dashboard/
echo "dashboard/.env" >> dashboard/.gitignore
git commit -m "feat(dashboard): scaffold Vite + React + Tailwind + Supabase client"
```

---

### Task 2: Overview page — balance, PnL, positions, health

**Files:**
- Create: `dashboard/src/pages/Overview.tsx`
- Create: `dashboard/src/components/StatCard.tsx`
- Create: `dashboard/src/components/PositionTable.tsx`
- Create: `dashboard/src/components/ErrorFeed.tsx`
- Modify: `dashboard/src/App.tsx`

**Step 1: Create StatCard component**

```typescript
// dashboard/src/components/StatCard.tsx
interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  color?: 'green' | 'red' | 'yellow' | 'default';
}

export function StatCard({ label, value, subtitle, color = 'default' }: StatCardProps) {
  const colorMap = {
    green: 'text-green-400',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
    default: 'text-white',
  };
  return (
    <div className="bg-zinc-900 rounded-lg p-4 border border-zinc-800">
      <div className="text-zinc-400 text-sm">{label}</div>
      <div className={`text-2xl font-mono font-bold ${colorMap[color]}`}>{value}</div>
      {subtitle && <div className="text-zinc-500 text-xs mt-1">{subtitle}</div>}
    </div>
  );
}
```

**Step 2: Create PositionTable component**

```typescript
// dashboard/src/components/PositionTable.tsx
interface Position {
  pair: string;
  side: string;
  fill_price: number;
  quantity: number;
  leverage: number;
  sl_price: number;
  tp_price: number;
  entry_thesis: string;
  opened_at: string;
}

export function PositionTable({ positions }: { positions: Position[] }) {
  if (!positions.length) return <div className="text-zinc-500 p-4">No open positions</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-zinc-400 border-b border-zinc-800">
            <th className="text-left p-2">Pair</th>
            <th className="text-left p-2">Side</th>
            <th className="text-right p-2">Entry</th>
            <th className="text-right p-2">Qty</th>
            <th className="text-right p-2">Lev</th>
            <th className="text-right p-2">SL</th>
            <th className="text-right p-2">TP</th>
            <th className="text-left p-2">Thesis</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.pair + p.opened_at} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
              <td className="p-2 font-mono">{p.pair}</td>
              <td className={`p-2 ${p.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                {p.side === 'BUY' ? 'LONG' : 'SHORT'}
              </td>
              <td className="p-2 text-right font-mono">${Number(p.fill_price).toFixed(4)}</td>
              <td className="p-2 text-right font-mono">{p.quantity}</td>
              <td className="p-2 text-right">{p.leverage}x</td>
              <td className="p-2 text-right font-mono">${Number(p.sl_price).toFixed(4)}</td>
              <td className="p-2 text-right font-mono">${Number(p.tp_price).toFixed(4)}</td>
              <td className="p-2 text-zinc-300 max-w-xs truncate">{p.entry_thesis}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

**Step 3: Create ErrorFeed component**

```typescript
// dashboard/src/components/ErrorFeed.tsx
interface ErrorItem {
  code: string;
  message: string;
  created_at: string;
}

export function ErrorFeed({ errors }: { errors: ErrorItem[] }) {
  if (!errors.length) return <div className="text-green-400 p-2 text-sm">No recent errors</div>;
  return (
    <div className="space-y-1 max-h-48 overflow-y-auto">
      {errors.map((e, i) => (
        <div key={i} className="text-xs flex gap-2 p-1">
          <span className="text-zinc-500 font-mono shrink-0">
            {new Date(e.created_at).toLocaleTimeString()}
          </span>
          <span className="text-red-400 font-mono shrink-0">{e.code}</span>
          <span className="text-zinc-300 truncate">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
```

**Step 4: Create Overview page**

```typescript
// dashboard/src/pages/Overview.tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { StatCard } from '../components/StatCard';
import { PositionTable } from '../components/PositionTable';
import { ErrorFeed } from '../components/ErrorFeed';

export function Overview() {
  const [cycle, setCycle] = useState<any>(null);
  const [positions, setPositions] = useState<any[]>([]);
  const [errors, setErrors] = useState<any[]>([]);
  const [snapshotCount, setSnapshotCount] = useState(0);

  useEffect(() => {
    // Latest cycle
    supabase.from('cycles').select('*').order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => data?.[0] && setCycle(data[0]));

    // Open positions (executions without a close)
    supabase.rpc('get_open_positions').then(({ data }) => data && setPositions(data));

    // Recent errors (last 2h)
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    supabase.from('errors').select('code, message, created_at')
      .gte('created_at', twoHoursAgo).order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => data && setErrors(data));

    // Snapshot count (Watchdog health)
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    supabase.from('market_snapshots').select('id', { count: 'exact', head: true })
      .gte('created_at', oneHourAgo)
      .then(({ count }) => setSnapshotCount(count ?? 0));
  }, []);

  const pnlColor = cycle?.session_pnl > 0 ? 'green' : cycle?.session_pnl < 0 ? 'red' : 'default';

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Indic Bot Dashboard</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Balance" value={`$${Number(cycle?.balance || 0).toFixed(2)}`} />
        <StatCard label="Session PnL" value={`$${Number(cycle?.session_pnl || 0).toFixed(2)}`} color={pnlColor} />
        <StatCard label="Regime" value={cycle?.regime || '—'} subtitle={`F&G: ${cycle?.fear_greed_value ?? '—'}`} />
        <StatCard label="Watchdog (1h)" value={snapshotCount} subtitle="market snapshots" color={snapshotCount > 50 ? 'green' : 'yellow'} />
      </div>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800">
        <div className="p-3 border-b border-zinc-800 text-sm font-semibold text-zinc-300">Open Positions</div>
        <PositionTable positions={positions} />
      </div>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800">
        <div className="p-3 border-b border-zinc-800 text-sm font-semibold text-zinc-300">Recent Errors</div>
        <ErrorFeed errors={errors} />
      </div>
    </div>
  );
}
```

**Step 5: Wire App.tsx with routing**

```bash
cd dashboard && npm install react-router-dom
```

```typescript
// dashboard/src/App.tsx
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Overview } from './pages/Overview';

const navItems = [
  { to: '/', label: 'Overview' },
  { to: '/trades', label: 'Trades' },
  { to: '/swarm', label: 'Swarm' },
  { to: '/chat', label: 'Chat' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-zinc-950 text-white">
        <nav className="border-b border-zinc-800 px-4 py-2 flex gap-4">
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
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
```

**Step 6: Create `get_open_positions` Supabase RPC function**

Run in Supabase SQL editor:
```sql
CREATE OR REPLACE FUNCTION get_open_positions()
RETURNS SETOF trade_executions AS $$
  SELECT te.*
  FROM trade_executions te
  LEFT JOIN trade_closes tc ON tc.execution_id = te.id
  WHERE tc.id IS NULL
  ORDER BY te.opened_at DESC;
$$ LANGUAGE sql STABLE;
```

**Step 7: Verify Overview page renders**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173 — should show balance, PnL, regime, positions, errors.

**Step 8: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): overview page with balance, positions, errors"
```

---

### Task 3: Trades page — decision lifecycle timeline

**Files:**
- Create: `dashboard/src/pages/Trades.tsx`
- Create: `dashboard/src/components/TradeTimeline.tsx`
- Modify: `dashboard/src/App.tsx` (add route)

**Step 1: Create TradeTimeline component**

This shows: decision → risk validation → execution → close as a vertical timeline per trade.

```typescript
// dashboard/src/components/TradeTimeline.tsx
interface TradeEvent {
  type: 'decision' | 'risk' | 'execution' | 'close' | 'error';
  time: string;
  data: Record<string, any>;
}

export function TradeTimeline({ events }: { events: TradeEvent[] }) {
  const colorMap: Record<string, string> = {
    decision: 'border-blue-500',
    risk: 'border-yellow-500',
    execution: 'border-green-500',
    close: 'border-purple-500',
    error: 'border-red-500',
  };

  return (
    <div className="space-y-0">
      {events.map((ev, i) => (
        <div key={i} className="flex gap-3">
          <div className="flex flex-col items-center">
            <div className={`w-3 h-3 rounded-full border-2 ${colorMap[ev.type]} bg-zinc-950`} />
            {i < events.length - 1 && <div className="w-px flex-1 bg-zinc-700" />}
          </div>
          <div className="pb-4 text-sm">
            <div className="flex gap-2 items-baseline">
              <span className="text-zinc-500 font-mono text-xs">
                {new Date(ev.time).toLocaleTimeString()}
              </span>
              <span className="text-zinc-300 font-semibold capitalize">{ev.type}</span>
            </div>
            <div className="text-zinc-400 text-xs mt-1">
              {ev.type === 'decision' && `${ev.data.pair} ${ev.data.action} conf:${ev.data.confidence} — ${ev.data.reasoning?.slice(0, 120)}...`}
              {ev.type === 'risk' && (ev.data.passed ? 'Passed risk validation' : `Rejected: ${ev.data.rejection_reason}`)}
              {ev.type === 'execution' && `Filled @ $${ev.data.fill_price} qty:${ev.data.quantity} lev:${ev.data.leverage}x SL:$${ev.data.sl_price} TP:$${ev.data.tp_price}`}
              {ev.type === 'close' && `Closed @ $${ev.data.exit_price || '—'} PnL: ${ev.data.pnl_pct}% ($${ev.data.pnl_usd}) reason: ${ev.data.exit_reason}`}
              {ev.type === 'error' && `${ev.data.code}: ${ev.data.message}`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Create Trades page**

```typescript
// dashboard/src/pages/Trades.tsx
import { useEffect, useState } from 'react';
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
}

export function Trades() {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<any[]>([]);

  useEffect(() => {
    supabase.from('trade_decisions').select('id, pair, action, confidence, reasoning, regime, created_at, cycle_id')
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => data && setDecisions(data));
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const decision = decisions.find(d => d.id === selectedId);
    if (!decision) return;

    Promise.all([
      supabase.from('risk_validations').select('*').eq('decision_id', selectedId),
      supabase.from('trade_executions').select('*').eq('decision_id', selectedId),
      supabase.from('errors').select('*').eq('cycle_id', decision.cycle_id).eq('code', 'ORDER_FAIL'),
    ]).then(([risk, exec, err]) => {
      const events: any[] = [
        { type: 'decision', time: decision.created_at, data: decision },
      ];
      risk.data?.forEach(r => events.push({ type: 'risk', time: r.created_at, data: r }));
      err.data?.forEach(e => events.push({ type: 'error', time: e.created_at, data: e }));
      exec.data?.forEach(async (ex) => {
        events.push({ type: 'execution', time: ex.opened_at, data: ex });
        const { data: closes } = await supabase.from('trade_closes').select('*').eq('execution_id', ex.id);
        closes?.forEach(c => events.push({ type: 'close', time: c.closed_at, data: c }));
        setTimeline([...events].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()));
      });
      if (!exec.data?.length) {
        setTimeline([...events].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()));
      }
    });
  }, [selectedId, decisions]);

  return (
    <div className="flex gap-6">
      <div className="w-1/3 space-y-1 max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-bold mb-3">Trade Decisions</h2>
        {decisions.map((d) => (
          <button
            key={d.id}
            onClick={() => setSelectedId(d.id)}
            className={`w-full text-left p-2 rounded text-sm ${
              selectedId === d.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
            }`}
          >
            <div className="flex justify-between">
              <span className="font-mono">{d.pair}</span>
              <span className={d.action === 'HOLD' ? 'text-zinc-500' : d.action === 'CLOSE' ? 'text-purple-400' : 'text-blue-400'}>
                {d.action}
              </span>
            </div>
            <div className="text-zinc-500 text-xs">
              {new Date(d.created_at).toLocaleString()} | conf:{d.confidence} | {d.regime}
            </div>
          </button>
        ))}
      </div>

      <div className="flex-1">
        <h2 className="text-lg font-bold mb-3">Lifecycle</h2>
        {selectedId ? (
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
            <TradeTimeline events={timeline} />
          </div>
        ) : (
          <div className="text-zinc-500">Select a decision to see its lifecycle</div>
        )}
      </div>
    </div>
  );
}
```

**Step 3: Add route in App.tsx**

Add import and route:
```typescript
import { Trades } from './pages/Trades';
// in Routes:
<Route path="/trades" element={<Trades />} />
```

**Step 4: Verify**

Open http://localhost:5173/trades — should list decisions, click one → timeline.

**Step 5: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): trades page with decision lifecycle timeline"
```

---

### Task 4: Swarm debate viewer

**Files:**
- Create: `dashboard/src/pages/Swarm.tsx`
- Create: `dashboard/src/components/PersonaCard.tsx`
- Modify: `dashboard/src/App.tsx` (add route)

**Step 1: Create PersonaCard**

```typescript
// dashboard/src/components/PersonaCard.tsx
interface PersonaCardProps {
  persona: string;
  vote: string | null;
  confidence: number | null;
  reasoning: string;
}

const personaColors: Record<string, string> = {
  risk_manager: 'border-yellow-500',
  bull_thesis: 'border-green-500',
  bear_thesis: 'border-red-500',
  market_structure: 'border-blue-500',
  devils_advocate: 'border-purple-500',
  narrative_expert: 'border-orange-500',
};

export function PersonaCard({ persona, vote, confidence, reasoning }: PersonaCardProps) {
  const border = personaColors[persona] || 'border-zinc-600';
  return (
    <div className={`bg-zinc-900 rounded-lg border-l-4 ${border} p-4`}>
      <div className="flex justify-between items-center mb-2">
        <span className="font-semibold text-sm">{persona.replace(/_/g, ' ').toUpperCase()}</span>
        <div className="flex gap-2 text-xs">
          {vote && <span className={vote === 'HOLD' ? 'text-zinc-400' : vote === 'LONG' ? 'text-green-400' : 'text-red-400'}>{vote}</span>}
          {confidence !== null && <span className="text-zinc-500">conf: {confidence}</span>}
        </div>
      </div>
      <p className="text-zinc-400 text-xs leading-relaxed">{reasoning}</p>
    </div>
  );
}
```

**Step 2: Create Swarm page**

```typescript
// dashboard/src/pages/Swarm.tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { PersonaCard } from '../components/PersonaCard';

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

export function Swarm() {
  const [cycles, setCycles] = useState<SwarmCycle[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    // Get swarm conversations (method = swarm_consensus) to group by cycle
    supabase.from('llm_conversations').select('cycle_id, raw_response, created_at')
      .eq('method', 'swarm_consensus').order('created_at', { ascending: false }).limit(20)
      .then(async ({ data: judges }) => {
        if (!judges?.length) return;
        const result: SwarmCycle[] = [];
        for (const j of judges) {
          const { data: personas } = await supabase.from('swarm_personas')
            .select('persona, vote, confidence, reasoning')
            .gte('created_at', new Date(new Date(j.created_at).getTime() - 120_000).toISOString())
            .lte('created_at', j.created_at)
            .order('created_at', { ascending: true });
          result.push({
            cycle_id: j.cycle_id,
            created_at: j.created_at,
            personas: personas || [],
            judge_response: j.raw_response,
          });
        }
        setCycles(result);
      });
  }, []);

  const current = cycles[selectedIdx];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Swarm Debate</h1>
        <select
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm"
          value={selectedIdx}
          onChange={(e) => setSelectedIdx(Number(e.target.value))}
        >
          {cycles.map((c, i) => (
            <option key={i} value={i}>
              Cycle {c.cycle_id} — {new Date(c.created_at).toLocaleString()}
            </option>
          ))}
        </select>
      </div>

      {current ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {current.personas.map((p, i) => (
              <PersonaCard key={i} {...p} />
            ))}
          </div>

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

**Step 3: Add route**

```typescript
import { Swarm } from './pages/Swarm';
<Route path="/swarm" element={<Swarm />} />
```

**Step 4: Verify**

Open http://localhost:5173/swarm — should show persona cards with votes + judge response.

**Step 5: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): swarm debate viewer with persona cards"
```

---

### Task 5: LLM Chat — Supabase Edge Function

**Files:**
- Create: `supabase/functions/chat/index.ts`

**Step 1: Initialize Supabase CLI (if not done)**

```bash
npx supabase init  # if supabase/ dir doesn't exist
```

**Step 2: Create Edge Function**

```typescript
// supabase/functions/chat/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const { question } = await req.json();
  if (!question) return new Response(JSON.stringify({ error: 'Missing question' }), { status: 400, headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Gather recent context from DB
  const [cycleRes, decisionsRes, errorsRes, execRes, snapshotRes] = await Promise.all([
    supabase.from('cycles').select('*').order('created_at', { ascending: false }).limit(3),
    supabase.from('trade_decisions').select('pair, action, confidence, reasoning, regime, created_at')
      .order('created_at', { ascending: false }).limit(10),
    supabase.from('errors').select('code, message, created_at')
      .order('created_at', { ascending: false }).limit(10),
    supabase.from('trade_executions').select('pair, side, fill_price, quantity, leverage, sl_price, tp_price, entry_thesis, opened_at')
      .order('opened_at', { ascending: false }).limit(5),
    supabase.from('market_snapshots').select('pair, mark_price, funding_rate, created_at')
      .order('created_at', { ascending: false }).limit(8),
  ]);

  // Get trade closes
  const closesRes = await supabase.from('trade_closes').select('*').order('closed_at', { ascending: false }).limit(5);

  // Get swarm persona summaries
  const swarmRes = await supabase.from('swarm_personas').select('persona, vote, confidence, reasoning')
    .order('created_at', { ascending: false }).limit(6);

  const dbContext = `
## Recent Cycles (last 3)
${JSON.stringify(cycleRes.data, null, 2)}

## Trade Decisions (last 10)
${JSON.stringify(decisionsRes.data, null, 2)}

## Trade Executions (last 5)
${JSON.stringify(execRes.data, null, 2)}

## Trade Closes (last 5)
${JSON.stringify(closesRes.data, null, 2)}

## Recent Errors (last 10)
${JSON.stringify(errorsRes.data, null, 2)}

## Latest Market Prices
${JSON.stringify(snapshotRes.data, null, 2)}

## Latest Swarm Personas
${JSON.stringify(swarmRes.data, null, 2)}
`;

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: corsHeaders });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      stream: true,
      system: `You are the Indic Bot Dashboard Assistant. You help the user understand what their crypto trading bot is doing.
You have access to the bot's database. Answer questions about trades, decisions, errors, swarm debates, and bot health.
Be concise. Use numbers and specifics from the data. If data is missing, say so.
Answer in Ukrainian unless the user writes in English.

Current DB context:
${dbContext}`,
      messages: [{ role: 'user', content: question }],
    }),
  });

  // Stream the response
  return new Response(response.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
    },
  });
});
```

**Step 3: Deploy Edge Function**

```bash
npx supabase functions deploy chat --no-verify-jwt
```

Set secrets:
```bash
npx supabase secrets set ANTHROPIC_API_KEY=<key>
```

**Step 4: Test manually**

```bash
curl -X POST 'https://kyuyqfbjeopyysxeltxl.supabase.co/functions/v1/chat' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <anon-key>' \
  -d '{"question": "What is the current balance?"}'
```

**Step 5: Commit**

```bash
git add supabase/
git commit -m "feat(dashboard): LLM chat edge function with DB context + Claude streaming"
```

---

### Task 6: LLM Chat — React UI

**Files:**
- Create: `dashboard/src/pages/Chat.tsx`
- Create: `dashboard/src/components/ChatMessage.tsx`
- Create: `dashboard/src/lib/chat.ts`
- Modify: `dashboard/src/App.tsx` (add route)

**Step 1: Create streaming chat client**

```typescript
// dashboard/src/lib/chat.ts
const FUNCTION_URL = import.meta.env.VITE_SUPABASE_URL + '/functions/v1/chat';

export async function* streamChat(question: string, anonKey: string): AsyncGenerator<string> {
  const response = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ question }),
  });

  if (!response.ok) throw new Error(`Chat error: ${response.status}`);
  if (!response.body) throw new Error('No response body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield parsed.delta.text;
        }
      } catch { /* skip non-JSON lines */ }
    }
  }
}
```

**Step 2: Create ChatMessage component**

```typescript
// dashboard/src/components/ChatMessage.tsx
interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
}

export function ChatMessage({ role, content }: ChatMessageProps) {
  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
        role === 'user'
          ? 'bg-blue-600 text-white'
          : 'bg-zinc-800 text-zinc-200'
      }`}>
        <pre className="whitespace-pre-wrap font-sans">{content}</pre>
      </div>
    </div>
  );
}
```

**Step 3: Create Chat page**

```typescript
// dashboard/src/pages/Chat.tsx
import { useRef, useState } from 'react';
import { ChatMessage } from '../components/ChatMessage';
import { streamChat } from '../lib/chat';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'Який поточний баланс і PnL?',
  'Які ордери були відхилені і чому?',
  'Покажи останні рішення Swarm',
  'Чому бот вибрав SHORT на ADA?',
  'Які помилки були за останню годину?',
];

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  const sendMessage = async (text: string) => {
    if (!text.trim() || isStreaming) return;

    const userMsg: Message = { role: 'user', content: text.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      for await (const chunk of streamChat(text.trim(), anonKey)) {
        assistantMsg.content += chunk;
        setMessages(prev => [...prev.slice(0, -1), { ...assistantMsg }]);
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    } catch (err: any) {
      assistantMsg.content += `\n\n[Error: ${err.message}]`;
      setMessages(prev => [...prev.slice(0, -1), { ...assistantMsg }]);
    }

    setIsStreaming(false);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <h1 className="text-xl font-bold mb-4">Bot Assistant</h1>

      <div className="flex-1 overflow-y-auto space-y-3 mb-4">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-zinc-500 text-sm">Ask anything about the bot's activity:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-full"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage(input)}
          placeholder="Запитай про бота..."
          disabled={isStreaming}
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-zinc-500"
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={isStreaming || !input.trim()}
          className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

**Step 4: Add route**

```typescript
import { Chat } from './pages/Chat';
<Route path="/chat" element={<Chat />} />
```

**Step 5: Verify**

Open http://localhost:5173/chat — type a question, should get streaming response.

**Step 6: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): LLM chat page with streaming Claude responses"
```

---

### Task 7: Auto-refresh + Realtime subscriptions

**Files:**
- Modify: `dashboard/src/pages/Overview.tsx`

**Step 1: Add polling interval for Overview**

```typescript
// In Overview.tsx, wrap fetches in a function and add interval
useEffect(() => {
  const fetchData = () => {
    // ... existing fetch logic
  };
  fetchData();
  const interval = setInterval(fetchData, 30_000); // 30s refresh
  return () => clearInterval(interval);
}, []);
```

**Step 2: Add Supabase Realtime for errors**

```typescript
// In Overview.tsx, subscribe to new errors
useEffect(() => {
  const channel = supabase.channel('errors')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'errors' },
      (payload) => setErrors(prev => [payload.new as any, ...prev].slice(0, 20)))
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, []);
```

**Step 3: Enable Realtime on errors table**

In Supabase SQL editor:
```sql
ALTER PUBLICATION supabase_realtime ADD TABLE errors;
```

**Step 4: Verify**

Overview should auto-update every 30s and show new errors in real-time.

**Step 5: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): auto-refresh overview + realtime error feed"
```

---

### Task 8: Deploy to Vercel

**Files:**
- Create: `dashboard/vercel.json`

**Step 1: Add vercel.json for SPA routing**

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

**Step 2: Deploy**

```bash
cd dashboard
npx vercel --prod
```

Set env vars in Vercel dashboard:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

**Step 3: Verify production**

Open Vercel URL — all pages should work.

**Step 4: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): vercel deployment config"
```

---

### Task 9: Run full test + final commit

**Step 1: Ensure bot tests still pass**

```bash
cd /Users/mykolat/Documents/Projects/00_Amikus/04_Indic
npm run test
```

Expected: ALL PASS (dashboard is separate, doesn't affect bot tests)

**Step 2: Final commit**

```bash
git add -A
git commit -m "docs: add dashboard implementation plan"
```
