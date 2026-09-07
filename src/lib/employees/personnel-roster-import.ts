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
 * `source='workera'` y tampoco reactiva una baja decidida por Workera o una
 * ficha provisional. Toda lectura y aplicación exige una empresa explícita.
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireCompanyId(companyId: string): string {
  const normalized = companyId.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error("El importador de personal requiere una empresa válida.");
  }
  return normalized;
}

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
    const distinct = new Set(group.map((r) => JSON.stringify([
      r.firstName,
      r.lastName,
      r.cargo,
      r.hireDate,
      r.birthDate,
    ])));
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
  existingSource: "workera" | "excel_roster" | "local_provisional" | "other" | null;
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
  updated_at: string;
}

interface ExistingBirthdayRow {
  employee_id: string;
  birth_month: number;
  birth_day: number;
}

interface PersonnelRosterContext {
  groupIdByCode: Map<EmployeeGroupCode, string>;
  employeesByRut: Map<string, ExistingEmployeeRow>;
  birthdayByEmployeeId: Map<string, ExistingBirthdayRow>;
  allEmployees: ExistingEmployeeRow[];
}

async function loadReconciliationContext(
  supabase: SupabaseClient<Database>,
  companyId: string,
): Promise<PersonnelRosterContext> {
  const [
    { data: groups, error: groupsError },
    { data: employees, error: employeesError },
    { data: birthdays, error: birthdaysError },
  ] = await Promise.all([
    supabase.from("employee_groups").select("id, code").eq("company_id", companyId),
    supabase
      .from("employees")
      .select("id, rut, active, source, display_name, first_name, last_name, employee_group_id, hire_date, updated_at")
      .eq("company_id", companyId),
    supabase
      .from("employee_birthdays")
      .select("employee_id, birth_month, birth_day, employees!inner(company_id)")
      .eq("employees.company_id", companyId),
  ]);
  if (groupsError) throw new Error(`loadReconciliationContext: fallo leyendo employee_groups: ${groupsError.message}`);
  if (employeesError) throw new Error(`loadReconciliationContext: fallo leyendo employees: ${employeesError.message}`);
  if (birthdaysError) throw new Error(`loadReconciliationContext: fallo leyendo employee_birthdays: ${birthdaysError.message}`);

  const groupIdByCode = new Map((groups ?? []).map((g) => [g.code as EmployeeGroupCode, g.id]));
  const employeesByRut = new Map((employees ?? []).filter((e) => e.rut).map((e) => [e.rut as string, e as ExistingEmployeeRow]));
  const birthdayByEmployeeId = new Map((birthdays ?? []).map((birthday) => [
    birthday.employee_id,
    birthday as ExistingBirthdayRow,
  ]));
  return {
    groupIdByCode,
    employeesByRut,
    birthdayByEmployeeId,
    allEmployees: (employees ?? []) as ExistingEmployeeRow[],
  };
}

function rowChanged(
  row: ParsedPersonnelRow,
  existing: ExistingEmployeeRow,
  existingBirthday: ExistingBirthdayRow | undefined,
  resolvedGroupId: string | null,
): boolean {
  if (existing.employee_group_id !== resolvedGroupId) return true;
  if ((existing.hire_date ?? null) !== (row.hireDate ?? null)) return true;
  if (existing.source === "excel_roster" && existing.display_name !== row.displayName) return true;
  // Celda vacía significa "sin nueva evidencia": conserva el cumpleaños ya
  // registrado. Cuando el archivo sí trae fecha, mes/día pasan a ser parte
  // del plan y deben poder corregirse aunque el resto de la ficha no cambie.
  if (row.birthDate) {
    const [, month, day] = row.birthDate.split("-").map(Number);
    if (!existingBirthday || existingBirthday.birth_month !== month || existingBirthday.birth_day !== day) return true;
  }
  return false;
}

function existingSourceForPreview(source: string | undefined): PersonnelRosterPreviewRow["existingSource"] {
  if (!source) return null;
  if (source === "workera" || source === "excel_roster" || source === "local_provisional") return source;
  return "other";
}

function isSupportedPersonnelImportSource(source: string): boolean {
  return source === "workera" || source === "excel_roster" || source === "local_provisional";
}

