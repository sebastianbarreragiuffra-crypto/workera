import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { getDailyReview, type CallerRole, type DailyReviewCategory } from "../business-rules/daily-review";
import { areasVisibleToRole } from "../access/scope";
import { listMedicalLicenses } from "../decisions/medical-license";
import { resolveTargetDate } from "../sync/target-date";

/**
 * Resumen "¿está lista la asistencia?" para la tarjeta ASISTENCIA
 * ACTUALIZADA -- NO es un motor de revisión nuevo. Combina dos fuentes ya
 * existentes, sin recalcular nada:
 *   1. `getDailyReview` (Fase 7) -- las mismas 7 categorías que ya usa
 *      `/revision-diaria` y el Dashboard actual, para el día de corte D-1.
 *   2. `listMedicalLicenses({onlyPending:true})` -- el flujo de aprobación
 *      de licencias médicas (independiente, ya probado), que hoy NO estaba
 *      surfaceado en ningún tablero -- una licencia pendiente de aprobación
 *      RRHH legítimamente deja la asistencia sin cerrar hasta que se
 *      resuelva (ver comentario de `approve_medical_license`: solo
 *      aprobada genera "L").
 *
 * Corte D-1 (`resolveTargetDate`, ya usado por la reconciliación de sync) --
 * nunca "hoy", para no marcar pendiente solo porque el día actual sigue en
 * curso.
 */

export interface AttendanceBlocker {
  key: string;
  message: string;
  href: string;
}

export interface AttendanceReadiness {
  cutoffDate: string;
  ready: boolean;
  blockers: AttendanceBlocker[];
  totalBlockerCount: number;
}

function categoryBlockerMessage(category: DailyReviewCategory, displayName: string, isVacation: boolean): string {
  switch (category) {
    case "LATE":
      return `Atraso de ${displayName} sin justificar.`;
    case "EARLY_DEPARTURE":
      return `Salida anticipada de ${displayName} sin decisión.`;
    case "MISSING_PUNCH":
      return `Falta revisar el clock out de ${displayName}.`;
    case "ABSENCE":
      return isVacation ? `Falta aprobar vacaciones de ${displayName} por RRHH.` : `Ausencia de ${displayName} sin decisión.`;
    case "OVERTIME_CANDIDATE":
      return `Horas extra de ${displayName} pendientes de aprobar.`;
    case "LICENSE_DOCUMENT_REQUIRED":
      return `Falta subir el documento de licencia de ${displayName}.`;
    case "MEDICAL_DOCUMENT_REQUIRED":
      return `Falta el documento médico de ${displayName} (salida anticipada).`;
  }
}

/** Entre los empleados con categoría ABSENCE, cuáles son específicamente VACATION -- solo para el texto del mensaje, nunca cambia el conteo/estado real ya calculado por getDailyReview. */
async function findVacationEmployeeIds(supabase: SupabaseClient<Database>, employeeIds: string[], cutoffDate: string): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("absence_records")
    .select("employee_id, absence_types(code)")
    .in("employee_id", employeeIds)
    .eq("is_current", true)
    .lte("start_date", cutoffDate)
    .gte("end_date", cutoffDate);
  if (error) throw new Error(`findVacationEmployeeIds: ${error.message}`);
  const result = new Set<string>();
  for (const row of (data ?? []) as unknown as { employee_id: string; absence_types: { code: string } | { code: string }[] | null }[]) {
    const type = Array.isArray(row.absence_types) ? row.absence_types[0] : row.absence_types;
    if (type?.code === "VACATION") result.add(row.employee_id);
  }
  return result;
}

export async function getAttendanceReadiness(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  now: Date = new Date()
): Promise<AttendanceReadiness> {
  const cutoffDate = resolveTargetDate(now);
  const areas = areasVisibleToRole(callerRole);

  const [boards, pendingLicenses] = await Promise.all([
    Promise.all(areas.map((area) => getDailyReview(supabase, callerRole, area, cutoffDate))),
    listMedicalLicenses(supabase, { onlyPending: true }),
  ]);

  const absenceEmployeeIds = new Set<string>();
  for (const board of boards) {
    for (const entry of board.requiresReview) {
      if (entry.categories.includes("ABSENCE")) absenceEmployeeIds.add(entry.employeeId);
    }
  }
  const vacationEmployeeIds = await findVacationEmployeeIds(supabase, [...absenceEmployeeIds], cutoffDate);

  const blockers: AttendanceBlocker[] = [];
  for (const board of boards) {
    for (const entry of board.requiresReview) {
      for (const category of entry.categories) {
        blockers.push({
          key: `${board.groupCode}:${entry.employeeId}:${category}`,
          message: categoryBlockerMessage(category, entry.displayName, vacationEmployeeIds.has(entry.employeeId)),
          href: `/revision-diaria?fecha=${cutoffDate}&area=${board.groupCode}&empleado=${entry.employeeId}`,
        });
      }
    }
  }

  // Una licencia pendiente cuyo período todavía no llega al corte no bloquea el corte actual.
  for (const license of pendingLicenses) {
    if (license.proposedStartDate > cutoffDate) continue;
    blockers.push({
      key: `LICENSE:${license.approvalId}`,
      message: `Falta aprobar licencia de ${license.employeeName} por RRHH.`,
      href: "/licencias",
    });
  }

  return { cutoffDate, ready: blockers.length === 0, blockers, totalBlockerCount: blockers.length };
}
