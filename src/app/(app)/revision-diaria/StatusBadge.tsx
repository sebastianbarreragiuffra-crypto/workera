import type { CaseStatus } from "../../../lib/view-models/daily-review-view";
import { caseStatusLabel } from "../../../lib/view-models/daily-review-view";

/** Fase 8B.2, PASO 7 -- nunca depende solo del color: siempre ícono + texto. */
const STATUS_CLASS: Record<Exclude<CaseStatus, null>, string> = {
  PENDIENTE: "bg-warning-bg text-warning ring-warning-border",
  VENCIDO: "bg-critical-bg text-critical ring-critical-border",
  REQUIERE_DOCUMENTO: "bg-info-bg text-info ring-info-border",
  REVISADO: "bg-success-bg text-success ring-success-border",
};

export function StatusBadge({ status }: { status: CaseStatus }) {
  const resolved = status ?? "REVISADO";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_CLASS[resolved]}`}>
      <span aria-hidden="true">●</span>
      {caseStatusLabel(status)}
    </span>
  );
}

/** Variante para decisiones ya tomadas (Justificado/No justificado/Aprobado/Rechazado). */
export function DecisionBadge({ label, tone }: { label: string; tone: "positive" | "negative" | "neutral" }) {
  const toneClass =
    tone === "positive" ? "bg-success-bg text-success ring-success-border" : tone === "negative" ? "bg-critical-bg text-critical ring-critical-border" : "bg-slate-100 text-slate-600 ring-slate-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${toneClass}`}>
      <span aria-hidden="true">●</span>
      {label}
    </span>
  );
}
