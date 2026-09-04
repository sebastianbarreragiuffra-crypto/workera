import type { ExpenseAccountingPayload } from "./payload";

/** Evita CSV/Formula Injection al abrir el archivo en Excel o Google Sheets. */
export function safeSpreadsheetText(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

function csvCell(value: string | number | null): string {
  const text = typeof value === "string" ? safeSpreadsheetText(value) : value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildExpenseAccountingCsv(payload: ExpenseAccountingPayload): string {
  const header = [
    "Fecha", "Folio rendición", "Referencia pago", "Beneficiario", "Centro de costo",
    "Categoría", "Proveedor", "Glosa", "Neto", "IVA", "Total", "Moneda",
  ];
  const rows = payload.lines.map((line) => [
    line.expenseDate,
    payload.report.referenceNumber,
    payload.report.paymentReference,
    payload.report.submitterName,
    payload.report.costCenterCode ?? payload.report.costCenterName,
    `${line.categoryCode} - ${line.categoryName}`,
    line.merchant,
    line.description,
    line.netAmount.toFixed(2),
    line.taxAmount.toFixed(2),
    line.totalAmount.toFixed(2),
    line.currency,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
