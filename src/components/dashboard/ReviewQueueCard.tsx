import Link from "next/link";
import type { ReviewQueuePerson } from "../../lib/view-models/dashboard-view";
import { EmployeeAvatar } from "../shell/EmployeeAvatar";
import { Badge, type BadgeTone } from "../shell/Badge";

/**
 * Fase 8B.1 PASO 6, restilizado en Fase 8C sobre el mockup ARCOTEX aprobado.
 * Deliberadamente distinto de PriorityQueueCard: esa tarjeta muestra
 * CATEGORÍAS (cuántos atrasos hay); esta muestra PERSONAS concretas -- cada
 * fila es un caso real que el supervisor puede abrir y decidir de inmediato
 * en Revisión Diaria. Mismo `ReviewQueuePerson[]` de dashboard-view.ts, sin
 * tocar backend/scoping/orden.
 */

const CATEGORY_LABEL: Record<ReviewQueuePerson["category"], string> = {
  LATE: "Atraso",
  OVERTIME: "Horas Extra",
  CLOCK_OUT: "Clock Out",
  LICENSE: "Licencia",
  DOCUMENT: "Documento",
};

const CATEGORY_TONE: Record<ReviewQueuePerson["category"], BadgeTone> = {
  LATE: "negative",
  OVERTIME: "warning",
  CLOCK_OUT: "negative",
  LICENSE: "info",
  DOCUMENT: "info",
};

export function ReviewQueueCard({ people }: { people: ReviewQueuePerson[] }) {
  return (
    <section aria-labelledby="review-queue-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <h2 id="review-queue-heading" className="text-sm font-semibold text-slate-900">
          Pendientes de revisión
        </h2>
        {people.length > 0 && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-200 px-1.5 text-[11px] font-semibold text-slate-700">{people.length}</span>
        )}
      </div>
      <p className="text-xs text-slate-400">Casos individuales listos para decidir</p>

      {people.length === 0 ? (
        <p role="status" className="mt-3 text-sm text-slate-500">
          ✓ Nadie requiere revisión en este momento.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {people.map((person) => (
            <li key={person.employeeId}>
              <Link
                href={person.href}
                className="flex items-center gap-3 py-2.5 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue rounded-md px-1.5"
              >
                <EmployeeAvatar displayName={person.displayName} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">{person.displayName}</span>
                  <span className="block text-xs text-slate-500">{person.detailMinutes !== null ? `${person.detailMinutes} min` : "—"}</span>
                </span>
                <Badge label={CATEGORY_LABEL[person.category]} tone={CATEGORY_TONE[person.category]} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
