import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { mapCargoToGroup, type EmployeeGroupCode } from "./cargo-group-mapping";

/**
 * Importador de la planilla administrativa de personal ("LISTA DEL
 * PERSONAL", formato real confirmado: N° / FECHA DE INGRESO / APELLIDOS /
 * NOMBRES / R.U.T. / CARGO / FECHA DE NACIMIENTO). Bootstrap/roster
 * administrativo -- fuente de MENOR confianza de identidad que Workera
 * (ver `employee-roster-reconciliation.ts`): nunca sobrescribe el nombre de
 * un empleado ya confirmado por Workera, nunca desactiva a un empleado
 * `source='workera'`.
 *
 * Identidad: RUT normalizado (formato `NNNNNNNN-D`, el mismo que ya exige
 * el CHECK constraint de `employees.rut` desde antes de esta fase). Nunca
 * fuzzy-match por nombre.
 */

const HEADER_TOKENS = {
  numero: "n",
  fechaIngreso: "fecha de ingreso",
  apellidos: "apellidos",
  nombres: "nombres",
  rut: "r u t",
  cargo: "cargo",
  fechaNacimiento: "fecha de nacimiento",
};

function normalizeHeaderCell(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export interface PersonnelRosterHeaderLocation {
  sheetName: string;
  rowIndex: number;
  fechaIngresoCol: number;
  apellidosCol: number;
  nombresCol: number;
  rutCol: number;
  cargoCol: number;
  fechaNacimientoCol: number;
}

function findPersonnelRosterHeader(workbook: XLSX.WorkBook): PersonnelRosterHeaderLocation | null {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: null });
    const maxScan = Math.min(rows.length, 15);
    for (let i = 0; i < maxScan; i += 1) {
      const row = rows[i] ?? [];
      const normalized = row.map((cell) => normalizeHeaderCell(cell));
      const apellidosCol = normalized.findIndex((c) => c === HEADER_TOKENS.apellidos);
      const nombresCol = normalized.findIndex((c) => c === HEADER_TOKENS.nombres);
      const rutCol = normalized.findIndex((c) => c === HEADER_TOKENS.rut || c === "rut");
      const cargoCol = normalized.findIndex((c) => c === HEADER_TOKENS.cargo);
      const fechaIngresoCol = normalized.findIndex((c) => c === HEADER_TOKENS.fechaIngreso);
      const fechaNacimientoCol = normalized.findIndex((c) => c === HEADER_TOKENS.fechaNacimiento);
      if (apellidosCol >= 0 && nombresCol >= 0 && rutCol >= 0) {
        return { sheetName, rowIndex: i, fechaIngresoCol, apellidosCol, nombresCol, rutCol, cargoCol, fechaNacimientoCol };
      }
    }
  }
  return null;
}

