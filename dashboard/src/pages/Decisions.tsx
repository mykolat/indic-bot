import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { FunnelBar } from '../components/charts/FunnelBar';
import { useFunnelData } from '../hooks/useFunnelData';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from 'recharts';

export function Decisions() {
  const funnel = useFunnelData();

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
          const h = e.created_at.slice(0, 13);
          map.set(h, (map.get(h) ?? 0) + 1);
        }
        setVolumeTrend(Array.from(map, ([hour, count]) => ({
          hour: hour.slice(5, 16).replace('T', ' '),
          count,
        })));
      });
  }, []);

  const [regimePerf, setRegimePerf] = useState<any[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase.from('trade_decisions').select('id, regime, action, confidence');
      const { data: execs } = await supabase.from('trade_executions').select('decision_id');
      const { data: closes } = await supabase.from('trade_closes').select('execution_id, pnl_usd');
      const { data: execFull } = await supabase.from('trade_executions').select('id, decision_id');
      if (!decs) return;

      const execSet = new Set((execs ?? []).map((e) => e.decision_id));
      const execMap = new Map((execFull ?? []).map((e) => [e.id, e.decision_id]));
      const closesByDec = new Map<number, any[]>();
      for (const c of closes ?? []) {
        const decId = execMap.get(c.execution_id);
        if (decId) { const arr = closesByDec.get(decId) ?? []; arr.push(c); closesByDec.set(decId, arr); }
      }

      const rm = new Map<string, { decisions: number; executed: number; wins: number; totalPnl: number }>();
      for (const d of decs) {
        if (d.action !== 'LONG' && d.action !== 'SHORT') continue;
        const r = d.regime || 'Unknown';
        const entry = rm.get(r) ?? { decisions: 0, executed: 0, wins: 0, totalPnl: 0 };
        entry.decisions++;
        if (execSet.has(d.id)) {
          entry.executed++;
          for (const c of closesByDec.get(d.id) ?? []) { const pnl = Number(c.pnl_usd); entry.totalPnl += pnl; if (pnl > 0) entry.wins++; }
        }
        rm.set(r, entry);
      }
      setRegimePerf(Array.from(rm, ([regime, v]) => ({
        regime, ...v,
        convPct: v.decisions > 0 ? Math.round((v.executed / v.decisions) * 100) : 0,
        winRate: v.executed > 0 ? Math.round((v.wins / v.executed) * 100) : 0,
      })));
    };
    load();
  }, []);

  const [pairPerf, setPairPerf] = useState<any[]>([]);
  useEffect(() => {
    supabase.from('trade_closes').select('pair, pnl_usd, held_hours').then(({ data }) => {
      if (!data) return;
      const map = new Map<string, { trades: number; wins: number; totalPnl: number; totalHours: number }>();
      for (const c of data) {
        const e = map.get(c.pair) ?? { trades: 0, wins: 0, totalPnl: 0, totalHours: 0 };
        e.trades++; const pnl = Number(c.pnl_usd); e.totalPnl += pnl; if (pnl > 0) e.wins++;
        e.totalHours += Number(c.held_hours ?? 0); map.set(c.pair, e);
      }
      setPairPerf(Array.from(map, ([pair, v]) => ({
        pair, ...v, winRate: v.trades > 0 ? Math.round((v.wins / v.trades) * 100) : 0,
        avgHold: v.trades > 0 ? (v.totalHours / v.trades).toFixed(1) : '—',
      })));
    });
  }, []);

  const [confDist, setConfDist] = useState<{ bucket: string; passed: number; failed: number }[]>([]);
  useEffect(() => {
    const load = async () => {
      const { data: decs } = await supabase.from('trade_decisions').select('id, confidence, action');
      const { data: risks } = await supabase.from('risk_validations').select('decision_id, passed');
      if (!decs || !risks) return;
      const riskMap = new Map(risks.map((r) => [r.decision_id, r.passed]));
      const buckets = new Map<string, { passed: number; failed: number }>();
      for (const d of decs) {
        if (d.action !== 'LONG' && d.action !== 'SHORT') continue;
        const conf = d.confidence ?? 0;
        const bucket = `${Math.floor(conf / 10) * 10}-${Math.floor(conf / 10) * 10 + 9}`;
        const e = buckets.get(bucket) ?? { passed: 0, failed: 0 };
        if (riskMap.get(d.id)) e.passed++; else e.failed++;
        buckets.set(bucket, e);
      }
      setConfDist(Array.from(buckets, ([bucket, v]) => ({ bucket, ...v })).sort((a, b) => a.bucket.localeCompare(b.bucket)));
    };
    load();
  }, []);

  const [layerUsage, setLayerUsage] = useState<{ layer: string; count: number }[]>([]);
  useEffect(() => {
    supabase.from('cycles').select('layer').then(({ data }) => {
      if (!data) return;
      const map = new Map<string, number>();
      for (const c of data) { const l = `Layer ${c.layer ?? '?'}`; map.set(l, (map.get(l) ?? 0) + 1); }
      setLayerUsage(Array.from(map, ([layer, count]) => ({ layer, count })));
    });
  }, []);

  const tt = { background: '#16161f', border: '1px solid #252535', borderRadius: 8 };

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-zinc-200">Decision Analytics</h1>

      {funnel.data && (
        <div className="bg-surface-1 rounded-xl border border-border p-5">
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

      {funnel.data && funnel.data.rejectionReasons.length > 0 && (
        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Rejection Breakdown</h3>
          <div className="space-y-2">
            {(() => {
              const max = funnel.data.rejectionReasons[0].count;
              return funnel.data.rejectionReasons.map((r) => (
                <div key={r.reason} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-400 mb-1 truncate" title={r.reason}>{r.reason}</div>
                    <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-red-500/70"
                        style={{ width: `${(r.count / max) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-xs font-mono text-zinc-400 shrink-0 w-6 text-right">{r.count}</span>
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {confDist.length > 0 && (
          <div className="bg-surface-1 rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4">Confidence Distribution</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={confDist}>
                <XAxis dataKey="bucket" tick={{ fill: '#71717a', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
                <Tooltip contentStyle={tt} />
                <Bar dataKey="passed" stackId="a" fill="#4ade80" name="Passed" />
                <Bar dataKey="failed" stackId="a" fill="#f87171" name="Failed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {volumeTrend.length > 0 && (
          <div className="bg-surface-1 rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4">Preflight Rejections Over Time</h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={volumeTrend}>
                <XAxis dataKey="hour" tick={{ fill: '#71717a', fontSize: 10 }} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
                <Tooltip contentStyle={tt} />
                <Line type="monotone" dataKey="count" stroke="#f59e0b" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {layerUsage.length > 0 && (
          <div className="bg-surface-1 rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold text-zinc-300 mb-4">LLM Layer Usage</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={layerUsage}>
                <XAxis dataKey="layer" tick={{ fill: '#71717a', fontSize: 11 }} />
                <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
                <Tooltip contentStyle={tt} />
                <Bar dataKey="count" fill="#60a5fa" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {regimePerf.length > 0 && (
        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Regime Performance</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-zinc-400 border-b border-border text-left">
              <th className="p-2">Regime</th><th className="p-2 text-right">Decisions</th><th className="p-2 text-right">Conv%</th><th className="p-2 text-right">Win Rate</th><th className="p-2 text-right">Total PnL</th>
            </tr></thead>
            <tbody>
              {regimePerf.map((r) => (
                <tr key={r.regime} className="border-b border-border/50">
                  <td className="p-2 font-mono">{r.regime}</td><td className="p-2 text-right">{r.decisions}</td><td className="p-2 text-right">{r.convPct}%</td>
                  <td className="p-2 text-right">{r.executed > 0 ? `${r.winRate}%` : '—'}</td>
                  <td className={`p-2 text-right font-mono ${r.totalPnl > 0 ? 'text-green-400' : r.totalPnl < 0 ? 'text-red-400' : ''}`}>{r.totalPnl !== 0 ? `$${r.totalPnl.toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pairPerf.length > 0 && (
        <div className="bg-surface-1 rounded-xl border border-border p-5">
          <h3 className="text-sm font-semibold text-zinc-300 mb-4">Pair Performance</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-zinc-400 border-b border-border text-left">
              <th className="p-2">Pair</th><th className="p-2 text-right">Trades</th><th className="p-2 text-right">Win Rate</th><th className="p-2 text-right">Avg Hold</th><th className="p-2 text-right">Total PnL</th>
            </tr></thead>
            <tbody>
              {pairPerf.map((p) => (
                <tr key={p.pair} className="border-b border-border/50">
                  <td className="p-2 font-mono">{p.pair}</td><td className="p-2 text-right">{p.trades}</td><td className="p-2 text-right">{p.winRate}%</td><td className="p-2 text-right">{p.avgHold}h</td>
                  <td className={`p-2 text-right font-mono ${p.totalPnl > 0 ? 'text-green-400' : 'text-red-400'}`}>${p.totalPnl.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
