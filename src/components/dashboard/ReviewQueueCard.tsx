import Link from "next/link";
import type { ReviewQueuePerson } from "../../lib/view-models/dashboard-view";

const CATEGORY_LABEL: Record<ReviewQueuePerson["category"], string> = {
  LATE: "Atraso",
  OVERTIME: "Horas Extra",
  CLOCK_OUT: "Clock Out",
  LICENSE: "Licencia",
  DOCUMENT: "Documento",
};

/** Fase 8B.1, PASO 6 -- personas concretas, no conteos (eso ya lo muestra PriorityQueueCard). */
export function ReviewQueueCard({ people }: { people: ReviewQueuePerson[] }) {
  return (
    <section aria-labelledby="review-queue-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 id="review-queue-heading" className="text-sm font-semibold text-slate-900">
        Pendientes de revisión
      </h2>

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
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-arcotex-blue/10 text-xs font-semibold text-arcotex-blue-dark"
                >
                  {person.initials}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800">{person.displayName}</span>
                  <span className="block text-xs text-slate-500">
                    {CATEGORY_LABEL[person.category]}
                    {person.detailMinutes !== null ? ` · ${person.detailMinutes} min` : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
