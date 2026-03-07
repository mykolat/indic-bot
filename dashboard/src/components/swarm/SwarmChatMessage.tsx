import { motion } from 'framer-motion';

interface SwarmChatMessageProps {
  persona: string;
  content: string;
  vote?: string | null;
  confidence?: number | null;
  time: string;
  isJudge?: boolean;
  isSuperuser?: boolean;
  replyTo?: { persona: string; content: string } | null;
}

const PERSONA_EMOJI: Record<string, string> = {
  bull_thesis: '🐂',
  bear_thesis: '🐻',
  risk_manager: '🛡️',
  market_structure: '🔬',
  devils_advocate: '😈',
  narrative_expert: '📰',
  judge: '⚖️',
  superuser: '👑',
};

const PERSONA_COLORS: Record<string, string> = {
  bull_thesis: '#4ade80',
  bear_thesis: '#f87171',
  risk_manager: '#eab308',
  market_structure: '#60a5fa',
  devils_advocate: '#a78bfa',
  narrative_expert: '#fb923c',
  judge: '#e2e8f0',
  superuser: '#f59e0b',
};

const VOTE_COLORS: Record<string, string> = {
  LONG: '#4ade80',
  SHORT: '#f87171',
  HOLD: '#71717a',
};

export function SwarmChatMessage({
  persona, content, vote, confidence, time, isJudge, isSuperuser, replyTo,
}: SwarmChatMessageProps) {
  const emoji = PERSONA_EMOJI[persona] ?? '🤖';
  const color = PERSONA_COLORS[persona] ?? '#a1a1aa';
  const isOutgoing = isJudge;
  const label = persona.replace(/_/g, ' ').toUpperCase();

  return (
    <motion.div
      initial={{ opacity: 0, x: isOutgoing ? 30 : -30 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className={`flex gap-3 ${isOutgoing ? 'flex-row-reverse' : ''}`}
      style={isSuperuser ? { borderLeft: '3px solid #f59e0b', boxShadow: '0 0 12px 2px rgba(245, 158, 11, 0.15)', borderRadius: '8px', paddingLeft: '8px' } : undefined}
    >
      {/* Avatar */}
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-lg"
        style={{ backgroundColor: `${color}20`, border: `2px solid ${color}` }}
        title={label}
      >
        {emoji}
      </div>

      {/* Bubble */}
      <div className={`max-w-[75%] ${isOutgoing ? 'items-end' : 'items-start'} flex flex-col`}>
        {/* Header */}
        <div className={`flex items-center gap-2 mb-1 ${isOutgoing ? 'flex-row-reverse' : ''}`}>
          <span className="text-xs font-semibold" style={{ color }}>{label}</span>
          {vote && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{
              color: VOTE_COLORS[vote] ?? '#a1a1aa',
              backgroundColor: `${VOTE_COLORS[vote] ?? '#a1a1aa'}20`,
            }}>
              {vote}
            </span>
          )}
          {confidence != null && <span className="text-xs text-zinc-500">conf:{confidence}</span>}
          <span className="text-xs text-zinc-600">{time}</span>
        </div>

        {/* Reply quote */}
        {replyTo && (
          <div className="text-xs text-zinc-500 border-l-2 pl-2 mb-1 truncate max-w-full"
            style={{ borderColor: PERSONA_COLORS[replyTo.persona] ?? '#3f3f46' }}>
            {PERSONA_EMOJI[replyTo.persona] ?? '🤖'} {replyTo.content.slice(0, 80)}…
          </div>
        )}

        {/* Content */}
        <div className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isOutgoing
            ? 'bg-zinc-700 text-zinc-100'
            : isSuperuser
              ? 'bg-amber-900/30 border border-amber-800/50 text-zinc-200'
              : 'bg-zinc-800 text-zinc-300'
        }`}>
          <p className="whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    </motion.div>
  );
}
