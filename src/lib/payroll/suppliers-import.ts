import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { normalizeName } from "../business-rules/name-matching";

/**
 * Importador del maestro de proveedores (Nómina de Pago). Formato real
 * confirmado (archivo "LISTADO DE PROVEEDORES", hoja "Beneficiarios"):
 * columnas fijas en orden -- Rut, Nombre Beneficiario, FP, BCO,
 * N° Cuenta Cte. -- sin fila de relleno antes del encabezado, a diferencia
 * del Excel mensual de facturas (`invoice-import.ts`). Se lee por POSICIÓN
 * de columna (no por nombre de encabezado) porque los archivos reales
 * exportados desde Excel antiguo traen el símbolo "°" con problemas de
 * codificación (aparece como "N� Cuenta Cte.") -- comparar por texto sería
 * frágil; la posición de columna es estable.
 *
 * ADVERTENCIA DE SEGURIDAD (mismo criterio que `import-birthdays.ts`, Fase
 * 7): la librería `xlsx` (SheetJS) tiene vulnerabilidades conocidas sin
 * parche (prototype pollution, ReDoS). Aceptable acá por el mismo motivo:
 * solo procesa un archivo subido manualmente por un administrador
 * autenticado (SUPER_ADMIN/ADMIN_RRHH), nunca input de red no confiable.
 */

export interface ParsedSupplierRow {
  rowNumber: number;
  rut: string;
  name: string;
  paymentMethod: string;
  bankCode: string;
  accountNumber: string;
}

export type SupplierParseIssueReason = "MISSING_FIELD";

export interface SupplierParseIssue {
  rowNumber: number;
  reason: SupplierParseIssueReason;
}

export interface ParseSuppliersExcelResult {
  valid: ParsedSupplierRow[];
  issues: SupplierParseIssue[];
}

export function parseSuppliersExcel(fileBytes: Uint8Array): ParseSuppliersExcelResult {
  const workbook = XLSX.read(fileBytes, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });

  const valid: ParsedSupplierRow[] = [];
  const issues: SupplierParseIssue[] = [];

  // Fila 0 = encabezado (Rut, Nombre Beneficiario, FP, BCO, N° Cuenta Cte.), datos desde la fila 1.
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const excelRowNumber = i + 1;
    if (!row || row.every((cell) => cell === null || cell === "")) continue; // fila en blanco, se ignora sin reportar

    const rut = String(row[0] ?? "").trim();
    const name = String(row[1] ?? "").trim();
    const paymentMethod = String(row[2] ?? "").trim();
    const bankCode = String(row[3] ?? "").trim();
    const accountNumber = String(row[4] ?? "").trim();

    if (!rut || !name || !paymentMethod || !bankCode || !accountNumber) {
      issues.push({ rowNumber: excelRowNumber, reason: "MISSING_FIELD" });
      continue;
    }

    valid.push({ rowNumber: excelRowNumber, rut, name, paymentMethod, bankCode, accountNumber });
  }

  return { valid, issues };
}

export interface SupplierConflict {
  normalizedName: string;
  rows: number[];
}

export interface ImportSuppliersResult {
  imported: number;
  updated: number;
  /** Mismo nombre normalizado con datos bancarios distintos dentro del mismo archivo -- el archivo NO se importa hasta resolver esto manualmente. */
  conflicts: SupplierConflict[];
}

/**
 * Importa el maestro completo (upsert por `normalized_name`) -- si dos filas
 * del MISMO archivo tienen el mismo nombre normalizado pero datos bancarios
 * distintos, se reporta como conflicto y NO se importa nada de ese archivo
 * (nunca se elige uno de los dos en silencio: es dinero real).
 */
export async function importSuppliers(
  supabase: SupabaseClient<Database>,
  rows: ParsedSupplierRow[],
  createdBy: string
): Promise<ImportSuppliersResult> {
  const byName = new Map<string, ParsedSupplierRow[]>();
  for (const row of rows) {
    const key = normalizeName(row.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(row);
  }

  const conflicts: SupplierConflict[] = [];
  for (const [normalizedName, group] of byName) {
    const distinct = new Set(group.map((r) => `${r.rut}|${r.paymentMethod}|${r.bankCode}|${r.accountNumber}`));
    if (distinct.size > 1) {
      conflicts.push({ normalizedName, rows: group.map((r) => r.rowNumber) });
    }
  }
  if (conflicts.length > 0) {
    return { imported: 0, updated: 0, conflicts };
  }

  const { data: existing, error: existingError } = await supabase.from("suppliers").select("normalized_name");
  if (existingError) throw new Error(`importSuppliers: fallo leyendo suppliers existentes: ${existingError.message}`);
  const existingNames = new Set((existing ?? []).map((s) => s.normalized_name));

  const toUpsert = [...byName.entries()].map(([normalizedName, group]) => {
    const row = group[0];
    return {
      rut: row.rut,
      name: row.name,
      normalized_name: normalizedName,
      payment_method: row.paymentMethod,
      bank_code: row.bankCode,
      account_number: row.accountNumber,
      created_by: createdBy,
    };
  });

  const { error: upsertError } = await supabase.from("suppliers").upsert(toUpsert, { onConflict: "normalized_name" });
  if (upsertError) throw new Error(`importSuppliers: fallo importando proveedores: ${upsertError.message}`);

  const imported = toUpsert.filter((s) => !existingNames.has(s.normalized_name)).length;
  const updated = toUpsert.length - imported;

  return { imported, updated, conflicts: [] };
}
