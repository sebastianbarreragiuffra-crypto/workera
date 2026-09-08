import { privateAttachmentHeaders } from "../../../../lib/shared/private-download";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function requireYearMonth(value: string | null): string {
  if (!value) throw new Error("Falta el parámetro 'mes' (formato YYYY-MM).");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("El parámetro 'mes' debe tener el formato YYYY-MM, con un mes entre 01 y 12.");
  }
  return value;
}

export function canDownloadPayrollWorkbook(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN_RRHH";
}

export function attendanceWorkbookHeaders(
  filename: string,
  byteLength: number,
  rateLimit?: { limit: number; remaining: number },
): Record<string, string> {
  return privateAttachmentHeaders(filename, byteLength, rateLimit, XLSX_MIME);
}
