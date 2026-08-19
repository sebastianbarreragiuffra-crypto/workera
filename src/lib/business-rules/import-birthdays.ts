import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Import controlado de cumpleaños (Fase 7, PASO 25-28, PASO 64). SOLO usa el
 * Excel de RRHH como fuente inicial -- nunca se commitea al repo, nunca se
 * copian nombres/RUT a tests/documentación/fixtures (PASO 26).
 *
 * ADVERTENCIA DE SEGURIDAD: la librería `xlsx` (SheetJS) tiene
 * vulnerabilidades conocidas sin parche disponible en el registro de npm
 * (prototype pollution, ReDoS -- GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9).
 * Aceptable AQUÍ porque este módulo solo procesa un archivo LOCAL controlado
 * por un administrador, ejecutado manualmente, nunca expuesto a input de
 * red no confiable ni importado por ninguna ruta HTTP/UI -- documentado en
 * docs/BUSINESS_RULES_PHASE7.md.
 *
 * Matching EXACTO (normalizado: trim + espacios colapsados + mayúsculas),
 * NUNCA parcial/fuzzy (PASO 27): una fila cuyo nombre no calza exactamente
 * con un único `employees` real queda UNRESOLVED_BIRTHDAY_EMPLOYEE y no se
 * importa.
 */

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

export interface ParsedBirthdayRow {
  /** Fila 1-indexada del Excel original, para reportar sin necesitar imprimir nombres. */
  rowNumber: number;
  firstName: string;
  lastName: string;
  birthMonth: number;
  birthDay: number;
}

export type BirthdayParseIssueReason = "MISSING_NAME" | "MISSING_DATE" | "INVALID_DATE" | "DUPLICATE_NAME";

export interface BirthdayParseIssue {
  rowNumber: number;
  reason: BirthdayParseIssueReason;
}

export interface ParseBirthdayExcelResult {
  valid: ParsedBirthdayRow[];
  issues: BirthdayParseIssue[];
}

/**
 * Estructura confirmada por inspección real (Fase 7): hoja única, título en
 * fila 1, fila de encabezado en la fila 4 (Nº/APELLIDOS/NOMBRES/R.U.T./
 * FECHA DE NACIMIENTO/MES), datos desde la fila 5. Columnas usadas: 1
 * (apellidos), 2 (nombres), 4 (fecha, serial de Excel). R.U.T. (columna 3)
 * y MES (columna 5) NO se leen -- minimización de datos (PASO 28: nunca se
 * almacena RUT ni año de nacimiento).
 */
export function parseBirthdayExcel(filePath: string): ParseBirthdayExcelResult {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });

  const valid: ParsedBirthdayRow[] = [];
  const issues: BirthdayParseIssue[] = [];
  const seenNormalizedNames = new Set<string>();

  for (let i = 4; i < rows.length; i += 1) {
    const row = rows[i];
    const excelRowNumber = i + 1;
    if (!row || row.every((cell) => cell === null || cell === "")) continue; // fila en blanco, se ignora sin reportar

    const lastNameRaw = row[1];
    const firstNameRaw = row[2];
    const dateRaw = row[4];

    const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";
    const firstName = typeof firstNameRaw === "string" ? firstNameRaw.trim() : "";

    if (!firstName || !lastName) {
      issues.push({ rowNumber: excelRowNumber, reason: "MISSING_NAME" });
      continue;
    }
    if (dateRaw === null || dateRaw === undefined || dateRaw === "") {
      issues.push({ rowNumber: excelRowNumber, reason: "MISSING_DATE" });
      continue;
    }
    if (typeof dateRaw !== "number") {
      issues.push({ rowNumber: excelRowNumber, reason: "INVALID_DATE" });
      continue;
    }
    const parsedDate = XLSX.SSF.parse_date_code(dateRaw);
    if (!parsedDate || !parsedDate.m || !parsedDate.d) {
      issues.push({ rowNumber: excelRowNumber, reason: "INVALID_DATE" });
      continue;
    }

    const key = `${normalizeName(firstName)}|${normalizeName(lastName)}`;
    if (seenNormalizedNames.has(key)) {
      issues.push({ rowNumber: excelRowNumber, reason: "DUPLICATE_NAME" });
      continue;
    }
    seenNormalizedNames.add(key);

    valid.push({ rowNumber: excelRowNumber, firstName, lastName, birthMonth: parsedDate.m, birthDay: parsedDate.d });
  }

  return { valid, issues };
}

