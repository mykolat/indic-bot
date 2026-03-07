import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie } from 'recharts';

export function LlmCosts() {
  const [tokensByDay, setTokensByDay] = useState<any[]>([]);
  const [costByMethod, setCostByMethod] = useState<any[]>([]);
  const [parseErrors, setParseErrors] = useState<{ day: string; total: number; failed: number }[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [totalTokens, setTotalTokens] = useState({ in: 0, out: 0 });

  useEffect(() => {
    supabase.from('token_usage').select('tokens_in, tokens_out, cost_usd, method, created_at')
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        const dayMap = new Map<string, { tokens_in: number; tokens_out: number; cost: number }>();
        const methodMap = new Map<string, number>();
        let tIn = 0, tOut = 0, tCost = 0;

        for (const row of data) {
          const day = row.created_at.slice(0, 10);
          const e = dayMap.get(day) ?? { tokens_in: 0, tokens_out: 0, cost: 0 };
          e.tokens_in += row.tokens_in ?? 0; e.tokens_out += row.tokens_out ?? 0;
          e.cost += Number(row.cost_usd ?? 0); dayMap.set(day, e);
          const method = row.method || 'unknown';
          methodMap.set(method, (methodMap.get(method) ?? 0) + Number(row.cost_usd ?? 0));
          tIn += row.tokens_in ?? 0; tOut += row.tokens_out ?? 0; tCost += Number(row.cost_usd ?? 0);
        }

        setTokensByDay(Array.from(dayMap, ([day, v]) => ({ day, tokens: v.tokens_in + v.tokens_out, cost: Math.round(v.cost * 1000) / 1000 })));
        const COLORS = ['#60a5fa', '#f87171', '#4ade80', '#eab308', '#a78bfa', '#fb923c', '#2dd4bf'];
        setCostByMethod(Array.from(methodMap, ([method, cost], i) => ({ name: method, value: Math.round(cost * 1000) / 1000, fill: COLORS[i % COLORS.length] })).sort((a, b) => b.value - a.value));
        setTotalCost(tCost);
        setTotalTokens({ in: tIn, out: tOut });
      });
  }, []);

  useEffect(() => {
    supabase.from('llm_conversations').select('parsed_ok, created_at').then(({ data }) => {
      if (!data) return;
      const map = new Map<string, { total: number; failed: number }>();
      for (const row of data) {
        const day = row.created_at.slice(0, 10);
        const e = map.get(day) ?? { total: 0, failed: 0 };
        e.total++; if (row.parsed_ok === false) e.failed++;
        map.set(day, e);
      }
      setParseErrors(Array.from(map, ([day, v]) => ({ day, ...v })));
    });
  }, []);

  const tt = { background: '#16161f', border: '1px solid #252535', borderRadius: 8 };

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-zinc-200">LLM & Costs</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface-1 rounded-xl p-4 border border-border">
          <div className="text-zinc-400 text-sm">Total Cost</div>
          <div className="text-2xl font-mono font-bold text-yellow-400">${totalCost.toFixed(3)}</div>
        </div>
        <div className="bg-surface-1 rounded-xl p-4 border border-border">
          <div className="text-zinc-400 text-sm">Tokens In</div>
          <div className="text-2xl font-mono font-bold">{(totalTokens.in / 1000).toFixed(0)}K</div>
        </div>
        <div className="bg-surface-1 rounded-xl p-4 border border-border">
          <div className="text-zinc-400 text-sm">Tokens Out</div>
          <div className="text-2xl font-mono font-bold">{(totalTokens.out / 1000).toFixed(0)}K</div>
        </div>
        <div className="bg-surface-1 rounded-xl p-4 border border-border">
          <div className="text-zinc-400 text-sm">LLM Calls</div>
          <div className="text-2xl font-mono font-bold">{parseErrors.reduce((s, d) => s + d.total, 0)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Daily Token Usage</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tokensByDay}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={tt} />
              <Bar dataKey="tokens" fill="#60a5fa" radius={[3, 3, 0, 0]} name="Tokens" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Cost by Method ($)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={costByMethod} dataKey="value" nameKey="name" cx="50%" cy="50%"
                outerRadius={80} label={({ name, value }) => `${name}: $${value}`}
                labelLine={{ stroke: '#71717a' }} />
              <Tooltip contentStyle={tt} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Daily Cost ($)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={tokensByDay}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={tt} />
              <Bar dataKey="cost" fill="#eab308" radius={[3, 3, 0, 0]} name="Cost $" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Parse Error Rate</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={parseErrors}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={tt} />
              <Bar dataKey="total" fill="#60a5fa" radius={[3, 3, 0, 0]} name="Total calls" />
              <Bar dataKey="failed" fill="#f87171" radius={[3, 3, 0, 0]} name="Parse failures" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
