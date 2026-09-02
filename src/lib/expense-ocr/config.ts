import "server-only";
import { ExpenseOcrError } from "./errors";

export interface DisabledExpenseOcrConfig {
  enabled: false;
  provider: "disabled";
}

export interface AzureExpenseOcrConfig {
  enabled: true;
  provider: "azure-document-intelligence";
  endpoint: URL;
  apiKey: string;
  requestTimeoutMs: number;
}

export type ExpenseOcrConfig = DisabledExpenseOcrConfig | AzureExpenseOcrConfig;

export function readExpenseOcrConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): ExpenseOcrConfig {
  if (env.EXPENSE_OCR_ENABLED !== "true") return { enabled: false, provider: "disabled" };
  if (env.EXPENSE_OCR_PROVIDER !== "azure-document-intelligence") {
    throw new ExpenseOcrError("CONFIGURATION", "EXPENSE_OCR_PROVIDER no está configurado para Azure.", false);
  }

  let endpoint: URL;
  try {
    endpoint = new URL(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? "");
  } catch {
    throw new ExpenseOcrError("CONFIGURATION", "El endpoint de Azure Document Intelligence no es válido.", false);
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
    throw new ExpenseOcrError("CONFIGURATION", "El endpoint de Azure debe usar HTTPS y no contener credenciales.", false);
  }
  const apiKey = env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim();
  if (!apiKey) throw new ExpenseOcrError("CONFIGURATION", "Falta la credencial de Azure Document Intelligence.", false);

  const requestTimeoutMs = Number(env.EXPENSE_OCR_REQUEST_TIMEOUT_MS ?? "15000");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 60000) {
    throw new ExpenseOcrError("CONFIGURATION", "EXPENSE_OCR_REQUEST_TIMEOUT_MS debe estar entre 1000 y 60000.", false);
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
  endpoint.search = "";
  endpoint.hash = "";
  return { enabled: true, provider: "azure-document-intelligence", endpoint, apiKey, requestTimeoutMs };
}
