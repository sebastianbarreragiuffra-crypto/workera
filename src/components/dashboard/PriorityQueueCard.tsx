import Link from "next/link";
import type { PriorityQueueItem, PriorityQueueKey } from "../../lib/view-models/dashboard-view";

/**
 * Fase 8B.1 PASO 5, restilizado en Fase 8C sobre el mockup ARCOTEX aprobado
 * (solo esta sección -- el resto del dashboard no se toca). Sigue siendo
 * EXACTAMENTE el mismo `PriorityQueueItem[]` de `dashboard-view.ts`: ningún
 * conteo, orden ni regla de negocio se recalcula aquí, solo la presentación.
 */

type Severity = "critical" | "warning" | "info";

const SEVERITY: Record<PriorityQueueKey, Severity> = {
  LATE: "critical",
  OVERTIME: "warning",
  CLOCK_OUT: "critical",
  LICENSE: "info",
  DOCUMENTS: "info",
};

const SEVERITY_CLASS: Record<Severity, { icon: string; badge: string }> = {
  critical: { icon: "bg-critical-bg text-critical", badge: "bg-critical-bg text-critical ring-1 ring-inset ring-critical-border" },
  warning: { icon: "bg-warning-bg text-warning", badge: "bg-warning-bg text-warning ring-1 ring-inset ring-warning-border" },
  info: { icon: "bg-info-bg text-info", badge: "bg-info-bg text-info ring-1 ring-inset ring-info-border" },
};

function ItemIcon({ itemKey }: { itemKey: PriorityQueueKey }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (itemKey) {
    case "LATE":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      );
    case "OVERTIME":
      return (
        <svg {...common}>
          <circle cx="12" cy="13" r="7" />
          <path d="M12 10v3l2 2" />
          <path d="M9 3h6M12 3v2" />
        </svg>
      );
    case "CLOCK_OUT":
      return (
        <svg {...common}>
          <rect x="6" y="2" width="12" height="20" rx="2" />
          <path d="M6 6h12M6 18h12" />
          <path d="M9 21h6" />
        </svg>
      );
    case "LICENSE":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5" />
        </svg>
      );
    case "DOCUMENTS":
      return (
        <svg {...common}>
          <path d="M7 3h7l4 4v14H7z" />
          <path d="M14 3v4h4" />
          <path d="M9.5 12h5M9.5 15.5h5" />
        </svg>
      );
  }
}

export function PriorityQueueCard({ items, date }: { items: PriorityQueueItem[]; date: string }) {
  const withPending = items.filter((i) => i.count > 0);
  const total = withPending.reduce((sum, i) => sum + i.count, 0);

  return (
    <section aria-labelledby="priority-queue-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 id="priority-queue-heading" className="text-sm font-semibold text-slate-900">
            Pendientes prioritarios
          </h2>
          {total > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-critical px-1.5 text-[11px] font-semibold text-white">{total}</span>
          )}
        </div>
        <Link href={`/revision-diaria?fecha=${date}&filtro=pendientes`} className="text-xs font-medium text-arcotex-blue hover:underline">
          Ver todos
        </Link>
      </div>

      {withPending.length === 0 ? (
        <p role="status" className="mt-3 text-sm text-slate-500">
          ✓ Sin pendientes. No hay atrasos, horas extra ni documentos pendientes de revisión.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {withPending.map((item) => {
            const severity = SEVERITY[item.key];
            const cls = SEVERITY_CLASS[severity];
            return (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="flex items-center gap-3 py-2.5 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue rounded-md px-1.5"
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${cls.icon}`}>
                    <ItemIcon itemKey={item.key} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-slate-800">{item.label}</span>
                    <span className="block truncate text-xs text-slate-500">{item.description}</span>
                  </span>
                  <span className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-2 text-xs font-semibold ${cls.badge}`}>{item.count}</span>
                  <span aria-hidden="true" className="shrink-0 text-slate-300">
                    ›
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