export interface BirthdayImportPlanEntry {
  rowNumber: number;
  employeeId: string;
  birthMonth: number;
  birthDay: number;
}
export interface BirthdayImportUnresolvedEntry {
  rowNumber: number;
  matchCount: number;
}

export interface BirthdayImportPlan {
  toImport: BirthdayImportPlanEntry[];
  alreadyImported: { rowNumber: number; employeeId: string }[];
  unresolved: BirthdayImportUnresolvedEntry[];
}

/**
 * Empareja cada fila válida del Excel contra `employees` reales por nombre
 * EXACTO normalizado (nunca ILIKE parcial). Nunca imprime nombres -- el
 * llamador solo debe loguear conteos (PASO 26/64: "dry-run primero, reportar
 * SOLO conteos").
 */
export async function planBirthdayImport(
  supabase: SupabaseClient<Database>,
  rows: ParsedBirthdayRow[]
): Promise<BirthdayImportPlan> {
  const { data: employees, error } = await supabase.from("employees").select("id, first_name, last_name");
  if (error) throw new Error(`planBirthdayImport: fallo listando employees: ${error.message}`);

  const { data: existingBirthdays, error: birthdayError } = await supabase.from("employee_birthdays").select("employee_id");
  if (birthdayError) throw new Error(`planBirthdayImport: fallo listando employee_birthdays existentes: ${birthdayError.message}`);
  const alreadyImportedIds = new Set((existingBirthdays ?? []).map((b) => b.employee_id));

  const byNormalizedName = new Map<string, string[]>();
  for (const e of employees ?? []) {
    const key = `${normalizeName(e.first_name)}|${normalizeName(e.last_name)}`;
    if (!byNormalizedName.has(key)) byNormalizedName.set(key, []);
    byNormalizedName.get(key)!.push(e.id);
  }

  const toImport: BirthdayImportPlanEntry[] = [];
  const alreadyImported: BirthdayImportPlan["alreadyImported"] = [];
  const unresolved: BirthdayImportUnresolvedEntry[] = [];

  for (const row of rows) {
    const key = `${normalizeName(row.firstName)}|${normalizeName(row.lastName)}`;
    const matches = byNormalizedName.get(key) ?? [];
    if (matches.length !== 1) {
      unresolved.push({ rowNumber: row.rowNumber, matchCount: matches.length });
      continue;
    }
    const employeeId = matches[0];
    if (alreadyImportedIds.has(employeeId)) {
      alreadyImported.push({ rowNumber: row.rowNumber, employeeId });
      continue;
    }
    toImport.push({ rowNumber: row.rowNumber, employeeId, birthMonth: row.birthMonth, birthDay: row.birthDay });
  }

  return { toImport, alreadyImported, unresolved };
}

export interface ExecuteBirthdayImportResult {
  imported: number;
}

/** Escritura real -- SOLO llamar tras revisar un `planBirthdayImport` sin ambigüedad inaceptable. */
export async function executeBirthdayImport(
  supabase: SupabaseClient<Database>,
  plan: BirthdayImportPlan,
  createdBy: string | null
): Promise<ExecuteBirthdayImportResult> {
  if (plan.toImport.length === 0) return { imported: 0 };

  const { error } = await supabase.from("employee_birthdays").insert(
    plan.toImport.map((entry) => ({
      employee_id: entry.employeeId,
      birth_month: entry.birthMonth,
      birth_day: entry.birthDay,
      created_by: createdBy,
    }))
  );
  if (error) throw new Error(`executeBirthdayImport: fallo insertando employee_birthdays: ${error.message}`);

  return { imported: plan.toImport.length };
}
