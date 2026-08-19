import type { KpiSet } from "../../lib/view-models/dashboard-view";

/**
 * Fila de KPIs compacta (Fase 8B.1, PASO 4) -- reemplaza la tabla grande de
 * "Marcaciones del día" (que nunca llegó a construirse en Fase 8) por una
 * fila de excepciones/decisiones. Todos los números vienen de `KpiSet`
 * (`dashboard-view.ts`), nunca hardcodeados.
 */
export function KpiRow({ kpis }: { kpis: KpiSet }) {
  const tiles = [
    { label: "Trabajadores", value: kpis.workersPresentToday, hint: `De ${kpis.workersActive} activos` },
    { label: "Atrasos", value: kpis.lateArrivalsPending, hint: "Por justificar" },
    { label: "Horas Extras", value: kpis.overtimePending, hint: "Por aprobar" },
    { label: "Clock Out Pendientes", value: kpis.clockOutPending, hint: "Por revisar" },
    { label: "Ausencias", value: kpis.absencesToday, hint: "Registradas hoy" },
    { label: "Pendientes de Cerrar", value: kpis.pendingToClose, hint: "Acciones pendientes" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-lg border border-border bg-card p-3.5 shadow-sm">
          <div className="text-2xl font-semibold text-slate-900">{tile.value}</div>
          <div className="mt-0.5 text-xs font-medium text-slate-700">{tile.label}</div>
          <div className="text-[11px] text-slate-400">{tile.hint}</div>
        </div>
      ))}
    </div>
  );
}
