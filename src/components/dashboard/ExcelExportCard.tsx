/**
 * Fase 8B.1, PASO 9 -- `excel_exports` existe como tabla desde una fase
 * anterior, pero ningún servicio genera un archivo real todavía (verificado
 * por auditoría: cero referencias en `src/lib`). Construir un exportador
 * improvisado aquí violaría el principio de la fase ("no generar Excel
 * falso") -- la UI queda preparada y explícitamente deshabilitada hasta que
 * Fase 9 implemente el contrato real.
 */
export function ExcelExportCard() {
  const ranges = ["Últimos 7 días", "Últimos 15 días", "Últimos 30 días", "Personalizado"];

  return (
    <section aria-labelledby="excel-export-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm opacity-90">
      <div className="flex items-center justify-between">
        <h2 id="excel-export-heading" className="text-sm font-semibold text-slate-900">
          Exportar Excel
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">Próximamente</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2" aria-hidden="true">
        {ranges.map((range) => (
          <span key={range} className="cursor-not-allowed rounded-md border border-border px-2.5 py-1 text-xs text-slate-400">
            {range}
          </span>
        ))}
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Incluirá marcaciones, atrasos, horas extra, ausencias y licencias. La generación real de archivos Excel
        se implementará en una fase posterior — este espacio queda preparado para recibir esa función.
      </p>

      <button
        type="button"
        disabled
        aria-disabled="true"
        className="mt-3 w-full cursor-not-allowed rounded-md border border-border bg-slate-50 px-3 py-1.5 text-sm font-medium text-slate-400"
      >
        Exportar (no disponible todavía)
      </button>
    </section>
  );
}
