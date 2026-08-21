/**
 * Fase 9 -- repotenciada desde el placeholder de Fase 8B.1 PASO 9. La
 * auditoría de Fase 9 confirmó que sigue sin existir un generador real de
 * Excel de asistencia (`excel_exports` existe como tabla, cero código en
 * `src/lib` la escribe) -- inventar un formato aquí violaría la misma regla
 * que ya dejó esta tarjeta deshabilitada. Se mantiene explícitamente
 * deshabilitada hasta que el formato de exportación se defina con RRHH.
 */
const MONTH_LABEL = new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric", timeZone: "America/Santiago" });

export function DescargarAsistenciaCard({ now = new Date() }: { now?: Date }) {
  const period = MONTH_LABEL.format(now);
  const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);

  return (
    <section aria-labelledby="descargar-asistencia-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 id="descargar-asistencia-heading" className="text-sm font-semibold text-slate-900">
          Descargar asistencia
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">Próximamente</span>
      </div>

      <label htmlFor="descargar-asistencia-periodo" className="mt-3 block text-xs font-medium text-slate-500">
        Período
      </label>
      <select
        id="descargar-asistencia-periodo"
        disabled
        aria-disabled="true"
        className="mt-1 w-full cursor-not-allowed rounded-md border border-border bg-slate-50 px-2.5 py-1.5 text-sm text-slate-500"
        defaultValue={periodLabel}
      >
        <option value={periodLabel}>{periodLabel}</option>
      </select>

      <p className="mt-3 text-xs text-slate-500">Formato de exportación pendiente de configuración.</p>

      <button
        type="button"
        disabled
        aria-disabled="true"
        className="mt-3 w-full cursor-not-allowed rounded-md border border-border bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-400"
      >
        Descargar Excel
      </button>
    </section>
  );
}
