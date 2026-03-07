import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, CartesianGrid, ComposedChart, Bar, Cell,
} from 'recharts';

/* ── helpers ── */
const fmt = (n: number, d = 2) =>
  n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtCompact = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
};

const tt: React.CSSProperties = {
  background: '#0f0f16', border: '1px solid #252535', borderRadius: 8, fontSize: 12, padding: '8px 12px',
};
const axisTickStyle = { fill: '#52525b', fontSize: 10 };

type TimeRange = '24h' | '7d';
type ChartMode = 'line' | 'candle';

/* ── paginated Supabase fetch (bypasses 1000-row default) ── */
async function fetchAllSnapshots(
  pair: string,
  since: string,
  fields: string,
): Promise<any[]> {
  const PAGE = 1000;
  let all: any[] = [];
  let from = 0;
  let done = false;
  while (!done) {
    const { data } = await supabase
      .from('market_snapshots')
      .select(fields)
      .eq('pair', pair)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) done = true;
    from += PAGE;
  }
  return all;
}

/* ── OHLC aggregation ── */
interface OHLC { time: string; open: number; high: number; low: number; close: number; }

function toOHLC(raw: { time: string; price: number; ts: string }[], bucketMin: number): OHLC[] {
  const buckets = new Map<string, number[]>();
  for (const p of raw) {
    const d = new Date(p.ts);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const bucket = Math.floor(mins / bucketMin) * bucketMin;
    const h = String(Math.floor(bucket / 60)).padStart(2, '0');
    const m = String(bucket % 60).padStart(2, '0');
    const dayPrefix = p.ts.slice(5, 10);
    const key = bucketMin >= 60 ? `${dayPrefix} ${h}:${m}` : `${h}:${m}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(p.price);
  }
  const candles: OHLC[] = [];
  for (const [time, prices] of buckets) {
    candles.push({ time, open: prices[0], high: Math.max(...prices), low: Math.min(...prices), close: prices[prices.length - 1] });
  }
  return candles;
}

/* ── Custom candlestick shape ── */
function CandlestickShape(props: any) {
  const { x, y, width, height, payload } = props;
  if (!payload) return null;
  const { open, close, high, low } = payload;
  const isUp = close >= open;
  const color = isUp ? '#4ade80' : '#f87171';

  // y-axis scale: we need to compute pixel positions from data values
  // The bar is positioned by recharts based on [low, high-low] stacking
  // We need to draw within the bar's allocated space
  const barTop = y;
  const barBottom = y + height;
  const range = high - low || 1;
  const scale = (v: number) => barBottom - ((v - low) / range) * height;

  const bodyTop = scale(Math.max(open, close));
  const bodyBottom = scale(Math.min(open, close));
  const bodyH = Math.max(bodyBottom - bodyTop, 1);
  const wickX = x + width / 2;
  const bodyW = Math.max(width * 0.6, 2);
  const bodyX = x + (width - bodyW) / 2;

  return (
    <g>
      {/* upper wick */}
      <line x1={wickX} y1={barTop} x2={wickX} y2={bodyTop} stroke={color} strokeWidth={1} />
      {/* lower wick */}
      <line x1={wickX} y1={bodyBottom} x2={wickX} y2={barBottom} stroke={color} strokeWidth={1} />
      {/* body */}
      <rect x={bodyX} y={bodyTop} width={bodyW} height={bodyH} fill={isUp ? color : color} stroke={color}
        rx={1} opacity={isUp ? 0.9 : 0.9} />
    </g>
  );
}

/* ── Tooltip components ── */
function PriceTooltip({ active, payload, label }: any) {
  if (!active || !payload?.[0]) return null;
  return (
    <div style={tt}>
      <p className="text-zinc-500 text-[10px] mb-0.5">{label}</p>
      <p className="text-zinc-100 font-mono font-semibold">${fmt(payload[0].value)}</p>
    </div>
  );
}

function CandleTooltip({ active, payload, label }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as OHLC;
  const isUp = d.close >= d.open;
  return (
    <div style={tt}>
      <p className="text-zinc-500 text-[10px] mb-1">{label}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] font-mono">
        <span className="text-zinc-500">O</span><span className="text-zinc-200">${fmt(d.open)}</span>
        <span className="text-zinc-500">H</span><span className="text-emerald-400">${fmt(d.high)}</span>
        <span className="text-zinc-500">L</span><span className="text-red-400">${fmt(d.low)}</span>
        <span className="text-zinc-500">C</span>
        <span className={isUp ? 'text-emerald-400' : 'text-red-400'}>${fmt(d.close)}</span>
      </div>
    </div>
  );
}

function FundingTooltip({ active, payload, label }: any) {
  if (!active || !payload?.[0]) return null;
  const val = payload[0].value;
  return (
    <div style={tt}>
      <p className="text-zinc-500 text-[10px] mb-0.5">{label}</p>
      <p className={`font-mono font-semibold ${val >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {val >= 0 ? '+' : ''}{val.toFixed(4)}%
      </p>
    </div>
  );
}

function OiTooltip({ active, payload, label }: any) {
  if (!active || !payload?.[0]) return null;
  return (
    <div style={tt}>
      <p className="text-zinc-500 text-[10px] mb-0.5">{label}</p>
      <p className="text-zinc-100 font-mono font-semibold">{fmtCompact(payload[0].value)}</p>
    </div>
  );
}

/* ── Shared UI ── */
function ChartCard({ title, subtitle, right, children, className = '' }: {
  title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`bg-surface-1 rounded-xl border border-border p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-zinc-300">{title}</h3>
          {subtitle && <span className="text-[11px] text-zinc-600 font-mono">{subtitle}</span>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function MetricPill({ label, value, color = 'zinc' }: { label: string; value: string; color?: string }) {
  const c: Record<string, string> = {
    green: 'text-emerald-400', red: 'text-red-400', yellow: 'text-yellow-400',
    blue: 'text-blue-400', zinc: 'text-zinc-200',
  };
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</span>
      <span className={`text-sm font-mono font-semibold ${c[color] ?? c.zinc}`}>{value}</span>
    </div>
  );
}

function ToggleGroup<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex bg-surface-2 rounded-lg p-0.5 gap-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-[11px] font-mono rounded-md transition-colors ${
            value === o.value ? 'bg-surface-3 text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'
          }`}>{o.label}</button>
      ))}
    </div>
  );
}

