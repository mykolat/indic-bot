import { motion } from 'framer-motion';

interface LevelDividerProps {
  level: number;
  label?: string;
}

export function LevelDivider({ level, label }: LevelDividerProps) {
  const labels: Record<number, string> = {
    1: 'Analysis',
    2: 'Critique',
    3: 'Revision',
    4: 'Deep Dive',
    5: 'Final Round',
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <motion.div
        className="flex-1 h-px bg-zinc-800 origin-right"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      />
      <motion.span
        className="text-xs text-zinc-500 font-medium shrink-0"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2, ease: 'easeOut' }}
      >
        Level {level}: {label || labels[level] || `Round ${level}`}
      </motion.span>
      <motion.div
        className="flex-1 h-px bg-zinc-800 origin-left"
        initial={{ scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      />
    </div>
  );
}
