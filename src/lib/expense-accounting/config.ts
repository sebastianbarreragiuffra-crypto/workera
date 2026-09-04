import "server-only";

export type ExpenseAccountingConfig =
  | { enabled: false; provider: "disabled" }
  | { enabled: true; provider: "dry-run" };

export function readExpenseAccountingConfig(): ExpenseAccountingConfig {
  if (process.env.EXPENSE_ACCOUNTING_EXPORT_ENABLED !== "true") {
    return { enabled: false, provider: "disabled" };
  }
  if (process.env.EXPENSE_ACCOUNTING_PROVIDER !== "dry-run") {
    throw new Error("EXPENSE_ACCOUNTING_PROVIDER debe ser dry-run mientras no exista un conector aprobado.");
  }
  return { enabled: true, provider: "dry-run" };
}