const regimeColors: Record<string, string> = {
  BullTrend: '#4ade80', BearTrend: '#f87171', Range: '#eab308', Breakout: '#a78bfa', Capitulation: '#ef4444',
};

/* ── Main component ── */
export function Market() {
  const [pairs, setPairs] = useState<string[]>([]);
  const [selectedPair, setSelectedPair] = useState('BTCUSDT');
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [chartMode, setChartMode] = useState<ChartMode>('line');
  const [rawPrice, setRawPrice] = useState<{ time: string; price: number; ts: string }[]>([]);
  const [fundingData, setFundingData] = useState<any[]>([]);
  const [oiData, setOiData] = useState<any[]>([]);
  const [regimeData, setRegimeData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.from('market_snapshots').select('pair').then(({ data }) => {
      if (!data) return;
      setPairs([...new Set(data.map((d) => d.pair))].sort());
    });
  }, []);

  const sinceISO = useMemo(() => {
    const ms = timeRange === '24h' ? 86400_000 : 7 * 86400_000;
    return new Date(Date.now() - ms).toISOString();
  }, [timeRange]);

  const fetchMarket = useCallback(async () => {
    setLoading(true);
    try {
      const timeFmt = timeRange === '7d'
        ? (ts: string) => ts.slice(5, 16).replace('T', ' ')
        : (ts: string) => ts.slice(11, 16);

      const [priceRows, fundingRows, oiRows] = await Promise.all([
        fetchAllSnapshots(selectedPair, sinceISO, 'mark_price, created_at'),
        fetchAllSnapshots(selectedPair, sinceISO, 'funding_rate, created_at'),
        fetchAllSnapshots(selectedPair, sinceISO, 'open_interest, created_at'),
      ]);

      setRawPrice(priceRows.map((d) => ({
        time: timeFmt(d.created_at), price: Number(d.mark_price), ts: d.created_at,
      })));
      setFundingData(fundingRows.map((d) => ({
        time: timeFmt(d.created_at), rate: Number(d.funding_rate) * 100,
      })));
      setOiData(oiRows.map((d) => ({
        time: timeFmt(d.created_at), oi: Number(d.open_interest),
      })));
    } finally {
      setLoading(false);
    }
  }, [selectedPair, sinceISO, timeRange]);

  useEffect(() => { fetchMarket(); }, [fetchMarket]);
  useEffect(() => { const iv = setInterval(fetchMarket, 60_000); return () => clearInterval(iv); }, [fetchMarket]);

  useEffect(() => {
    supabase.from('cycles').select('regime, regime_confidence, created_at')
      .order('created_at', { ascending: true }).limit(200)
      .then(({ data }) => setRegimeData((data ?? []).map((d) => ({
        time: d.created_at.slice(5, 16).replace('T', ' '), regime: d.regime, confidence: Number(d.regime_confidence ?? 0),
      }))));
  }, []);

  /* ── derived data ── */
  const candles = useMemo(() => {
    const bucket = timeRange === '7d' ? 60 : 5; // 1h for 7d, 5min for 24h
    return toOHLC(rawPrice, bucket);
  }, [rawPrice, timeRange]);

  // Downsample line data for 7d (keep every 5th point)
  const lineData = useMemo(() => {
    if (timeRange === '24h' || rawPrice.length <= 2000) return rawPrice;
    return rawPrice.filter((_, i) => i % 5 === 0 || i === rawPrice.length - 1);
  }, [rawPrice, timeRange]);

  const currentPrice = rawPrice.length > 0 ? rawPrice[rawPrice.length - 1].price : null;
  const firstPrice = rawPrice.length > 0 ? rawPrice[0].price : null;
  const priceChange = currentPrice && firstPrice ? currentPrice - firstPrice : null;
  const priceChangePct = priceChange && firstPrice ? (priceChange / firstPrice) * 100 : null;
  const highPrice = rawPrice.length > 0 ? Math.max(...rawPrice.map(d => d.price)) : null;
  const lowPrice = rawPrice.length > 0 ? Math.min(...rawPrice.map(d => d.price)) : null;

  const lastFunding = fundingData.length > 0 ? fundingData[fundingData.length - 1].rate : null;
  const lastOi = oiData.length > 0 ? oiData[oiData.length - 1].oi : null;
  const firstOi = oiData.length > 0 ? oiData[0].oi : null;
  const oiChangePct = lastOi && firstOi ? ((lastOi - firstOi) / firstOi) * 100 : null;

  const currentRegime = regimeData.length > 0 ? regimeData[regimeData.length - 1] : null;
  const isUp = (priceChangePct ?? 0) >= 0;
  const labelInterval = chartMode === 'candle'
    ? Math.max(1, Math.floor(candles.length / 14))
    : Math.max(1, Math.floor(lineData.length / 14));

  const fundingLabelInterval = Math.max(1, Math.floor(fundingData.length / 12));
  const oiLabelInterval = Math.max(1, Math.floor(oiData.length / 12));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-zinc-200">Market Data</h1>
          <select value={selectedPair} onChange={(e) => setSelectedPair(e.target.value)}
            className="bg-surface-2 border border-border rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-300 focus:outline-none focus:border-accent/40 cursor-pointer">
            {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {loading && <div className="w-3 h-3 border-2 border-accent/40 border-t-accent rounded-full animate-spin" />}
        </div>
        {currentRegime && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: regimeColors[currentRegime.regime] ?? '#3f3f46' }} />
            <span className="text-xs font-mono text-zinc-400">{currentRegime.regime}</span>
            <span className="text-[10px] text-zinc-600">{currentRegime.confidence}%</span>
          </div>
        )}
      </div>

      {/* Key metrics strip */}
      <div className="flex items-center gap-8 bg-surface-1 rounded-xl border border-border px-5 py-3 overflow-x-auto">
        {currentPrice != null && (
          <div className="flex items-baseline gap-2 shrink-0">
            <span className="text-xl font-mono font-bold text-zinc-100">${fmt(currentPrice)}</span>
            {priceChangePct != null && (
              <span className={`text-xs font-mono font-semibold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                {isUp ? '+' : ''}{priceChangePct.toFixed(2)}%
              </span>
            )}
          </div>
        )}
        <div className="w-px h-6 bg-border shrink-0" />
        {highPrice != null && <MetricPill label={`${timeRange} High`} value={`$${fmt(highPrice)}`} color="green" />}
        {lowPrice != null && <MetricPill label={`${timeRange} Low`} value={`$${fmt(lowPrice)}`} color="red" />}
        <div className="w-px h-6 bg-border shrink-0" />
        {lastFunding != null && (
          <MetricPill label="Funding" value={`${lastFunding >= 0 ? '+' : ''}${lastFunding.toFixed(4)}%`} color={lastFunding >= 0 ? 'green' : 'red'} />
        )}
        {lastOi != null && (
          <MetricPill label="Open Interest" value={fmtCompact(lastOi)}
            color={oiChangePct != null ? (oiChangePct >= 0 ? 'green' : 'red') : 'zinc'} />
        )}
        {oiChangePct != null && (
          <MetricPill label={`OI ${timeRange}`} value={`${oiChangePct >= 0 ? '+' : ''}${oiChangePct.toFixed(2)}%`}
            color={oiChangePct >= 0 ? 'green' : 'red'} />
        )}
      </div>

      {/* Price chart — full width */}
      <ChartCard title={`${selectedPair} Price`} subtitle={timeRange === '24h' ? '24h' : '7 days'}
        right={
          <div className="flex items-center gap-2">
            <ToggleGroup value={timeRange} onChange={setTimeRange}
              options={[{ value: '24h', label: '24H' }, { value: '7d', label: '7D' }]} />
            <ToggleGroup value={chartMode} onChange={setChartMode}
              options={[{ value: 'line', label: 'Line' }, { value: 'candle', label: 'Candle' }]} />
          </div>
        }>
        <ResponsiveContainer width="100%" height={320}>
          {chartMode === 'line' ? (
            <AreaChart data={lineData}>
              <defs>
                <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isUp ? '#4ade80' : '#f87171'} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={isUp ? '#4ade80' : '#f87171'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="time" tick={axisTickStyle} interval={labelInterval} axisLine={{ stroke: '#252535' }} tickLine={false} />
              <YAxis domain={['auto', 'auto']} tick={axisTickStyle} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => `$${fmtCompact(v)}`} width={70} />
              <Tooltip content={<PriceTooltip />} />
              <Area type="monotone" dataKey="price" stroke={isUp ? '#4ade80' : '#f87171'} strokeWidth={1.5}
                fill="url(#priceGrad)" dot={false} activeDot={{ r: 3, fill: '#fff', strokeWidth: 0 }} />
            </AreaChart>
          ) : (
            <ComposedChart data={candles}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="time" tick={axisTickStyle} interval={labelInterval} axisLine={{ stroke: '#252535' }} tickLine={false} />
              <YAxis domain={['auto', 'auto']} tick={axisTickStyle} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => `$${fmtCompact(v)}`} width={70} />
              <Tooltip content={<CandleTooltip />} />
              <Bar dataKey="high" shape={<CandlestickShape />} isAnimationActive={false}>
                {candles.map((c, i) => (
                  <Cell key={i} fill={c.close >= c.open ? '#4ade80' : '#f87171'} />
                ))}
              </Bar>
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </ChartCard>

      {/* Funding + OI side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="Funding Rate" subtitle="%">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={fundingData}>
              <defs>
                <linearGradient id="fundGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#eab308" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#eab308" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="time" tick={axisTickStyle} interval={fundingLabelInterval} axisLine={{ stroke: '#252535' }} tickLine={false} />
              <YAxis tick={axisTickStyle} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => `${v.toFixed(3)}%`} width={65} />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
              <Tooltip content={<FundingTooltip />} />
              <Area type="stepAfter" dataKey="rate" stroke="#eab308" strokeWidth={1.5}
                fill="url(#fundGrad)" dot={false} activeDot={{ r: 3, fill: '#eab308', strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Open Interest" subtitle={lastOi != null ? fmtCompact(lastOi) : ''}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={oiData}>
              <defs>
                <linearGradient id="oiGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1a1a28" vertical={false} />
              <XAxis dataKey="time" tick={axisTickStyle} interval={oiLabelInterval} axisLine={{ stroke: '#252535' }} tickLine={false} />
              <YAxis tick={axisTickStyle} axisLine={false} tickLine={false}
                tickFormatter={(v: number) => fmtCompact(v)} width={60} />
              <Tooltip content={<OiTooltip />} />
              <Area type="monotone" dataKey="oi" stroke="#60a5fa" strokeWidth={1.5}
                fill="url(#oiGrad)" dot={false} activeDot={{ r: 3, fill: '#60a5fa', strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Regime timeline */}
      <ChartCard title="Regime Timeline">
        <div className="flex gap-px h-7 rounded-lg overflow-hidden mb-3">
          {regimeData.map((d, i) => (
            <div key={i} className="flex-1 transition-colors"
              style={{ backgroundColor: regimeColors[d.regime] ?? '#3f3f46', opacity: 0.3 + (d.confidence / 100) * 0.7 }}
              title={`${d.time}: ${d.regime} (${d.confidence}%)`} />
          ))}
        </div>
        <div className="flex gap-4 flex-wrap">
          {Object.entries(regimeColors).map(([r, c]) => (
            <div key={r} className="flex items-center gap-1.5 text-xs text-zinc-500">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c }} />{r}
            </div>
          ))}
        </div>
      </ChartCard>
    </div>
  );
}
