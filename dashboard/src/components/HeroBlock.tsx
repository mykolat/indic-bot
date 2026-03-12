const pnlColor = (v: number) => (v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-zinc-300');

const regimeColors: Record<string, string> = {
  capitulation: 'bg-red-900/60 text-red-300 border-red-700/50',
  beartrend: 'bg-red-900/40 text-red-300 border-red-800/40',
  range: 'bg-yellow-900/40 text-yellow-300 border-yellow-700/40',
  bulltrend: 'bg-green-900/40 text-green-300 border-green-700/40',
  breakout: 'bg-blue-900/40 text-blue-300 border-blue-700/40',
};

interface HeroBlockProps {
  balance: number;
  sessionPnl: number;
  sessionPnlPct: number;
  regime: string | null;
  regimeConfidence: number | null;
  fearGreed: number | null;
  volumeRatio: number | null;
  layer: number | null;
  confluenceScore: number | null;
}

export function HeroBlock({
  balance, sessionPnl, sessionPnlPct, regime, regimeConfidence,
  fearGreed, volumeRatio, layer, confluenceScore,
}: HeroBlockProps) {
  const regimeKey = (regime || '').toLowerCase();
  const regimeStyle = regimeColors[regimeKey] || 'bg-zinc-800 text-zinc-300 border-zinc-600';

  const fgLabel = fearGreed != null
    ? (fearGreed <= 25 ? 'Extreme Fear' : fearGreed <= 45 ? 'Fear' : fearGreed <= 55 ? 'Neutral' : fearGreed <= 75 ? 'Greed' : 'Extreme Greed')
    : null;

  return (
    <div className="bg-surface-1 rounded-xl border border-border p-5 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-accent-dim to-transparent pointer-events-none" />
      <div className="relative flex items-start justify-between gap-6">
        {/* Left: Balance */}
        <div>
          <div className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Wallet Balance</div>
          <div className="text-3xl font-bold font-mono text-white">${balance.toFixed(2)}</div>
        </div>

        {/* Center: Session PnL */}
        <div className="text-center">
          <div className="text-zinc-500 text-xs uppercase tracking-wider mb-1">Session PnL</div>
          <div className={`text-2xl font-bold font-mono ${pnlColor(sessionPnl)}`}>
            {sessionPnl >= 0 ? '+' : ''}{sessionPnl.toFixed(2)}
          </div>
          <div className={`text-sm ${pnlColor(sessionPnlPct)}`}>
            {sessionPnlPct >= 0 ? '+' : ''}{sessionPnlPct.toFixed(2)}%
          </div>
        </div>

        {/* Right: Regime badge */}
        <div className="text-right">
          <div className={`inline-block px-3 py-1.5 rounded-lg border text-sm font-semibold ${regimeStyle}`}>
            {regime || 'Unknown'}
          </div>
          {regimeConfidence != null && (
            <div className="text-zinc-500 text-xs mt-1">{Math.round(regimeConfidence)}% confidence</div>
          )}
        </div>
      </div>

      {/* Secondary row */}
      <div className="relative flex items-center gap-4 mt-4 pt-3 border-t border-border/50 text-xs text-zinc-400">
        {fearGreed != null && (
          <span>
            F&G: <span className={fearGreed <= 25 ? 'text-red-400' : fearGreed >= 75 ? 'text-green-400' : 'text-zinc-300'}>{fearGreed}</span>
            {fgLabel && <span className="text-zinc-500"> {fgLabel}</span>}
          </span>
        )}
        {volumeRatio != null && (
          <span>
            Vol: <span className={volumeRatio >= 1.5 ? 'text-green-400' : volumeRatio < 0.8 ? 'text-red-400' : 'text-zinc-300'}>{volumeRatio.toFixed(2)}x</span>
          </span>
        )}
        {confluenceScore != null && (
          <span>
            Confluence: <span className={confluenceScore >= 3 ? 'text-green-400' : 'text-zinc-300'}>{confluenceScore.toFixed(0)}/5</span>
          </span>
        )}
        {layer != null && (
          <span>Layer <span className="text-zinc-300">{layer}</span></span>
        )}
      </div>
    </div>
  );
}
