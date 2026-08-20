import type { CaseStatus } from "../../../lib/view-models/daily-review-view";
import { caseStatusLabel } from "../../../lib/view-models/daily-review-view";
import { Badge, type BadgeTone } from "../../../components/shell/Badge";

/** Fase 8B.2, PASO 7 -- nunca depende solo del color: siempre ícono + texto. */
const STATUS_TONE: Record<Exclude<CaseStatus, null>, BadgeTone> = {
  PENDIENTE: "warning",
  VENCIDO: "negative",
  REQUIERE_DOCUMENTO: "info",
  REVISADO: "positive",
};

export function StatusBadge({ status }: { status: CaseStatus }) {
  const resolved = status ?? "REVISADO";
  return <Badge label={caseStatusLabel(status)} tone={STATUS_TONE[resolved]} />;
}

/** Variante para decisiones ya tomadas (Justificado/No justificado/Aprobado/Rechazado). */
export function DecisionBadge({ label, tone }: { label: string; tone: "positive" | "negative" | "neutral" }) {
  return <Badge label={label} tone={tone} />;
}
