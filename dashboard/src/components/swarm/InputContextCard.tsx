import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface InputContextCardProps {
  userPrompt: string;
  pair: string;
  regime: string;
  fearGreed: number;
  volumeRatio: number;
}

function extractField(text: string, field: string): string {
  const re = new RegExp(`${field}:\\s*(.+?)(?:\\n|\\\\n|$)`);
  const m = text.match(re);
  return m?.[1]?.trim() ?? '\u2014';
}

export function InputContextCard({ userPrompt, pair, regime, fearGreed, volumeRatio }: InputContextCardProps) {
  const [expanded, setExpanded] = useState(false);
  const sessionPnl = extractField(userPrompt, 'Session P&L');
  const time = extractField(userPrompt, 'Current time');
  const lastOrder = extractField(userPrompt, 'Last order');

  return (
    <div className="bg-surface-1 rounded-xl border border-border overflow-hidden">
      <div className="px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Input Context</h3>
          <span className="text-[10px] text-zinc-600 font-mono">{time}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            { label: 'Pair', value: pair, color: 'text-white' },
            { label: 'Regime', value: regime, color: 'text-accent' },
            { label: 'F&G', value: String(fearGreed), color: fearGreed < 25 ? 'text-red-400' : fearGreed > 60 ? 'text-green-400' : 'text-yellow-400' },
            { label: 'Volume', value: `${volumeRatio.toFixed(2)}x`, color: volumeRatio > 1.5 ? 'text-green-400' : 'text-zinc-300' },
            { label: 'Session', value: sessionPnl, color: sessionPnl.includes('-') ? 'text-red-400' : 'text-green-400' },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div className="text-[10px] text-zinc-600 uppercase tracking-wide">{label}</div>
              <div className={`text-sm font-mono font-semibold ${color}`}>{value}</div>
            </div>
          ))}
        </div>
        {lastOrder !== '\u2014' && (
          <div className="mt-3 text-xs text-zinc-500 font-mono truncate">Last: {lastOrder}</div>
        )}
      </div>
      <button onClick={() => setExpanded(e => !e)} className="w-full px-5 py-2 text-[10px] uppercase tracking-widest text-zinc-600 hover:text-zinc-400 border-t border-border-subtle transition-colors text-left">
        {expanded ? 'Hide full prompt' : 'Show full prompt'}
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }} className="overflow-hidden">
            <pre className="px-5 pb-4 text-[11px] text-zinc-500 font-mono whitespace-pre-wrap leading-relaxed max-h-80 overflow-y-auto">{userPrompt}</pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
