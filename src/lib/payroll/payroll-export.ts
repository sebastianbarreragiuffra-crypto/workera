import "server-only";
import * as XLSX from "xlsx";
import type { PayrollBatchItemResult } from "./invoice-import";

/**
 * Genera el Excel final de Nómina de Pago -- combina, en UN solo archivo,
 * los datos de la factura (Nro. Documento, Monto, Nombre Cliente tal como
 * viene del Excel de finanzas) con los datos bancarios del maestro de
 * proveedores ACTIVO cuando hay match.
 *
 * Encabezado base = mismo formato BCI exacto confirmado ("Archivo_Plano_
 * Transfer"): Rut, Nombre Beneficiario, FP, BCO, N° Cuenta Cte.,
 * N° Documento, Monto a pago. Se agregan DOS columnas al final:
 * "Nombre Cliente (Factura)" (siempre presente, tal cual viene del Excel
 * de finanzas -- permite identificar la fila aunque no haya match) y
 * "Estado" (marca roja de revisión manual cuando no hay match).
 *
 * TODAS las filas de la nómina se incluyen, con o sin match -- un
 * proveedor sin match nunca detiene la generación ni queda fuera del
 * archivo (solo sus campos bancarios quedan en blanco; nunca se inventan).
 * La librería `xlsx` (Community Edition) no conserva estilos de celda al
 * escribir (relleno de color se pierde en el roundtrip) -- por eso la
 * marca roja es el texto "🔴 PROVEEDOR_NO_ENCONTRADO" en la columna
 * "Estado", no un color de fondo real.
 */
const HEADER = ["Rut", "Nombre Beneficiario", "FP", "BCO", "N° Cuenta Cte.", "N° Documento", "Monto a pago", "Nombre Cliente (Factura)", "Estado"];

export const SUPPLIER_NOT_FOUND_STATUS = "🔴 PROVEEDOR_NO_ENCONTRADO";
const OK_STATUS = "OK";

export function buildPayrollExportWorkbook(items: PayrollBatchItemResult[]): Uint8Array {
  const rows: (string | number)[][] = [
    HEADER,
    ...items.map((item) => {
      const supplier = item.status === "MATCHED" ? item.supplier : null;
      return [
        supplier?.rut ?? "",
        supplier?.name ?? "",
        supplier?.paymentMethod ?? "",
        supplier?.bankCode ?? "",
        supplier?.accountNumber ?? "",
        item.nroDocto,
        item.valorTotal,
        item.nombreCliente || item.rut || "",
        supplier ? OK_STATUS : SUPPLIER_NOT_FOUND_STATUS,
      ];
    }),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Nomina");

  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
