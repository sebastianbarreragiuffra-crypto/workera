import Link from "next/link";
import type { AttendanceReadiness } from "../../lib/view-models/attendance-readiness";
import { formatDateLong } from "../../lib/view-models/date-utils";
import { Badge } from "../shell/Badge";

/**
 * Fase 9 -- lee `AttendanceReadiness` (attendance-readiness.ts), que combina
 * `getDailyReview` (Fase 7) y `listMedicalLicenses` (aprobación de licencias
 * médicas) sin recalcular ninguno de los dos. Esta tarjeta solo presenta ese
 * resultado -- nunca decide por su cuenta si un caso bloquea o no.
 */

const MAX_BLOCKERS_SHOWN = 5;

export function AttendanceReadinessCard({ readiness }: { readiness: AttendanceReadiness }) {
  const { cutoffDate, ready, blockers, totalBlockerCount } = readiness;
  const shown = blockers.slice(0, MAX_BLOCKERS_SHOWN);
  const hasMore = totalBlockerCount > shown.length;

  return (
    <section aria-labelledby="attendance-readiness-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 id="attendance-readiness-heading" className="text-sm font-semibold text-slate-900">
          Asistencia actualizada
        </h2>
        {ready ? (
          <Badge label="Actualizada" tone="positive" />
        ) : (
          <Badge label={`${totalBlockerCount} pendiente${totalBlockerCount === 1 ? "" : "s"}`} tone="warning" />
        )}
      </div>
      <p className="text-xs text-slate-400">Hasta el {formatDateLong(cutoffDate)}</p>

      {ready ? (
        <p role="status" className="mt-3 text-sm text-slate-500">
          ✓ Todo al día para el {formatDateLong(cutoffDate)}.
        </p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-border">
            {shown.map((blocker) => (
              <li key={blocker.key}>
                <Link
                  href={blocker.href}
                  className="block rounded-md px-1.5 py-2 text-sm text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
                >
                  {blocker.message}
                </Link>
              </li>
            ))}
          </ul>
          {hasMore && (
            <Link
              href={`/revision-diaria?fecha=${cutoffDate}`}
              className="mt-2 inline-block text-xs font-medium text-arcotex-blue hover:underline"
            >
              Ver todos los pendientes
            </Link>
          )}
        </>
      )}
    </section>
  );
}
