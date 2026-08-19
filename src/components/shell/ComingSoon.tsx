export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <p className="text-sm text-slate-500">
        Esta sección todavía no está construida — queda para una fase de UI posterior. No hay datos que mostrar todavía.
      </p>
    </div>
  );
}
