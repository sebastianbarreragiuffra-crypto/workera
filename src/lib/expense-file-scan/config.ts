import "server-only";
import { ExpenseFileScanError } from "./errors";

export type ExpenseFileScanConfig =
  | { enabled: false; provider: "disabled" }
  | { enabled: true; provider: "fixture" };

type Environment = Readonly<Record<string, string | undefined>>;

export function readExpenseFileScanConfig(env: Environment = process.env): ExpenseFileScanConfig {
  if (env.EXPENSE_FILE_SCAN_ENABLED !== "true") {
    return { enabled: false, provider: "disabled" };
  }

  if (
    env.EXPENSE_FILE_SCAN_PROVIDER === "fixture"
    && env.EXPENSE_FILE_SCAN_ALLOW_FIXTURE === "true"
    && env.NODE_ENV !== "production"
  ) {
    return { enabled: true, provider: "fixture" };
  }

  throw new ExpenseFileScanError(
    "SCANNER_CONFIGURATION",
    "No existe un proveedor antimalware habilitable para este ambiente.",
    false,
  );
}
