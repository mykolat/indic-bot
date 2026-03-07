import { motion } from 'framer-motion';

interface ConflictCardProps {
  personaA: string;
  personaB: string;
  topic: string;
  severity: 'low' | 'medium' | 'high';
}

const PERSONA_EMOJI: Record<string, string> = {
  bull_thesis: '\u{1F402}',
  BT: '\u{1F402}',
  bear_thesis: '\u{1F43B}',
  BA: '\u{1F43B}',
  risk_manager: '\u{1F6E1}\uFE0F',
  RM: '\u{1F6E1}\uFE0F',
  market_structure: '\u{1F52C}',
  MS: '\u{1F52C}',
  devils_advocate: '\u{1F608}',
  DA: '\u{1F608}',
  narrative_expert: '\u{1F4F0}',
  NE: '\u{1F4F0}',
};

const SEVERITY_CONFIG = {
  low: {
    border: 'border-zinc-600',
    bg: 'bg-zinc-800/50',
    barColor: 'bg-zinc-500',
    barWidth: '30%',
    label: 'Low',
    labelColor: 'text-zinc-400',
  },
  medium: {
    border: 'border-yellow-700',
    bg: 'bg-yellow-950/30',
    barColor: 'bg-yellow-600',
    barWidth: '60%',
    label: 'Medium',
    labelColor: 'text-yellow-500',
  },
  high: {
    border: 'border-amber-500',
    bg: 'bg-amber-950/30',
    barColor: 'bg-amber-500',
    barWidth: '100%',
    label: 'High',
    labelColor: 'text-amber-400',
  },
} as const;

function getEmoji(persona: string): string {
  return PERSONA_EMOJI[persona] ?? '\u{1F916}';
}

function formatTopic(topic: string): string {
  return topic.replace(/_/g, ' ');
}

export function ConflictCard({ personaA, personaB, topic, severity }: ConflictCardProps) {
  const config = SEVERITY_CONFIG[severity];
  const emojiA = getEmoji(personaA);
  const emojiB = getEmoji(personaB);

  const card = (
    <div
      className={`
        max-w-sm mx-auto rounded-lg border ${config.border} ${config.bg}
        px-4 py-3 my-2
      `}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className={`text-[10px] font-bold tracking-widest uppercase ${config.labelColor}`}>
          Conflict
        </span>
        <div className="flex items-center gap-1.5 text-base">
          <span title={personaA}>{emojiA}</span>
          <span className="text-zinc-500 text-xs font-medium">vs</span>
          <span title={personaB}>{emojiB}</span>
        </div>
      </div>

      {/* Topic */}
      <p className="text-sm text-zinc-300 mb-3 capitalize leading-snug">
        {formatTopic(topic)}
      </p>

      {/* Severity bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-zinc-700/60 overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${config.barColor}`}
            initial={{ width: 0 }}
            animate={{ width: config.barWidth }}
            transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
          />
        </div>
        <span className={`text-[10px] font-semibold uppercase ${config.labelColor}`}>
          {config.label}
        </span>
      </div>
    </div>
  );

  /* High severity: wrap in a pulsing glow container */
  if (severity === 'high') {
    return (
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <motion.div
          className="rounded-lg"
          animate={{
            boxShadow: [
              '0 0 0px 0px rgba(245, 158, 11, 0.3)',
              '0 0 12px 2px rgba(245, 158, 11, 1)',
              '0 0 0px 0px rgba(245, 158, 11, 0.3)',
            ],
          }}
          transition={{
            duration: 2,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        >
          {card}
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {card}
    </motion.div>
  );
}
