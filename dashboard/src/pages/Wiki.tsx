import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

function MarketDataStats() {
  const [stats24h, setStats24h] = useState<any>(null);
  const [stats7d, setStats7d] = useState<any>(null);

  useEffect(() => {
    const compute = async (since: string) => {
      const [cycles, closes] = await Promise.all([
        supabase.from('cycles').select('regime, volume_ratio, fear_greed_value, confluence_score').gte('created_at', since),
        supabase.from('trade_closes').select('pnl_usd, exit_reason').gte('closed_at', since),
      ]);
      const c = cycles.data ?? [];
      const cl = closes.data ?? [];

      const regimeCounts: Record<string, number> = {};
      let totalVR = 0, totalFG = 0, vrCount = 0, fgCount = 0;
      for (const cy of c) {
        const r = cy.regime || 'Unknown';
        regimeCounts[r] = (regimeCounts[r] ?? 0) + 1;
        if (cy.volume_ratio != null) { totalVR += Number(cy.volume_ratio); vrCount++; }
        if (cy.fear_greed_value != null) { totalFG += Number(cy.fear_greed_value); fgCount++; }
      }
      const topRegime = Object.entries(regimeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      const wins = cl.filter(x => Number(x.pnl_usd) > 0).length;
      const totalPnl = cl.reduce((s, x) => s + Number(x.pnl_usd), 0);
      return {
        cycles: c.length,
        trades: cl.length,
        wins,
        winRate: cl.length > 0 ? Math.round((wins / cl.length) * 100) : null,
        totalPnl,
        avgVR: vrCount > 0 ? (totalVR / vrCount).toFixed(2) : '—',
        avgFG: fgCount > 0 ? Math.round(totalFG / fgCount) : null,
        topRegime,
      };
    };

    const now = new Date();
    const since24h = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const since7d = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
    Promise.all([compute(since24h), compute(since7d)]).then(([s24, s7]) => {
      setStats24h(s24);
      setStats7d(s7);
    });
  }, []);

  const Row = ({ label, v24, v7 }: { label: string; v24: any; v7: any }) => (
    <tr className="border-b border-border/40 text-xs text-zinc-400">
      <td className="py-2 pr-4 text-zinc-500">{label}</td>
      <td className="py-2 pr-4 font-mono text-zinc-200">{v24 ?? '—'}</td>
      <td className="py-2 font-mono text-zinc-200">{v7 ?? '—'}</td>
    </tr>
  );

  return (
    <section className="bg-surface-1 rounded-xl border border-border p-6">
      <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Market Data Stats</h2>
      <table className="w-full">
        <thead>
          <tr className="text-zinc-600 text-xs uppercase tracking-wide text-left border-b border-border">
            <th className="pb-2 pr-4">Metric</th>
            <th className="pb-2 pr-4">Last 24h</th>
            <th className="pb-2">Last 7d</th>
          </tr>
        </thead>
        <tbody>
          <Row label="Brain cycles" v24={stats24h?.cycles} v7={stats7d?.cycles} />
          <Row label="Trades closed" v24={stats24h?.trades} v7={stats7d?.trades} />
          <Row label="Win rate" v24={stats24h?.winRate != null ? `${stats24h.winRate}%` : '—'} v7={stats7d?.winRate != null ? `${stats7d.winRate}%` : '—'} />
          <Row label="Total PnL" v24={stats24h?.totalPnl != null ? `$${stats24h.totalPnl.toFixed(2)}` : '—'} v7={stats7d?.totalPnl != null ? `$${stats7d.totalPnl.toFixed(2)}` : '—'} />
          <Row label="Avg volume ratio" v24={stats24h?.avgVR != null ? `${stats24h.avgVR}x` : '—'} v7={stats7d?.avgVR != null ? `${stats7d.avgVR}x` : '—'} />
          <Row label="Avg Fear & Greed" v24={stats24h?.avgFG} v7={stats7d?.avgFG} />
          <Row label="Dominant regime" v24={stats24h?.topRegime} v7={stats7d?.topRegime} />
        </tbody>
      </table>
    </section>
  );
}

export function Wiki() {
  return (
    <div className="space-y-8 max-w-4xl">
      <h1 className="text-lg font-semibold text-zinc-200">Wiki</h1>
      <MarketDataStats />

      {/* Market Sessions */}
      <section className="bg-surface-1 rounded-xl border border-border p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Market Sessions & Expected Regimes</h2>
        <div className="space-y-3">
          {[
            {
              label: 'Asia Dead Zone',
              utc: '00:00 – 06:00',
              kyiv: '02:00 – 08:00',
              regime: 'Scalping',
              regimeColor: 'text-purple-400',
              desc: 'Low volume (0.2–0.5x avg), no institutional flow. Bot uses Scalping regime — 2x max leverage, tight SL 0.8%, TP 1.0%. High confidence threshold (72%).',
            },
            {
              label: 'London Open',
              utc: '06:00 – 10:00',
              kyiv: '08:00 – 12:00',
              regime: 'BullTrend / BearTrend',
              regimeColor: 'text-green-400',
              desc: 'Volume spikes 1.2–2x. ADX rises above 25. Most reliable directional moves. Bot most active here — full leverage, trailing SL/TP.',
            },
            {
              label: 'London / NY Overlap',
              utc: '13:00 – 17:00',
              kyiv: '15:00 – 19:00',
              regime: 'Breakout / BullTrend',
              regimeColor: 'text-purple-400',
              desc: 'Highest volume of the day (1.5–3x avg). Swarm agent activates (BTC volumeRatio > 1.5). Breakout regime likely — ATR spikes, price outside BB. 5 AI personas debate.',
            },
            {
              label: 'NY Session',
              utc: '17:00 – 21:00',
              kyiv: '19:00 – 23:00',
              regime: 'Range / Trend',
              regimeColor: 'text-yellow-400',
              desc: 'Volume normalising. Mixed signals. Bot looks for Range entries (mean reversion) or weak trend continuation. Lower confidence typical.',
            },
            {
              label: 'NY Close / Evening',
              utc: '21:00 – 00:00',
              kyiv: '23:00 – 02:00',
              regime: 'Range / Capitulation',
              regimeColor: 'text-yellow-400',
              desc: 'Volume dropping. If Fear & Greed < 15 or extreme volume spike — Capitulation regime. Bot uses DCA-style TP, 0.25x leverage. Otherwise waits for clear signal.',
            },
          ].map((s) => (
            <div key={s.label} className="flex gap-4 p-3 rounded-lg bg-surface-2 border border-border/50">
              <div className="w-36 shrink-0">
                <div className="text-sm font-semibold text-zinc-200">{s.label}</div>
                <div className="text-[11px] font-mono text-zinc-500 mt-0.5">UTC: {s.utc}</div>
                <div className="text-[11px] font-mono text-zinc-600">Kyiv: {s.kyiv}</div>
              </div>
              <div className="flex-1 min-w-0">
                <span className={`text-[11px] font-mono font-semibold ${s.regimeColor} mr-2`}>{s.regime}</span>
                <span className="text-[12px] text-zinc-400">{s.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Regimes */}
      <section className="bg-surface-1 rounded-xl border border-border p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Market Regimes</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-zinc-500 text-left border-b border-border text-xs uppercase tracking-wide">
              <th className="pb-2 pr-4">Regime</th>
              <th className="pb-2 pr-4">Trigger</th>
              <th className="pb-2 pr-4">Leverage</th>
              <th className="pb-2 pr-4">SL / TP Style</th>
              <th className="pb-2">Min Confidence</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {[
              { regime: 'BullTrend', color: 'text-green-400', trigger: 'EMA20 > EMA50, ADX > 25, price > VWAP', lev: '1.0x', sltp: 'trailing / trailing', conf: '50%' },
              { regime: 'BearTrend', color: 'text-red-400', trigger: 'EMA20 < EMA50, ADX > 25, price < VWAP', lev: '1.0x', sltp: 'fixed / fixed', conf: '55%' },
              { regime: 'Range', color: 'text-yellow-400', trigger: 'ADX < 20, BB bandwidth < 4%', lev: '0.5x', sltp: 'range / range', conf: '50%' },
              { regime: 'Breakout', color: 'text-purple-400', trigger: 'Volume > 1.5x AND (ATR spike OR price outside BB)', lev: '1.0x', sltp: 'ATR / momentum', conf: '60%' },
              { regime: 'Capitulation', color: 'text-red-300', trigger: 'Fear & Greed < 15 OR volume > 3x', lev: '0.25x', sltp: 'fixed / DCA', conf: '45%' },
              { regime: 'Scalping', color: 'text-purple-300', trigger: 'Volume < 0.5x AND ADX < 25 (dead zone)', lev: '0.1x', sltp: 'fixed / fixed', conf: '72%' },
            ].map((r) => (
              <tr key={r.regime} className="text-zinc-400 text-xs">
                <td className={`py-2 pr-4 font-mono font-semibold ${r.color}`}>{r.regime}</td>
                <td className="py-2 pr-4">{r.trigger}</td>
                <td className="py-2 pr-4 font-mono">{r.lev}</td>
                <td className="py-2 pr-4 font-mono">{r.sltp}</td>
                <td className="py-2 font-mono">{r.conf}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-zinc-600 mt-3">Priority order: Capitulation → Breakout → BullTrend → BearTrend → Scalping → Range</p>
      </section>

      {/* Decision Pipeline */}
      <section className="bg-surface-1 rounded-xl border border-border p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Decision Pipeline</h2>
        <div className="space-y-2 font-mono text-xs text-zinc-400">
          {[
            ['1', 'FlashCrash Guard', 'Grok checks for market panic. PANIC → skip cycle.', 'text-red-400'],
            ['2', 'Market Snapshots', 'Fetch price, OI, funding, order book for all 8 pairs.', 'text-zinc-500'],
            ['3', 'Technical Indicators', '1h + 4h RSI, EMA20/50, ADX, VWAP, BB, MACD, volumeRatio.', 'text-zinc-500'],
            ['4', 'Regime Classify', 'Classify market regime per pair. BTC regime = global fallback.', 'text-blue-400'],
            ['5', 'Graph RAG', 'Find similar past episodes (cosine > 0.7). Inject into prompt.', 'text-zinc-500'],
            ['6', 'News + Macro', 'CryptoPanic + RSS headlines. Yahoo Finance macro data (WTI, DXY, VIX).', 'text-zinc-500'],
            ['7', 'LLM / Swarm', 'Single LLM or 5-persona Swarm (if BTC volumeRatio > 1.5).', 'text-accent'],
            ['8', 'Risk Validation', 'Confidence ≥ 55%, leverage check, SL required, max exposure.', 'text-yellow-400'],
            ['9', 'Order Execution', 'MARKET entry → STOP_MARKET SL → TAKE_PROFIT_MARKET TP.', 'text-green-400'],
          ].map(([num, name, desc, color]) => (
            <div key={num} className="flex gap-3 items-start">
              <span className="text-zinc-700 w-4 shrink-0">{num}.</span>
              <span className={`w-40 shrink-0 ${color}`}>{name}</span>
              <span className="text-zinc-500">{desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Swarm Multi-Agent Debate */}
      <section className="bg-surface-1 rounded-xl border border-border p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Swarm Multi-Agent Debate</h2>
        <div className="space-y-4 text-xs text-zinc-400">
          <div>
            <h3 className="text-zinc-300 font-semibold mb-1">When does it activate?</h3>
            <p>When <span className="font-mono text-accent">BTC volumeRatio &gt; 1.5x</span> (current 1h volume vs 20-period average). This typically happens during London/NY overlap (15:00-19:00 Kyiv) or major news events.</p>
          </div>
          <div>
            <h3 className="text-zinc-300 font-semibold mb-1">What happens when it's skipped?</h3>
            <p>Bot uses a single LLM call instead. Faster, cheaper, sufficient for low-activity markets. The <span className="font-mono text-yellow-500">SKIPPED</span> label in the sidebar shows the last cycle with its volume ratio and regime.</p>
          </div>
          <div>
            <h3 className="text-zinc-300 font-semibold mb-1">5 Personas</h3>
            <div className="grid grid-cols-2 gap-2 mt-2">
              {[
                ['Risk Manager', 'text-blue-400', 'Evaluates downside risk, position sizing, exposure'],
                ['Bull Thesis', 'text-green-400', 'Builds the case for going long'],
                ['Bear Thesis', 'text-red-400', 'Builds the case for going short'],
                ['Market Structure', 'text-purple-400', 'Analyzes technicals, support/resistance, order flow'],
                ["Devil's Advocate", 'text-yellow-400', 'Challenges consensus, finds hidden risks'],
                ['Narrative Expert', 'text-cyan-400', 'Grok-powered — reads X/Twitter sentiment, news narrative'],
              ].map(([name, color, desc]) => (
                <div key={name} className="flex gap-2 items-start p-2 bg-surface-2 rounded-lg">
                  <span className={`font-mono font-semibold shrink-0 ${color}`}>{name}</span>
                  <span className="text-zinc-500">{desc}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-zinc-300 font-semibold mb-1">Pipeline</h3>
            <div className="font-mono text-[11px] space-y-1">
              <p><span className="text-zinc-600">Phase 1:</span> <span className="text-zinc-300">Generate</span> — each persona produces thesis + probability + confidence</p>
              <p><span className="text-zinc-600">Phase 2:</span> <span className="text-zinc-300">Critique</span> — personas challenge each other (high-stakes only: &gt;3% PnL or &gt;30% balance)</p>
              <p><span className="text-zinc-600">Phase 3:</span> <span className="text-zinc-300">Revise</span> — update positions after critique</p>
              <p><span className="text-zinc-600">Judge:</span> <span className="text-zinc-300">Aggregate</span> — weighted by probability × confidence, DA risks get extra weight</p>
            </div>
          </div>
          <div>
            <h3 className="text-zinc-300 font-semibold mb-1">Cost</h3>
            <p>Phase 1: 6-7 LLM calls. Phase 2 (critique): +5. Phase 3 (revise): +5. Total: 6-17 calls per debate.</p>
          </div>
        </div>
      </section>

      {/* Status meanings */}
      <section className="bg-surface-1 rounded-xl border border-border p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Trade Status Meanings</h2>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            ['OPEN', 'bg-blue-500/15 text-blue-400', 'Position live on Binance. SL + TP orders placed.'],
            ['TP', 'bg-green-500/15 text-green-400', 'Take Profit hit. Position closed automatically.'],
            ['SL', 'bg-red-500/15 text-red-400', 'Stop Loss triggered. Position closed automatically.'],
            ['Closed', 'bg-zinc-500/15 text-zinc-400', 'Closed by LLM decision (CLOSE action).'],
            ['Pending', 'bg-zinc-500/10 text-zinc-500', 'Decision made but risk validation not yet recorded.'],
            ['Rejected', 'bg-red-500/15 text-red-400', 'Risk Manager blocked the trade.'],
            ['Failed', 'bg-red-500/15 text-red-400', 'Risk passed but order placement failed on Binance.'],
          ].map(([label, style, desc]) => (
            <div key={label} className="flex items-start gap-3">
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${style}`}>{label}</span>
              <span className="text-zinc-500">{desc}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Key numbers */}
      <section className="bg-surface-1 rounded-xl border border-border p-6">
        <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 mb-4">Key Numbers</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs text-zinc-400">
          {[
            ['Brain cycle interval', '10 min (no positions) / 60 min default'],
            ['Watchdog interval', '1 min — market snapshots'],
            ['Churn cooldown', '15 min after close'],
            ['Stale position exit', '8h with < 1% PnL'],
            ['Max hold', '24h then force-close'],
            ['Max session loss', '$30 or 10% balance'],
            ['Max single position', '60% of balance'],
            ['Max total exposure', '150% of balance'],
            ['Binance taker fee', '0.04% of notional'],
            ['Swarm threshold', 'BTC volumeRatio > 1.5'],
            ['Scalping max leverage', '2x (0.1 × 25 max)'],
            ['Capitulation leverage cap', '0.25x (F&G < 15)'],
          ].map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5 p-2 bg-surface-2 rounded-lg">
              <span className="text-zinc-600 text-[10px]">{label}</span>
              <span className="font-mono text-zinc-300">{value}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
