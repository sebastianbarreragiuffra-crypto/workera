import Link from "next/link";
import type { PriorityQueueItem } from "../../lib/view-models/dashboard-view";

const ICON: Record<PriorityQueueItem["key"], string> = {
  LATE: "⚠",
  OVERTIME: "◷",
  CLOCK_OUT: "●",
  LICENSE: "●",
  DOCUMENTS: "●",
};

/** Fase 8B.1, PASO 5 -- el componente más importante del dashboard: categorías de excepciones, no personas. */
export function PriorityQueueCard({ items, date }: { items: PriorityQueueItem[]; date: string }) {
  const withPending = items.filter((i) => i.count > 0);

  return (
    <section aria-labelledby="priority-queue-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 id="priority-queue-heading" className="text-sm font-semibold text-slate-900">
        Pendientes prioritarios
      </h2>

      {withPending.length === 0 ? (
        <p role="status" className="mt-3 text-sm text-slate-500">
          ✓ Sin pendientes. No hay atrasos, horas extra ni documentos pendientes de revisión.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {withPending.map((item) => (
            <li key={item.key}>
              <Link href={item.href} className="flex items-start gap-3 py-2.5 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue rounded-md px-1.5">
                <span aria-hidden="true" className="mt-0.5 text-amber-600">
                  {ICON[item.key]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-slate-800">{item.label}</span>
                    <span className="text-sm font-semibold text-slate-900">{item.count}</span>
                  </span>
                  <span className="block text-xs text-slate-500">{item.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/revision-diaria?fecha=${date}&filtro=pendientes`}
        className="mt-3 inline-block text-xs font-medium text-arcotex-blue hover:underline"
      >
        Ver todos los pendientes →
      </Link>
    </section>
  );
}
