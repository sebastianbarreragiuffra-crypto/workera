import "server-only";
import * as XLSX from "xlsx";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { areasVisibleToRole, type AreaCode, type CallerRole } from "../access/scope";
import type { AttendanceExportPeriod } from "./attendance-export-periods";

/**
 * Exportador real de asistencia (Fase 9) -- lee `attendance_status_records`
 * (backend, fuente de verdad, ver comentario de approve_medical_license)
 * para el rango de fechas y las áreas visibles del rol que descarga. NUNCA
 * recalcula un estado -- si un día no tiene fila `is_current` en
 * `attendance_status_records`, se representa como "?" (TARJETA NO MARCADA O
 * CON PROBLEMAS, el código ya definido para ese caso exacto en el catálogo
 * -- docs/EXCEL_WORKFLOW_ANALYSIS.md), nunca P/F inventado.
 *
 * Catálogo reutilizado tal cual (`attendance_statuses`, migración
 * 20260817144259): P, F, F-P, F-J, P-L, P-M, V, L, L-M, R, ?.
 */

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const MISSING_STATUS_CODE = "?";

interface EmployeeRow {
  id: string;
  display_name: string;
  employee_groups: { code: AreaCode } | { code: AreaCode }[] | null;
}

function areaOf(row: EmployeeRow): AreaCode | null {
  const rel = row.employee_groups;
  const group = Array.isArray(rel) ? rel[0] : rel;
  return group?.code ?? null;
}

/** Lunes..viernes entre startDate y endDate (inclusive) -- la app nunca opera fines de semana (sin horario asignado). */
function businessDaysBetween(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const dow = d.getUTCDay(); // 0=domingo..6=sábado
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export interface AttendanceExportRow {
  employeeId: string;
  workerName: string;
  area: AreaCode;
  workDate: string;
  statusCode: string;
}

export async function buildAttendanceExportRows(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  period: AttendanceExportPeriod
): Promise<AttendanceExportRow[]> {
  const allowedAreas = areasVisibleToRole(callerRole);

  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("id, display_name, employee_groups!employees_company_group_fkey!inner(code)")
    .eq("active", true)
    .in("employee_groups.code", allowedAreas)
    .order("display_name");
  if (employeesError) throw new Error(`buildAttendanceExportRows: fallo listando empleados: ${employeesError.message}`);

  const scoped = (employees ?? [])
    .map((row) => ({ id: row.id, displayName: row.display_name, area: areaOf(row as EmployeeRow) }))
    .filter((e): e is { id: string; displayName: string; area: AreaCode } => e.area !== null);

  const employeeIds = scoped.map((e) => e.id);
  const days = businessDaysBetween(period.startDate, period.endDate);

  const { data: statusRows, error: statusError } = await supabase
    .from("attendance_status_records")
    .select("employee_id, work_date, attendance_statuses(code)")
    .in("employee_id", employeeIds)
    .gte("work_date", period.startDate)
    .lte("work_date", period.endDate)
    .eq("is_current", true);
  if (statusError) throw new Error(`buildAttendanceExportRows: fallo leyendo attendance_status_records: ${statusError.message}`);

  const statusByEmployeeDate = new Map<string, string>();
  for (const row of (statusRows ?? []) as unknown as { employee_id: string; work_date: string; attendance_statuses: { code: string } | { code: string }[] | null }[]) {
    const rel = row.attendance_statuses;
    const code = (Array.isArray(rel) ? rel[0] : rel)?.code;
    if (code) statusByEmployeeDate.set(`${row.employee_id}:${row.work_date}`, code);
  }

  const rows: AttendanceExportRow[] = [];
  for (const employee of scoped) {
    for (const day of days) {
      rows.push({
        employeeId: employee.id,
        workerName: employee.displayName,
        area: employee.area,
        workDate: day,
        statusCode: statusByEmployeeDate.get(`${employee.id}:${day}`) ?? MISSING_STATUS_CODE,
      });
    }
  }
  return rows;
}

export function buildAttendanceExportWorkbook(rows: AttendanceExportRow[], period: AttendanceExportPeriod): Uint8Array {
  const header = ["Trabajador", "Área", "Fecha", "Estado"];
  const sheetRows: (string | number)[][] = [
    [`ASISTENCIA -- ${period.label}`],
    [],
    header,
    ...rows.map((r) => [r.workerName, AREA_LABEL[r.area], r.workDate, r.statusCode]),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Asistencia");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}
