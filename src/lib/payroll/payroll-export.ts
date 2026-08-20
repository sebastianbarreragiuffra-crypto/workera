import "server-only";
import * as XLSX from "xlsx";
import type { PayrollBatchItemResult } from "./invoice-import";

/**
 * Genera el Excel final listo para el portal de proveedores de BCI --
 * mismo encabezado exacto confirmado en el archivo real de referencia
 * ("Archivo_Plano_Transfer"): Rut, Nombre Beneficiario, FP, BCO,
 * N° Cuenta Cte., N° Documento, Monto a pago. Solo incluye ítems MATCHED --
 * un proveedor sin match nunca llega a este archivo (se reporta aparte para
 * revisión manual, ver `generatePayrollBatch`).
 */
const HEADER = ["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte.", "N° Documento", "Monto a pago"];

export function buildPayrollExportWorkbook(items: PayrollBatchItemResult[]): Uint8Array {
  const matched = items.filter((i) => i.status === "MATCHED" && i.supplier);

  const rows: (string | number)[][] = [
    HEADER,
    ...matched.map((item) => [
      item.supplier!.rut,
      item.supplier!.name,
      item.supplier!.paymentMethod,
      item.supplier!.bankCode,
      item.supplier!.accountNumber,
      item.nroDocto,
      item.valorTotal,
    ]),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Nomina");

  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
