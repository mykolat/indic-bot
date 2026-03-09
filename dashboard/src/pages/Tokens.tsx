import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Token {
  id: number;
  label: string;
  provider: string;
  auth_type: string;
  primary_used_pct: number;
  secondary_used_pct: number;
  primary_reset_at: string | null;
  secondary_reset_at: string | null;
  is_active: boolean;
  last_used_at: string | null;
  last_error: string | null;
  account_id: string | null;
}

function timeUntil(iso: string | null): string {
  if (!iso) return '\u2014';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 24) return `${(h / 24).toFixed(1)}d`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Bar({ pct, warn = 80 }: { pct: number; warn?: number }) {
  const color = pct >= 95 ? 'bg-red-500' : pct >= warn ? 'bg-yellow-500' : 'bg-emerald-500';
  return (
    <div className="w-24 h-2 bg-surface-3 rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function StatusBadge({ token }: { token: Token }) {
  const recent = token.last_used_at && (Date.now() - new Date(token.last_used_at).getTime()) < 5 * 60_000;
  if (!token.is_active) return <span className="text-xs text-red-400">disabled</span>;
  if (recent) return <span className="text-xs text-emerald-400">active</span>;
  return <span className="text-xs text-fg-faint">idle</span>;
}

export function Tokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [allExhausted, setAllExhausted] = useState(false);

  const fetchTokens = () => {
    supabase.from('tokens')
      .select('id, label, provider, auth_type, primary_used_pct, secondary_used_pct, primary_reset_at, secondary_reset_at, is_active, last_used_at, last_error, account_id')
      .order('provider')
      .order('secondary_used_pct', { ascending: true })
      .then(({ data }) => {
        if (!data) return;
        setTokens(data);
        const codex = data.filter(t => t.provider === 'codex' && t.is_active);
        setAllExhausted(codex.length > 0 && codex.every(t => t.secondary_used_pct >= 95));
      });
  };

  useEffect(() => {
    fetchTokens();
    const id = setInterval(fetchTokens, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Tokens</h1>

      {allExhausted && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
          All Codex tokens exhausted — bot is using Layer 2/3 fallback
        </div>
      )}

      <div className="bg-surface-1 border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-fg-faint text-left">
              <th className="px-4 py-2">Label</th>
              <th className="px-4 py-2">Provider</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">5h Used</th>
              <th className="px-4 py-2">Weekly Used</th>
              <th className="px-4 py-2">Reset</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map(t => (
              <tr key={t.id} className="border-b border-border/50 hover:bg-surface-2/50">
                <td className="px-4 py-2 font-mono">{t.label}</td>
                <td className="px-4 py-2">{t.provider}</td>
                <td className="px-4 py-2 text-fg-faint">{t.auth_type}</td>
                <td className="px-4 py-2">
                  {t.provider === 'codex' ? (
                    <div className="flex items-center gap-2">
                      <Bar pct={t.primary_used_pct} />
                      <span className="text-xs text-fg-faint">{t.primary_used_pct}%</span>
                    </div>
                  ) : '\u2014'}
                </td>
                <td className="px-4 py-2">
                  {t.provider === 'codex' ? (
                    <div className="flex items-center gap-2">
                      <Bar pct={t.secondary_used_pct} warn={85} />
                      <span className="text-xs text-fg-faint">{t.secondary_used_pct}%</span>
                    </div>
                  ) : '\u2014'}
                </td>
                <td className="px-4 py-2 text-xs text-fg-faint">
                  {t.provider === 'codex' ? timeUntil(t.secondary_reset_at) : '\u2014'}
                </td>
                <td className="px-4 py-2"><StatusBadge token={t} /></td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-fg-faint">No tokens. Run: npm run token:add</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
