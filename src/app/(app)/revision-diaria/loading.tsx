/** Fase 8B.2, PASO 30 -- skeleton compacto que mantiene la estructura (header/filtros/lista/detalle) en vez de una página en blanco. */
export default function DailyReviewLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden="true">
      <div className="space-y-2">
        <div className="h-6 w-40 rounded bg-slate-200" />
        <div className="h-4 w-56 rounded bg-slate-200" />
      </div>
      <div className="h-1.5 w-full rounded-full bg-slate-200" />
      <div className="flex gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-6 w-20 rounded-full bg-slate-200" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,38%)_1fr]">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-slate-200" />
          ))}
        </div>
        <div className="hidden h-64 rounded-lg bg-slate-200 lg:block" />
      </div>
    </div>
  );
}
