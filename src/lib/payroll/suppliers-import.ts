import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { normalizeName, normalizeRut } from "../business-rules/name-matching";

/**
 * Importador del maestro de proveedores (Nómina de Pago). Formato real
 * confirmado (archivo "LISTADO DE PROVEEDORES", hoja "Beneficiarios"):
 * columnas Rut, Nombre Beneficiario, FP, BCO, N° Cuenta Cte. El encabezado
 * se BUSCA por nombre de columna (nunca se asume una posición fija de fila
 * u hoja) -- un usuario real puede subir el archivo equivocado (ej. la
 * plantilla de facturas mensuales, que tiene "Nombre Cliente" en vez de
 * "Nombre Beneficiario" y ninguna columna FP/BCO/Cuenta) o un archivo con
 * más de una hoja donde los datos no están en la primera; buscar por texto
 * en las primeras filas de CADA hoja detecta ambos casos y da un error
 * claro en vez de "0 filas válidas" sin explicación.
 *
 * El símbolo "°" a veces llega con problemas de codificación en archivos
 * exportados desde Excel antiguo (aparece como "N� Cuenta Cte.") -- la
 * columna de cuenta se detecta por `incluye "cuenta"`, nunca por igualdad
 * exacta con el símbolo, para no depender de esa codificación.
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

export type SupplierParseIssueReason = "MISSING_FIELD" | "HEADER_NOT_FOUND";

export interface SupplierParseIssue {
  rowNumber: number;
  reason: SupplierParseIssueReason;
}

export interface ParseSuppliersExcelResult {
  valid: ParsedSupplierRow[];
  issues: SupplierParseIssue[];
}

interface SupplierHeaderLocation {
  sheetName: string;
  rowIndex: number;
  rutCol: number;
  nameCol: number;
  fpCol: number;
  bcoCol: number;
  accountCol: number;
}

function findSupplierHeader(workbook: XLSX.WorkBook): SupplierHeaderLocation | null {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });
    const maxScan = Math.min(rows.length, 15);

    for (let i = 0; i < maxScan; i += 1) {
      const row = rows[i] ?? [];
      const normalized = row.map((cell) => (typeof cell === "string" ? cell.trim().toLowerCase() : ""));
      const rutCol = normalized.findIndex((c) => c === "rut");
      const nameCol = normalized.findIndex((c) => c.startsWith("nombre"));
      const fpCol = normalized.findIndex((c) => c === "fp");
      const bcoCol = normalized.findIndex((c) => c === "bco");
      const accountCol = normalized.findIndex((c) => c.includes("cuenta"));

      if (rutCol >= 0 && nameCol >= 0 && fpCol >= 0 && bcoCol >= 0 && accountCol >= 0) {
        return { sheetName, rowIndex: i, rutCol, nameCol, fpCol, bcoCol, accountCol };
      }
    }
  }
  return null;
}

export function parseSuppliersExcel(fileBytes: Uint8Array): ParseSuppliersExcelResult {
  const workbook = XLSX.read(fileBytes, { type: "array" });
  const header = findSupplierHeader(workbook);
  if (!header) {
    return { valid: [], issues: [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }] };
  }

  const sheet = workbook.Sheets[header.sheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });

  const valid: ParsedSupplierRow[] = [];
  const issues: SupplierParseIssue[] = [];

  for (let i = header.rowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const excelRowNumber = i + 1;
    if (!row || row.every((cell) => cell === null || cell === "")) continue; // fila en blanco, se ignora sin reportar

    const rut = String(row[header.rutCol] ?? "").trim();
    const name = String(row[header.nameCol] ?? "").trim();
    const paymentMethod = String(row[header.fpCol] ?? "").trim();
    const bankCode = String(row[header.bcoCol] ?? "").trim();
    const accountNumber = String(row[header.accountCol] ?? "").trim();

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

export interface AbsentSupplier {
  normalizedName: string;
  name: string;
}

export interface ImportSuppliersResult {
  imported: number;
  updated: number;
  /** Mismo nombre normalizado con datos bancarios distintos dentro del mismo archivo -- el archivo NO se importa hasta resolver esto manualmente. */
  conflicts: SupplierConflict[];
  /**
   * Proveedores actualmente ACTIVOS que no aparecen en este archivo. Este
   * importador nunca desactiva a nadie por su cuenta (a diferencia de un
   * proveedor sin match en la nómina mensual, acá no hay forma de saber si
   * la ausencia es intencional -- el proveedor dejó de operar con la
   * empresa -- o el archivo simplemente vino incompleto; auto-desactivar
   * datos bancarios reales sobre esa ambigüedad es más riesgoso que dejarlo
   * activo un ciclo de más). Se reporta para que RRHH decida, nunca se
   * resuelve en silencio.
   */
  absentActiveSuppliers: AbsentSupplier[];
}

