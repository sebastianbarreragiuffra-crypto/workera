import Link from "next/link";
import type { KpiSet } from "../../lib/view-models/dashboard-view";

/**
 * Fila de KPIs compacta (Fase 8B.1 PASO 4, restilizada en Fase 8C sobre el
 * mockup ARCOTEX aprobado -- SOLO esta fila, el resto del dashboard no se
 * toca). Todos los números siguen viniendo de `KpiSet` (`dashboard-view.ts`,
 * `computeKpis`), sin recalcular ni agregar nada aquí. Colores de ícono
 * FIJOS por concepto (no cambian según el valor) a propósito: esta fila es
 * contexto de un vistazo, la urgencia dinámica ya la comunican "Pendientes
 * Prioritarios" y "Pendientes de Revisión" más abajo -- competir con esos
 * colores aquí sería ruido, no jerarquía.
 */

type TileTone = "neutral" | "critical" | "warning" | "info";

const TONE_ICON_CLASS: Record<TileTone, string> = {
  neutral: "bg-slate-100 text-slate-500",
  critical: "bg-critical-bg text-critical",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
};

function Icon({ name }: { name: "users" | "clock" | "clock-plus" | "device" | "calendar" | "check-list" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
          <path d="M16 8.5a3 3 0 1 0 0-5.9" />
          <path d="M21 20c0-2.7-1.8-4.7-4-5.3" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      );
    case "clock-plus":
      return (
        <svg {...common}>
          <circle cx="12" cy="13" r="7" />
          <path d="M12 10v3l2 2" />
          <path d="M9 3h6M12 3v2" />
        </svg>
      );
    case "device":
      return (
        <svg {...common}>
          <rect x="6" y="2" width="12" height="20" rx="2" />
          <path d="M6 6h12M6 18h12" />
          <path d="M9 21h6" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="17" rx="2" />
          <path d="M3 9h18M8 2v4M16 2v4" />
        </svg>
      );
    case "check-list":
      return (
        <svg {...common}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      );
  }
}

interface KpiTile {
  key: string;
  label: string;
  value: number;
  hint: string;
  icon: Parameters<typeof Icon>[0]["name"];
  tone: TileTone;
  href: string;
}

export function KpiRow({ kpis, date }: { kpis: KpiSet; date: string }) {
  const tiles: KpiTile[] = [
    { key: "workers", label: "Trabajadores", value: kpis.workersPresentToday, hint: `De ${kpis.workersActive} activos`, icon: "users", tone: "neutral", href: "/empleados" },
    { key: "late", label: "Atrasos", value: kpis.lateArrivalsPending, hint: "Por justificar", icon: "clock", tone: "critical", href: `/revision-diaria?fecha=${date}&filtro=atrasos` },
    { key: "overtime", label: "Horas Extras", value: kpis.overtimePending, hint: "Por aprobar", icon: "clock-plus", tone: "warning", href: `/revision-diaria?fecha=${date}&filtro=horas-extra` },
    { key: "clockout", label: "Clock Out Pendientes", value: kpis.clockOutPending, hint: "Por revisar", icon: "device", tone: "critical", href: `/revision-diaria?fecha=${date}&filtro=clock-out` },
    { key: "absences", label: "Ausencias", value: kpis.absencesToday, hint: "Registradas hoy", icon: "calendar", tone: "info", href: `/revision-diaria?fecha=${date}&filtro=ausencias` },
    { key: "pending", label: "Pendientes de Cerrar", value: kpis.pendingToClose, hint: "Acciones pendientes", icon: "check-list", tone: "neutral", href: `/revision-diaria?fecha=${date}&filtro=pendientes` },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <Link
          key={tile.key}
          href={tile.href}
          className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-3 shadow-sm hover:border-arcotex-blue/40 hover:shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
        >
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${TONE_ICON_CLASS[tile.tone]}`}>
            <Icon name={tile.icon} />
          </span>
          <span className="min-w-0">
            <span className="block text-xl font-semibold leading-tight text-slate-900">{tile.value}</span>
            <span className="block truncate text-xs font-medium text-slate-700">{tile.label}</span>
            <span className="block truncate text-[11px] text-slate-400">{tile.hint}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}
