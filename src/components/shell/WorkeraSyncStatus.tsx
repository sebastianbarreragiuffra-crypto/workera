import type { WorkeraSyncHealth, WorkeraSyncHealthStatus } from "../../lib/sync/scheduler";

/**
 * Estado de sincronización Workera (Fase 8, PASO 8). Solo SUPER_ADMIN/RRHH
 * la renderizan (ver dashboard-view.ts: `getWorkeraSyncHealth` solo se
 * llama dentro de `getAdminDashboard`). Nunca muestra `error_summary` crudo
 * ni ningún detalle interno -- solo el estado y las fechas ya normalizadas
 * por `getWorkeraSyncHealth`.
 */

const STATUS_LABEL: Record<WorkeraSyncHealthStatus, string> = {
  HEALTHY: "Sincronización al día",
  STALE: "Sincronización desactualizada",
  RUNNING: "Sincronizando ahora",
  DEGRADED: "Última sincronización con errores",
  UNKNOWN: "Sin datos de sincronización",
};

const STATUS_CLASS: Record<WorkeraSyncHealthStatus, string> = {
  HEALTHY: "bg-green-50 text-green-700 ring-green-600/20",
  STALE: "bg-amber-50 text-amber-700 ring-amber-600/20",
  RUNNING: "bg-blue-50 text-blue-700 ring-blue-600/20",
  DEGRADED: "bg-red-50 text-red-700 ring-red-600/20",
  UNKNOWN: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

export function WorkeraSyncStatus({ health }: { health: WorkeraSyncHealth }) {
  return (
    <section aria-label="Estado de sincronización Workera" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Sync Workera</h2>
      <span
        className={`mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_CLASS[health.status]}`}
      >
        {STATUS_LABEL[health.status]}
      </span>
      <dl className="mt-3 space-y-1 text-xs text-slate-500">
        {health.lastSuccess && (
          <div>
            <dt className="inline">Última sincronización correcta: </dt>
            <dd className="inline font-medium text-slate-700">
              {new Date(health.lastSuccess.finishedAt).toLocaleString("es-CL")}
            </dd>
          </div>
        )}
        {!health.lastSuccess && <div>Aún no hay sincronizaciones exitosas registradas.</div>}
      </dl>
    </section>
  );
}