/**
 * Importa el maestro completo (upsert por `normalized_name`) -- si dos filas
 * del MISMO archivo tienen el mismo nombre normalizado pero datos bancarios
 * distintos, se reporta como conflicto y NO se importa nada de ese archivo
 * (nunca se elige uno de los dos en silencio: es dinero real).
 */
export async function importSuppliers(
  supabase: SupabaseClient<Database>,
  companyId: string,
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
    return { imported: 0, updated: 0, conflicts, absentActiveSuppliers: [] };
  }

  const { data: existing, error: existingError } = await supabase
    .from("suppliers")
    .select("normalized_name, name, active")
    .eq("company_id", companyId);
  if (existingError) throw new Error(`importSuppliers: fallo leyendo suppliers existentes: ${existingError.message}`);
  const existingRows = existing ?? [];
  const existingNames = new Set(existingRows.map((s) => s.normalized_name));

  const toUpsert = [...byName.entries()].map(([normalizedName, group]) => {
    const row = group[0];
    return {
      company_id: companyId,
      rut: row.rut,
      name: row.name,
      normalized_name: normalizedName,
      normalized_rut: normalizeRut(row.rut),
      payment_method: row.paymentMethod,
      bank_code: row.bankCode,
      account_number: row.accountNumber,
      // Si un proveedor desactivado reaparece en un maestro posterior, esa
      // nueva evidencia explícita lo reactiva. Sin esto, la baja manual era
      // irreversible desde la UI aunque el proveedor volviera al archivo.
      active: true,
      created_by: createdBy,
    };
  });

  const { error: upsertError } = await supabase
    .from("suppliers")
    .upsert(toUpsert, { onConflict: "company_id,normalized_name" });
  if (upsertError) throw new Error(`importSuppliers: fallo importando proveedores: ${upsertError.message}`);

  const imported = toUpsert.filter((s) => !existingNames.has(s.normalized_name)).length;
  const updated = toUpsert.length - imported;

  const uploadedNames = new Set(toUpsert.map((s) => s.normalized_name));
  const absentActiveSuppliers = existingRows
    .filter((s) => s.active && !uploadedNames.has(s.normalized_name))
    .map((s) => ({ normalizedName: s.normalized_name, name: s.name }));

  return { imported, updated, conflicts: [], absentActiveSuppliers };
}

/**
 * Desactiva un proveedor puntual por su nombre normalizado -- el único
 * camino que existe hoy para dar de baja a alguien del maestro (nunca se
 * borra, mismo criterio que el resto del esquema). Nunca automático: la
 * ausencia de un proveedor en un archivo nuevo solo lo reporta
 * (`absentActiveSuppliers`); esta función es la acción explícita que una
 * persona dispara después de revisar esa advertencia.
 */
export async function deactivateSupplier(
  supabase: SupabaseClient<Database>,
  companyId: string,
  normalizedName: string
): Promise<void> {
  if (!normalizedName || normalizedName.length > 240) {
    throw new Error("deactivateSupplier: nombre normalizado inválido.");
  }
  const { error } = await supabase
    .from("suppliers")
    .update({ active: false })
    .eq("company_id", companyId)
    .eq("normalized_name", normalizedName);
  if (error) throw new Error(`deactivateSupplier: fallo desactivando el proveedor: ${error.message}`);
}
