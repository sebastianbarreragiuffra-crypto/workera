/**
 * Constantes y tipos de `reporting_periods` sin dependencias de servidor --
 * los consume tanto la capa de datos server-only como el componente cliente
 * de la pantalla de períodos (MB-7).
 */

export type ReportingPeriodStatus = "OPEN" | "IN_REVIEW" | "READY_TO_CLOSE" | "CLOSED" | "REOPENED";

export interface ReportingPeriod {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: ReportingPeriodStatus;
  closedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
}

/** Transiciones permitidas desde cada estado. Reglas de negocio, no de la base. */
export const ALLOWED_TRANSITIONS: Record<ReportingPeriodStatus, ReportingPeriodStatus[]> = {
  OPEN: ["IN_REVIEW"],
  IN_REVIEW: ["READY_TO_CLOSE", "OPEN"],
  READY_TO_CLOSE: ["CLOSED", "IN_REVIEW"],
  CLOSED: ["REOPENED"],
  REOPENED: ["IN_REVIEW", "READY_TO_CLOSE"],
};

const STATUS_LABEL: Record<ReportingPeriodStatus, string> = {
  OPEN: "Abierto",
  IN_REVIEW: "En revisión",
  READY_TO_CLOSE: "Listo para cerrar",
  CLOSED: "Cerrado",
  REOPENED: "Reabierto",
};

export function statusLabel(status: ReportingPeriodStatus): string {
  return STATUS_LABEL[status];
}
