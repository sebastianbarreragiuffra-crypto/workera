export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Cargando" className="animate-pulse space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-16 rounded-lg border border-border bg-card" />
      ))}
    </div>
  );
}
