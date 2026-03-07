interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  color?: 'green' | 'red' | 'yellow' | 'default';
}

const colorMap = {
  green: 'text-green-400',
  red: 'text-red-400',
  yellow: 'text-yellow-400',
  default: 'text-white',
};

export function StatCard({ label, value, subtitle, color = 'default' }: StatCardProps) {
  return (
    <div className="bg-surface-1 rounded-lg p-4 border border-border">
      <div className="text-zinc-400 text-sm">{label}</div>
      <div className={`text-2xl font-mono font-bold ${colorMap[color]}`}>{value}</div>
      {subtitle && <div className="text-zinc-500 text-xs mt-1">{subtitle}</div>}
    </div>
  );
}
