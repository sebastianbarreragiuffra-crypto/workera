import type { ExpenseAdvanceStatus, ExpenseReportStatus } from "./data";

export const EXPENSE_STATUS_LABEL: Record<ExpenseReportStatus, string> = {
  DRAFT: "Borrador",
  SUBMITTED: "Enviada",
  IN_REVIEW: "En revisión",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
  PAID: "Pagada",
  CANCELLED: "Cancelada",
};

export function formatExpenseMoney(amount: number, currencyCode = "CLP"): string {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: currencyCode === "CLP" ? 0 : 2,
  }).format(amount);
}

export const EXPENSE_ADVANCE_STATUS_LABEL: Record<ExpenseAdvanceStatus, string> = {
  PENDING: "Pendiente de rendir",
  SETTLED: "Cerrado",
  CANCELLED: "Cancelado",
};

export function expenseStatusTone(status: ExpenseReportStatus): "neutral" | "warning" | "info" | "positive" | "negative" {
  if (status === "APPROVED" || status === "PAID") return "positive";
  if (status === "REJECTED" || status === "CANCELLED") return "negative";
  if (status === "SUBMITTED" || status === "IN_REVIEW") return "warning";
  return "neutral";
}
