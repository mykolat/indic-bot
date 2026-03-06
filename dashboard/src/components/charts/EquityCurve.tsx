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