function computePersonnelRosterPreviewFromContext(
  parsed: ParsePersonnelRosterResult,
  context: PersonnelRosterContext,
): PersonnelRosterPreview {
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

  // Este archivo es una foto autoritativa para las filas `excel_roster`: una
  // ficha activa ausente del conjunto válido se propone para desactivación.
  // Por eso no es seguro aplicar sólo las filas bien formadas. Una fila con
  // RUT o identidad inválida podría corresponder justamente a una persona ya
  // existente y convertir un error de planilla en una baja falsa.
  if (parsed.issues.length > 0) {
    return {
      ok: false,
      blockingError: `Hay ${parsed.issues.length} fila(s) con campos obligatorios ausentes o RUT inválido. Corrige la planilla antes de continuar.`,
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

  if (parsed.valid.length === 0) {
    return {
      ok: false,
      blockingError: "La planilla no contiene ninguna fila válida de personal. No se aplicará un padrón vacío.",
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

  const unsupportedSourceCount = parsed.valid.reduce((count, row) => {
    const existing = context.employeesByRut.get(row.rut);
    return count + (existing && !isSupportedPersonnelImportSource(existing.source) ? 1 : 0);
  }, 0);
  if (unsupportedSourceCount > 0) {
    return {
      ok: false,
      blockingError: "Hay trabajadores cuya fuente no puede ser reconciliada por el importador Excel. Revisa el origen antes de continuar.",
      totalInFile: parsed.valid.length,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      reactivatedCount: 0,
      toDeactivateCount: 0,
      unassignedCount: 0,
      problemCount: problemCount + unsupportedSourceCount,
      rows: [],
      toDeactivate: [],
    };
  }

  const rows: PersonnelRosterPreviewRow[] = parsed.valid.map((row) => {
    const resolvedGroupId = row.groupCode ? (context.groupIdByCode.get(row.groupCode) ?? null) : null;
    const existing = context.employeesByRut.get(row.rut) ?? null;
    let status: PersonnelRowStatus;
    if (!existing) status = "NEW";
    else if (!existing.active && existing.source === "excel_roster") status = "REACTIVATED";
    else if (rowChanged(row, existing, context.birthdayByEmployeeId.get(existing.id), resolvedGroupId)) status = "UPDATED";
    else status = "UNCHANGED";
    return {
      rowNumber: row.rowNumber,
      rut: row.rut,
      displayName: row.displayName,
      groupCode: row.groupCode,
      status,
      existingSource: existingSourceForPreview(existing?.source),
    };
  });

  const confirmedRuts = new Set(parsed.valid.map((r) => r.rut));
  const toDeactivate = context.allEmployees
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

export async function computePersonnelRosterPreview(
  supabase: SupabaseClient<Database>,
  fileBytes: Uint8Array,
  companyId: string,
): Promise<PersonnelRosterPreview> {
  const normalizedCompanyId = requireCompanyId(companyId);
  const parsed = parsePersonnelRosterExcel(fileBytes);
  const context = await loadReconciliationContext(supabase, normalizedCompanyId);
  return computePersonnelRosterPreviewFromContext(parsed, context);
}

export interface ApplyPersonnelRosterImportResult {
  insertedCount: number;
  updatedCount: number;
  reactivatedCount: number;
  deactivatedCount: number;
}

/**
 * Re-parsea/re-calcula todo desde los bytes reales (nunca confía en los
 * conteos que muestre el cliente), construye el plan desde un único snapshot
 * de empleados y ejecuta la función atómica. Cada update/baja incluye la
 * versión previa leída; el RPC la revalida bajo lock y rechaza el plan si quedó
 * obsoleto. Precedencia
 * de fuentes: para un empleado `source='workera'` ya existente, NUNCA se
 * envían first_name/last_name/display_name en el update -- solo
 * grupo/fecha de ingreso, que Workera no provee (ver comentario en la
 * migración `20260826100000_employee_roster_bootstrap.sql`).
 * Un update sólo lleva `reactivate='true'` cuando la fila existente proviene
 * de `excel_roster`; para Workera/provisionales la ausencia del flag obliga al
 * RPC a conservar `active` tal como estaba.
 */
export async function applyPersonnelRosterImport(
  supabase: SupabaseClient<Database>,
  params: { fileBytes: Uint8Array; actorId: string; companyId: string },
): Promise<ApplyPersonnelRosterImportResult> {
  const normalizedCompanyId = requireCompanyId(params.companyId);
  const parsed = parsePersonnelRosterExcel(params.fileBytes);
  const context = await loadReconciliationContext(supabase, normalizedCompanyId);
  const preview = computePersonnelRosterPreviewFromContext(parsed, context);
  if (!preview.ok) {
    throw new Error(preview.blockingError ?? "El archivo no pasó la validación.");
  }

  const statusByRowNumber = new Map(preview.rows.map((r) => [r.rowNumber, r.status]));

  const insertRows: Record<string, string | boolean>[] = [];
  const updateRows: Record<string, string | boolean>[] = [];

  for (const row of parsed.valid) {
    const status = statusByRowNumber.get(row.rowNumber);
    if (!status) {
      throw new Error("El roster cambió mientras se preparaba el plan completo. Vuelve a revisar el archivo.");
    }

    const resolvedGroupId = row.groupCode ? (context.groupIdByCode.get(row.groupCode) ?? "") : "";
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
    const existing = context.employeesByRut.get(row.rut);
    if (!existing) {
      throw new Error("El roster cambió mientras se preparaba la actualización. Vuelve a revisar el archivo.");
    }
    const base: Record<string, string | boolean> = {
      id: existing.id,
      employee_group_id: resolvedGroupId,
      hire_date: row.hireDate ?? "",
      prior_rut: existing.rut ?? "",
      prior_source: existing.source,
      prior_active: existing.active,
      prior_updated_at: existing.updated_at,
    };
    if (existing.source === "excel_roster") {
      base.first_name = row.firstName;
      base.last_name = row.lastName;
      base.display_name = row.displayName;
    }
    if (status === "REACTIVATED" && existing.source === "excel_roster") {
      base.reactivate = "true";
    }
    if (birthMonth && birthDay) {
      const existingBirthday = context.birthdayByEmployeeId.get(existing.id);
      base.birth_month = String(Number(birthMonth));
      base.birth_day = String(Number(birthDay));
      base.prior_birth_month = existingBirthday ? String(existingBirthday.birth_month) : "";
      base.prior_birth_day = existingBirthday ? String(existingBirthday.birth_day) : "";
    }
    void birthYear;
    updateRows.push(base);
  }

  const deactivateRows = preview.toDeactivate.map(({ employeeId }) => {
    const existing = context.allEmployees.find((employee) => employee.id === employeeId);
    if (!existing) {
      throw new Error("El roster cambió mientras se preparaba la desactivación. Vuelve a revisar el archivo.");
    }
    return {
      id: existing.id,
      prior_rut: existing.rut ?? "",
      prior_source: existing.source,
      prior_active: existing.active,
      prior_updated_at: existing.updated_at,
    };
  });

  const rpcArguments = {
    p_company_id: normalizedCompanyId,
    p_confirmed_ruts: parsed.valid.map((row) => row.rut),
    p_insert_rows: insertRows,
    p_update_rows: updateRows,
    p_deactivate_ids: deactivateRows,
    p_actor_id: params.actorId,
  };
  const { data, error } = await supabase.rpc("apply_personnel_roster_import", rpcArguments);
  if (error) {
    throw new Error(`applyPersonnelRosterImport: fallo aplicando el roster (nada se guardó, el roster anterior sigue vigente): ${error.message}`);
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("applyPersonnelRosterImport: la base no confirmó el resultado de la reconciliación.");
  }
  const result = data as Record<string, unknown>;
  const readCount = (key: string): number => {
    const value = result[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("applyPersonnelRosterImport: la base devolvió un resultado inválido.");
    }
    return value;
  };

  return {
    insertedCount: readCount("inserted_count"),
    updatedCount: readCount("updated_count"),
    reactivatedCount: readCount("reactivated_count"),
    deactivatedCount: readCount("deactivated_count"),
  };
}