/** `NNNNNNNN-D` -- mismo formato que exige `employees.rut` (CHECK constraint, ya existente). null si no se puede normalizar con confianza. */
export function normalizeEmployeeRut(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[^0-9K-]/g, "").replace(/-+/g, "-");
  const match = cleaned.match(/^(\d{7,8})-?([0-9K])$/) ?? cleaned.replace(/-/g, "").match(/^(\d{7,8})([0-9K])$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}`;
}

function excelDateToISO(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

export interface ParsedPersonnelRow {
  rowNumber: number;
  rut: string;
  firstName: string;
  lastName: string;
  displayName: string;
  cargo: string;
  groupCode: EmployeeGroupCode | null;
  hireDate: string | null;
  birthDate: string | null;
}

export type PersonnelRowIssueReason = "MISSING_FIELD" | "INVALID_RUT" | "HEADER_NOT_FOUND";

export interface PersonnelRowIssue {
  rowNumber: number;
  reason: PersonnelRowIssueReason;
}

export interface ParsePersonnelRosterResult {
  valid: ParsedPersonnelRow[];
  issues: PersonnelRowIssue[];
  duplicateRutConflicts: { rut: string; rows: number[] }[];
}

export function parsePersonnelRosterExcel(fileBytes: Uint8Array): ParsePersonnelRosterResult {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(fileBytes, { type: "array", cellDates: true });
  } catch {
    return { valid: [], issues: [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }], duplicateRutConflicts: [] };
  }

  const header = findPersonnelRosterHeader(workbook);
  if (!header) {
    return { valid: [], issues: [{ rowNumber: 0, reason: "HEADER_NOT_FOUND" }], duplicateRutConflicts: [] };
  }

  const sheet = workbook.Sheets[header.sheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | Date | null)[]>(sheet, { header: 1, defval: null });

  const issues: PersonnelRowIssue[] = [];
  const byRut = new Map<string, ParsedPersonnelRow[]>();

  for (let i = header.rowIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    const excelRowNumber = i + 1;
    if (!row || row.every((cell) => cell === null || cell === "")) continue;

    const rutRaw = String(row[header.rutCol] ?? "").trim();
    const apellidos = String(row[header.apellidosCol] ?? "").trim();
    const nombres = String(row[header.nombresCol] ?? "").trim();
    const cargo = header.cargoCol >= 0 ? String(row[header.cargoCol] ?? "").trim() : "";

    if (!rutRaw || !apellidos || !nombres) {
      issues.push({ rowNumber: excelRowNumber, reason: "MISSING_FIELD" });
      continue;
    }

    const rut = normalizeEmployeeRut(rutRaw);
    if (!rut) {
      issues.push({ rowNumber: excelRowNumber, reason: "INVALID_RUT" });
      continue;
    }

    const hireDate = header.fechaIngresoCol >= 0 ? excelDateToISO(row[header.fechaIngresoCol]) : null;
    const birthDate = header.fechaNacimientoCol >= 0 ? excelDateToISO(row[header.fechaNacimientoCol]) : null;

    const parsed: ParsedPersonnelRow = {
      rowNumber: excelRowNumber,
      rut,
      firstName: nombres,
      lastName: apellidos,
      displayName: `${nombres} ${apellidos}`.trim(),
      cargo,
      groupCode: cargo ? mapCargoToGroup(cargo) : null,
      hireDate,
      birthDate,
    };

    if (!byRut.has(rut)) byRut.set(rut, []);
    byRut.get(rut)!.push(parsed);
  }

  const duplicateRutConflicts: { rut: string; rows: number[] }[] = [];
  const valid: ParsedPersonnelRow[] = [];
  for (const [rut, group] of byRut) {
    if (group.length === 1) {
      valid.push(group[0]);
      continue;
    }
    const distinct = new Set(group.map((r) => `${r.firstName}|${r.lastName}|${r.cargo}`));
    if (distinct.size > 1) {
      duplicateRutConflicts.push({ rut, rows: group.map((r) => r.rowNumber) });
    } else {
      valid.push(group[0]);
    }
  }

  return { valid, issues, duplicateRutConflicts };
}

// ---------------------------------------------------------------------------
// Preview + aplicación

export type PersonnelRowStatus = "NEW" | "UPDATED" | "UNCHANGED" | "REACTIVATED";

export interface PersonnelRosterPreviewRow {
  rowNumber: number;
  rut: string;
  displayName: string;
  groupCode: EmployeeGroupCode | null;
  status: PersonnelRowStatus;
  existingSource: "workera" | "excel_roster" | null;
}

export interface PersonnelRosterPreview {
  ok: boolean;
  blockingError: string | null;
  totalInFile: number;
  newCount: number;
  updatedCount: number;
  unchangedCount: number;
  reactivatedCount: number;
  toDeactivateCount: number;
  unassignedCount: number;
  problemCount: number;
  rows: PersonnelRosterPreviewRow[];
  toDeactivate: { employeeId: string; displayName: string }[];
}

interface ExistingEmployeeRow {
  id: string;
  rut: string | null;
  active: boolean;
  source: string;
  display_name: string;
  first_name: string;
  last_name: string;
  employee_group_id: string | null;
  hire_date: string | null;
}

async function loadReconciliationContext(supabase: SupabaseClient<Database>) {
  const [{ data: groups, error: groupsError }, { data: employees, error: employeesError }] = await Promise.all([
    supabase.from("employee_groups").select("id, code"),
    supabase.from("employees").select("id, rut, active, source, display_name, first_name, last_name, employee_group_id, hire_date"),
  ]);
  if (groupsError) throw new Error(`loadReconciliationContext: fallo leyendo employee_groups: ${groupsError.message}`);
  if (employeesError) throw new Error(`loadReconciliationContext: fallo leyendo employees: ${employeesError.message}`);

  const groupIdByCode = new Map((groups ?? []).map((g) => [g.code as EmployeeGroupCode, g.id]));
  const employeesByRut = new Map((employees ?? []).filter((e) => e.rut).map((e) => [e.rut as string, e as ExistingEmployeeRow]));
  return { groupIdByCode, employeesByRut, allEmployees: (employees ?? []) as ExistingEmployeeRow[] };
}

function rowChanged(row: ParsedPersonnelRow, existing: ExistingEmployeeRow, resolvedGroupId: string | null): boolean {
  if (existing.employee_group_id !== resolvedGroupId) return true;
  if ((existing.hire_date ?? null) !== (row.hireDate ?? null)) return true;
  if (existing.source === "excel_roster" && existing.display_name !== row.displayName) return true;
  return false;
}

export async function computePersonnelRosterPreview(supabase: SupabaseClient<Database>, fileBytes: Uint8Array): Promise<PersonnelRosterPreview> {
  const parsed = parsePersonnelRosterExcel(fileBytes);
  const problemCount = parsed.issues.length + parsed.duplicateRutConflicts.reduce((sum, c) => sum + c.rows.length, 0);

  if (parsed.issues.some((i) => i.reason === "HEADER_NOT_FOUND")) {
    return {
      ok: false,
      blockingError: "No pudimos identificar la estructura de la planilla de personal (columnas Apellidos / Nombres / R.U.T. no encontradas).",
      totalInFile: 0,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      reactivatedCount: 0,
      toDeactivateCount: 0,
      unassignedCount: 0,
      problemCount,
      rows: [],
      toDeactivate: [],
    };
  }

  if (parsed.duplicateRutConflicts.length > 0) {
    const detail = parsed.duplicateRutConflicts.map((c) => `RUT ${c.rut} (filas ${c.rows.join(", ")})`).join("; ");
    return {
      ok: false,
      blockingError: `Hay RUT duplicados con datos distintos dentro del archivo: ${detail}. Corrige el archivo antes de continuar.`,
      totalInFile: parsed.valid.length,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      reactivatedCount: 0,
      toDeactivateCount: 0,
      unassignedCount: 0,
      problemCount,
      rows: [],
      toDeactivate: [],
    };
  }

  const { groupIdByCode, employeesByRut, allEmployees } = await loadReconciliationContext(supabase);

  const rows: PersonnelRosterPreviewRow[] = parsed.valid.map((row) => {
    const resolvedGroupId = row.groupCode ? (groupIdByCode.get(row.groupCode) ?? null) : null;
    const existing = employeesByRut.get(row.rut) ?? null;
    let status: PersonnelRowStatus;
    if (!existing) status = "NEW";
    else if (!existing.active) status = "REACTIVATED";
    else if (rowChanged(row, existing, resolvedGroupId)) status = "UPDATED";
    else status = "UNCHANGED";
    return { rowNumber: row.rowNumber, rut: row.rut, displayName: row.displayName, groupCode: row.groupCode, status, existingSource: (existing?.source as "workera" | "excel_roster") ?? null };
  });

  const confirmedRuts = new Set(parsed.valid.map((r) => r.rut));
  const toDeactivate = allEmployees
    .filter((e) => e.source === "excel_roster" && e.active && e.rut && !confirmedRuts.has(e.rut))
    .map((e) => ({ employeeId: e.id, displayName: e.display_name }));

  return {
    ok: true,
    blockingError: null,
    totalInFile: parsed.valid.length,
    newCount: rows.filter((r) => r.status === "NEW").length,
    updatedCount: rows.filter((r) => r.status === "UPDATED").length,
    unchangedCount: rows.filter((r) => r.status === "UNCHANGED").length,
    reactivatedCount: rows.filter((r) => r.status === "REACTIVATED").length,
    toDeactivateCount: toDeactivate.length,
    unassignedCount: rows.filter((r) => r.groupCode === null).length,
    problemCount,
    rows,
    toDeactivate,
  };
}

export interface ApplyPersonnelRosterImportResult {
  insertedCount: number;
  updatedCount: number;
  reactivatedCount: number;
  deactivatedCount: number;
}

/**
 * Re-parsea/re-calcula todo desde los bytes reales (nunca confía en los
 * conteos que muestre el cliente) y ejecuta la función atómica. Precedencia
 * de fuentes: para un empleado `source='workera'` ya existente, NUNCA se
 * envían first_name/last_name/display_name en el update -- solo
 * grupo/fecha de ingreso, que Workera no provee (ver comentario en la
 * migración `20260826100000_employee_roster_bootstrap.sql`).
 */
export async function applyPersonnelRosterImport(
  supabase: SupabaseClient<Database>,
  params: { fileBytes: Uint8Array; actorId: string }
): Promise<ApplyPersonnelRosterImportResult> {
  const preview = await computePersonnelRosterPreview(supabase, params.fileBytes);
  if (!preview.ok) {
    throw new Error(preview.blockingError ?? "El archivo no pasó la validación.");
  }

  const parsed = parsePersonnelRosterExcel(params.fileBytes);
  const { groupIdByCode, employeesByRut } = await loadReconciliationContext(supabase);
  const statusByRowNumber = new Map(preview.rows.map((r) => [r.rowNumber, r.status]));

  const insertRows: Record<string, string> [] = [];
  const updateRows: Record<string, string>[] = [];

  for (const row of parsed.valid) {
    const status = statusByRowNumber.get(row.rowNumber);
    if (status === "UNCHANGED") continue;

    const resolvedGroupId = row.groupCode ? (groupIdByCode.get(row.groupCode) ?? "") : "";
    const [birthYear, birthMonth, birthDay] = row.birthDate ? row.birthDate.split("-") : [null, null, null];

    if (status === "NEW") {
      insertRows.push({
        rut: row.rut,
        first_name: row.firstName,
        last_name: row.lastName,
        display_name: row.displayName,
        employee_group_id: resolvedGroupId,
        hire_date: row.hireDate ?? "",
        ...(birthMonth && birthDay ? { birth_month: String(Number(birthMonth)), birth_day: String(Number(birthDay)) } : {}),
      });
      continue;
    }

    // UPDATED o REACTIVATED
    const existing = employeesByRut.get(row.rut);
    if (!existing) continue;
    const base: Record<string, string> = {
      id: existing.id,
      employee_group_id: resolvedGroupId,
      hire_date: row.hireDate ?? "",
    };
    if (existing.source === "excel_roster") {
      base.first_name = row.firstName;
      base.last_name = row.lastName;
      base.display_name = row.displayName;
    }
    if (birthMonth && birthDay) {
      base.birth_month = String(Number(birthMonth));
      base.birth_day = String(Number(birthDay));
    }
    void birthYear;
    updateRows.push(base);
  }

  const { error } = await supabase.rpc("apply_personnel_roster_import", {
    p_insert_rows: insertRows,
    p_update_rows: updateRows,
    p_deactivate_ids: preview.toDeactivate.map((d) => d.employeeId),
    p_actor_id: params.actorId,
  });
  if (error) {
    throw new Error(`applyPersonnelRosterImport: fallo aplicando el roster (nada se guardó, el roster anterior sigue vigente): ${error.message}`);
  }

  return {
    insertedCount: preview.newCount,
    updatedCount: preview.updatedCount,
    reactivatedCount: preview.reactivatedCount,
    deactivatedCount: preview.toDeactivateCount,
  };
}
