import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";
import { WORKERA_COMPANY_ID } from "../tenant/company-scope";

/**
 * Deriva `attendance_records` (Fase 2A, resumen diario) a partir de
 * `workera_attendance_events` (Fase 6A/6B, eventos crudos individuales) --
 * el paso que faltaba desde Fase 6A/6B (confirmado por auditoría: nada lo
 * poblaba desde datos reales). Reutiliza `attendance_records` EXACTAMENTE
 * como ya existe (versionado, is_current, source_hash) en vez de crear una
 * tabla nueva -- así todo el motor de atrasos/overtime/salida anticipada ya
 * construido sobre `attendance_records` (Fase 2A/3/Gate D) funciona sin
 * modificarse.
 *
 * NUNCA modifica `workera_attendance_events` -- solo lee filas `is_current`.
 * NUNCA genera nada para un trabajador EXEMPT_FROM_TIME_CONTROL, ni para un
 * día sin turno (DAY_OFF) -- evita marcar "falta" en un día que nunca debía
 * tener marcación.
 *
 * Reutiliza el trigger YA EXISTENTE `attendance_records_flag_missing_punch`
 * (Gate D) para la alerta de tarjeta no marcada -- este servicio no
 * duplica esa lógica, solo hace el INSERT correcto (con NULL cuando
 * corresponda) para que ese trigger se dispare igual que si el dato viniera
 * de cualquier otra fuente.
 */

const ENTRADA_TYPE_CODES = new Set([0, 3]); // ENTRADA, ENTRADA extraordinaria (Fase 5C)
const SALIDA_TYPE_CODES = new Set([1, 2]); // SALIDA, SALIDA extraordinaria (Fase 5C)

export type DeriveDailyAttendanceStatus =
  | "DERIVED"
  | "UNCHANGED"
  | "EXEMPT"
  | "DAY_OFF"
  | "NO_SCHEDULE_ASSIGNED"
  /** Feriado legal SIN marcaciones: no se crea registro ni bandera de tarjeta no marcada. Si el trabajador SÍ marcó (trabajó el feriado), se deriva normal y las horas quedan HH100 vía `classify_overtime_type_id`. */
  | "HOLIDAY";

export interface DeriveDailyAttendanceResult {
  status: DeriveDailyAttendanceStatus;
  attendanceRecordId: string | null;
  clockIn: string | null;
  clockOut: string | null;
}

function computeSourceHash(fingerprints: string[]): string {
  const sorted = [...fingerprints].sort();
  return createHash("sha256").update(sorted.length > 0 ? sorted.join("|") : "NO_EVENTS").digest("hex");
}

export async function deriveDailyAttendanceRecord(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  /** El día es feriado legal. Lo resuelve el orquestador con una sola consulta a `holidays` para toda la fecha, en vez de 44 veces desde acá. */
  isHoliday = false,
  companyId?: string
): Promise<DeriveDailyAttendanceResult> {
  const tenantCompanyId = companyId ?? WORKERA_COMPANY_ID;
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  if (schedule.kind === "EXEMPT") {
    return { status: "EXEMPT", attendanceRecordId: null, clockIn: null, clockOut: null };
  }
  if (schedule.kind === "DAY_OFF") {
    return { status: "DAY_OFF", attendanceRecordId: null, clockIn: null, clockOut: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    return { status: "NO_SCHEDULE_ASSIGNED", attendanceRecordId: null, clockIn: null, clockOut: null };
  }

  const { data: events, error: eventsError } = await supabase
    .from("workera_attendance_events")
    .select("attendance_type_code, attendance_timestamp_interpreted, attendance_timestamp_raw, external_fingerprint")
    .eq("company_id", tenantCompanyId)
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .order("attendance_timestamp_raw", { ascending: true });

  if (eventsError) {
    throw new Error(`deriveDailyAttendanceRecord: fallo consultando workera_attendance_events: ${eventsError.message}`);
  }

  const allEvents = events ?? [];

  // Feriado sin ninguna marcación: es un día de descanso pagado, no una
  // ausencia. No se crea `attendance_record` (así el trigger de tarjeta no
  // marcada no dispara) ni se marca "?". Si el trabajador SÍ marcó, se sigue
  // de largo y se deriva normal -- las horas del feriado se pagan HH100.
  if (isHoliday && allEvents.length === 0) {
    return { status: "HOLIDAY", attendanceRecordId: null, clockIn: null, clockOut: null };
  }

  const entradaEvents = allEvents.filter((e) => ENTRADA_TYPE_CODES.has(e.attendance_type_code));
  const salidaEvents = allEvents.filter((e) => SALIDA_TYPE_CODES.has(e.attendance_type_code));

  // Primer ENTRADA del día, último SALIDA del día -- limitación documentada
  // (docs/BUSINESS_RULES_PHASE7.md): no distingue múltiples turnos ni
  // eventos de descanso todavía.
  const clockIn = entradaEvents[0]?.attendance_timestamp_interpreted ?? null;
  const clockOut = salidaEvents[salidaEvents.length - 1]?.attendance_timestamp_interpreted ?? null;

  const sourceHash = computeSourceHash(allEvents.map((e) => e.external_fingerprint ?? ""));

  const { data: current, error: currentError } = await supabase
    .from("attendance_records")
    .select("id, source_hash, source_version")
    .eq("company_id", tenantCompanyId)
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (currentError) {
    throw new Error(`deriveDailyAttendanceRecord: fallo consultando attendance_records vigente: ${currentError.message}`);
  }

  if (current && current.source_hash === sourceHash) {
    return { status: "UNCHANGED", attendanceRecordId: current.id, clockIn, clockOut };
  }

  if (current) {
    const { error: updateError } = await supabase
      .from("attendance_records")
      .update({ is_current: false })
      .eq("company_id", tenantCompanyId)
      .eq("id", current.id);
    if (updateError) {
      throw new Error(`deriveDailyAttendanceRecord: fallo marcando versión anterior no vigente: ${updateError.message}`);
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("attendance_records")
    .insert({
      company_id: tenantCompanyId,
      employee_id: employeeId,
      work_date: workDate,
      actual_clock_in: clockIn,
      actual_clock_out: clockOut,
      source: "workera",
      source_hash: sourceHash,
      source_version: (current?.source_version ?? 0) + 1,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`deriveDailyAttendanceRecord: fallo insertando attendance_records: ${insertError?.message ?? "sin fila devuelta"}`);
  }

  return { status: "DERIVED", attendanceRecordId: inserted.id, clockIn, clockOut };
}
