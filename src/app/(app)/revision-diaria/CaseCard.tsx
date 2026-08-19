import Link from "next/link";
import type { DailyReviewCardViewModel } from "../../../lib/view-models/daily-review-view";
import { buildCaseCardContent } from "../../../lib/view-models/daily-review-view";
import { StatusBadge } from "./StatusBadge";

function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

const AREA_LABEL: Record<DailyReviewCardViewModel["areaCode"], string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

/** Fase 8B.2, PASO 6 -- card compacta, máximo la información necesaria para decidir si abrirla. */
export function CaseCard({ card, date, selected }: { card: DailyReviewCardViewModel; date: string; selected: boolean }) {
  const content = buildCaseCardContent(card);

  return (
    <li>
      <Link
        href={`/revision-diaria?fecha=${date}&area=${card.areaCode}&empleado=${card.employeeId}`}
        aria-current={selected ? "true" : undefined}
        className={`flex items-start gap-3 rounded-lg border p-3 hover:border-arcotex-blue hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue ${
          selected ? "border-arcotex-blue bg-arcotex-blue/5" : "border-border bg-card"
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-arcotex-blue/10 text-xs font-semibold text-arcotex-blue-dark"
        >
          {initialsOf(card.displayName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">{card.displayName}</span>
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-400">{AREA_LABEL[card.areaCode]}</span>
          </span>
          <span className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
            <span aria-hidden="true">{content.icon}</span>
            {content.title}
          </span>
          {content.subtitle && <span className="block text-xs text-slate-500">{content.subtitle}</span>}
          <span className="mt-1.5 block">
            <StatusBadge status={card.primaryStatus} />
          </span>
        </span>
      </Link>
    </li>
  );
}
