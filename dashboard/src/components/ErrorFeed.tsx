interface ErrorItem {
  code: string;
  message: string;
  created_at: string;
}

export function ErrorFeed({ errors }: { errors: ErrorItem[] }) {
  if (!errors.length) return <div className="text-green-400 p-2 text-sm">No recent errors</div>;
  return (
    <div className="space-y-1 max-h-48 overflow-y-auto">
      {errors.map((e, i) => (
        <div key={i} className="text-xs flex gap-2 p-1">
          <span className="text-zinc-500 font-mono shrink-0">
            {new Date(e.created_at).toLocaleTimeString()}
          </span>
          <span className="text-red-400 font-mono shrink-0">{e.code}</span>
          <span className="text-zinc-300 truncate">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
