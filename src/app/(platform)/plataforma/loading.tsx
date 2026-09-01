export default function PlatformLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Cargando plataforma">
      <div className="h-12 w-72 animate-pulse rounded-lg bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-lg bg-slate-200" />)}
      </div>
      <div className="h-72 animate-pulse rounded-lg bg-slate-200" />
    </div>
  );
}
