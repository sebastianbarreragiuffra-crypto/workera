import type { WeekSummary } from "../../lib/view-models/dashboard-view";

/** Fase 8B.1, PASO 8 -- solo métricas con agregación backend confiable; asistencia promedio queda documentada como pendiente, nunca calculada de forma improvisada aquí. */
export function WeekSummaryCard({ summary }: { summary: WeekSummary }) {
  const rows: { label: string; value: string }[] = [
    { label: "Atrasos", value: String(summary.lateArrivalsCount) },
    { label: "Minutos de atraso", value: `${summary.lateArrivalsMinutes} min` },
    { label: "Horas extra aprobadas", value: `${(summary.overtimeApprovedMinutes / 60).toFixed(1)} h` },
    { label: "Ausencias", value: String(summary.absencesCount) },
    { label: "Bonos generados", value: String(summary.bonusesGrantedCount) },
  ];

  return (
    <section aria-labelledby="week-summary-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 id="week-summary-heading" className="text-sm font-semibold text-slate-900">
        Esta semana
      </h2>
      <p className="text-xs text-slate-400">
        {summary.weekStart} — {summary.weekEnd}
      </p>

      <dl className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <dt className="text-slate-500">Asistencia promedio</dt>
          <dd className="text-xs italic text-slate-400">No disponible aún</dd>
        </div>
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-sm">
            <dt className="text-slate-500">{row.label}</dt>
            <dd className="font-medium text-slate-800">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
