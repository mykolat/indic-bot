import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export function Market() {
  const [pairs, setPairs] = useState<string[]>([]);
  const [selectedPair, setSelectedPair] = useState('BTCUSDT');
  const [priceData, setPriceData] = useState<any[]>([]);
  const [fundingData, setFundingData] = useState<any[]>([]);
  const [oiData, setOiData] = useState<any[]>([]);
  const [regimeData, setRegimeData] = useState<any[]>([]);

  useEffect(() => {
    supabase.from('market_snapshots').select('pair').then(({ data }) => {
      if (!data) return;
      setPairs([...new Set(data.map((d) => d.pair))].sort());
    });
  }, []);

  useEffect(() => {
    const last24h = new Date(Date.now() - 86400_000).toISOString();

    supabase.from('market_snapshots').select('mark_price, created_at').eq('pair', selectedPair)
      .gte('created_at', last24h).order('created_at', { ascending: true })
      .then(({ data }) => setPriceData((data ?? []).map((d) => ({ time: d.created_at.slice(11, 16), price: Number(d.mark_price) }))));

    supabase.from('market_snapshots').select('funding_rate, created_at').eq('pair', selectedPair)
      .gte('created_at', last24h).order('created_at', { ascending: true })
      .then(({ data }) => setFundingData((data ?? []).map((d) => ({ time: d.created_at.slice(11, 16), rate: Number(d.funding_rate) * 100 }))));

    supabase.from('market_snapshots').select('open_interest, created_at').eq('pair', selectedPair)
      .gte('created_at', last24h).order('created_at', { ascending: true })
      .then(({ data }) => setOiData((data ?? []).map((d) => ({ time: d.created_at.slice(11, 16), oi: Number(d.open_interest) }))));
  }, [selectedPair]);

  useEffect(() => {
    supabase.from('cycles').select('regime, regime_confidence, created_at')
      .order('created_at', { ascending: true }).limit(200)
      .then(({ data }) => setRegimeData((data ?? []).map((d) => ({
        time: d.created_at.slice(5, 16).replace('T', ' '), regime: d.regime, confidence: Number(d.regime_confidence ?? 0),
      }))));
  }, []);

  const regimeColors: Record<string, string> = {
    BullTrend: '#4ade80', BearTrend: '#f87171', Range: '#eab308', Breakout: '#a78bfa', Capitulation: '#ef4444',
  };
  const tt = { background: '#16161f', border: '1px solid #252535', borderRadius: 8 };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-zinc-200">Market Data</h1>
        <select value={selectedPair} onChange={(e) => setSelectedPair(e.target.value)}
          className="bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-300 focus:outline-none focus:border-accent/40">
          {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">{selectedPair} Price (24h)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={priceData}>
              <XAxis dataKey="time" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis domain={['auto', 'auto']} tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={tt} />
              <Line type="monotone" dataKey="price" stroke="#60a5fa" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Funding Rate %</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={fundingData}>
              <XAxis dataKey="time" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={tt} />
              <Line type="monotone" dataKey="rate" stroke="#eab308" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Open Interest</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={oiData}>
              <XAxis dataKey="time" tick={{ fill: '#71717a', fontSize: 10 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} />
              <Tooltip contentStyle={tt} />
              <Line type="monotone" dataKey="oi" stroke="#4ade80" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 rounded-xl border border-border p-4">
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Regime Over Time</h3>
          <div className="flex gap-px h-8 rounded overflow-hidden mb-2">
            {regimeData.map((d, i) => (
              <div key={i} className="flex-1" style={{ backgroundColor: regimeColors[d.regime] ?? '#3f3f46' }}
                title={`${d.time}: ${d.regime} (${d.confidence}%)`} />
            ))}
          </div>
          <div className="flex gap-3 flex-wrap">
            {Object.entries(regimeColors).map(([r, c]) => (
              <div key={r} className="flex items-center gap-1 text-xs text-zinc-400">
                <div className="w-3 h-3 rounded" style={{ backgroundColor: c }} />{r}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
