import type { Database } from "@/lib/supabase/database.types";

export type ExpenseFileSecurityStatus = Database["public"]["Enums"]["expense_file_security_status"];

/** Solo estos estados permiten entregar bytes, adjuntar o iniciar OCR. */
export function isExpenseFileReleased(status: ExpenseFileSecurityStatus): boolean {
  return status === "VALIDATED_INTERNAL" || status === "CLEAN";
}

export function expenseFileSecurityLabel(status: ExpenseFileSecurityStatus): string | null {
  if (status === "PENDING_SCAN" || status === "SCANNING") return "En análisis de seguridad";
  if (status === "REJECTED") return "Archivo bloqueado";
  if (status === "SCAN_FAILED") return "Revisión de seguridad pendiente";
  return null;
}
