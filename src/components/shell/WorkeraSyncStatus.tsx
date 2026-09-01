import type { WorkeraSyncHealth, WorkeraSyncHealthStatus } from "../../lib/sync/scheduler";
import { formatDateTimeInSantiago } from "../../lib/view-models/date-utils";

/**
 * Estado de sincronización Workera (Fase 8, refinado visualmente en Fase
 * 8B.1). Solo SUPER_ADMIN/RRHH la renderizan (ver dashboard-view.ts:
 * `getWorkeraSyncHealth` solo se llama dentro de `getAdminDashboard`).
 * Nunca muestra `error_summary` crudo, API_USER/API_KEY, ni ningún detalle
 * interno -- solo el estado y las fechas ya normalizadas por
 * `getWorkeraSyncHealth`.
 */

const STATUS_LABEL: Record<WorkeraSyncHealthStatus, string> = {
  HEALTHY: "Sincronización exitosa",
  STALE: "Sincronización desactualizada",
  RUNNING: "Sincronizando ahora",
  DEGRADED: "Última sincronización con errores",
  UNKNOWN: "Sin datos de sincronización",
};

const STATUS_ICON: Record<WorkeraSyncHealthStatus, string> = {
  HEALTHY: "✓",
  STALE: "⚠",
  RUNNING: "◷",
  DEGRADED: "✕",
  UNKNOWN: "?",
};

const STATUS_CLASS: Record<WorkeraSyncHealthStatus, string> = {
  HEALTHY: "bg-success-bg text-success ring-success-border",
  STALE: "bg-warning-bg text-warning ring-warning-border",
  RUNNING: "bg-info-bg text-info ring-info-border",
  DEGRADED: "bg-critical-bg text-critical ring-critical-border",
  UNKNOWN: "bg-slate-100 text-slate-600 ring-slate-300",
};

export function WorkeraSyncStatus({ health }: { health: WorkeraSyncHealth }) {
  return (
    <section aria-label="Estado de sincronización Workera" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Sincronización Workera</h2>
      <span
        className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_CLASS[health.status]}`}
      >
        <span aria-hidden="true">{STATUS_ICON[health.status]}</span>
        {STATUS_LABEL[health.status]}
      </span>
      <dl className="mt-3 space-y-1 text-xs text-slate-500">
        {health.lastSuccess ? (
          <div>
            <dt className="inline">Última sincronización: </dt>
            <dd className="inline font-medium text-slate-700">
              {formatDateTimeInSantiago(health.lastSuccess.finishedAt)}
            </dd>
          </div>
        ) : (
          <div>Aún no hay sincronizaciones exitosas registradas.</div>
        )}
        {health.status === "HEALTHY" && <div className="text-success">Datos actualizados correctamente.</div>}
      </dl>
    </section>
  );
}
