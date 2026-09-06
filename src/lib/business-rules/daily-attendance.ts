import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveEffectiveSchedule } from "./schedule";

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
 * NUNCA genera nada para un trabajador EXEMPT_FROM_TIME_CONTROL. En un día
 * sin turno (DAY_OFF) solo genera registro si existen marcaciones reales:
 * así no inventa una falta, pero tampoco pierde trabajo extraordinario de un
 * sábado, domingo o feriado.
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
  /** Había eventos crudos, pero ninguno era una ENTRADA/SALIDA reconocida. */
  | "SKIPPED_NO_EVENTS"
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

type CurrentAttendanceRecord = Pick<
  Database["public"]["Tables"]["attendance_records"]["Row"],
  "id" | "source" | "source_hash" | "source_version" | "actual_clock_in" | "actual_clock_out"
>;

/**
 * Retira el grafo calculado de una jornada que dejó de existir en la fuente.
 *
 * Los candidatos no tienen columna `source`: por diseño siempre son cálculos
 * del motor. En cambio, el código diario sí mezcla fuentes, por eso solo se
 * cierra `source = 'system'`. La asistencia manual es una decisión humana y
 * nunca entra a esta función.
 *
 * Las actualizaciones son idempotentes y se hacen de hojas a raíz. Si alguna
 * falla, se lanza el error y el orquestador marca al trabajador como fallido;
 * nunca se sigue generando sobre un estado que no pudo reconciliarse. Cerrar
 * `attendance_records` al final evita dejar candidatos visibles apuntando a
 * una asistencia ya retirada si una llamada intermedia falla.
 */
async function reconcileStaleDerivedAttendance(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  current: CurrentAttendanceRecord | null
): Promise<void> {
  // Sin una asistencia vigente no existe una raíz activa que reconciliar.
  // Evita cuatro UPDATE vacíos por cada persona exenta en cada reejecución.
  if (!current) return;

  for (const table of ["late_arrival_records", "early_departure_records", "overtime_records"] as const) {
    const { error } = await supabase
      .from(table)
      .update({ is_current: false })
      .eq("employee_id", employeeId)
      .eq("work_date", workDate)
      .eq("is_current", true);

    if (error) {
      throw new Error(`deriveDailyAttendanceRecord: fallo reconciliando ${table}: ${error.message}`);
    }
  }

  const { error: statusError } = await supabase
    .from("attendance_status_records")
    .update({ is_current: false })
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("source", "system")
    .eq("is_current", true);

  if (statusError) {
    throw new Error(`deriveDailyAttendanceRecord: fallo reconciliando attendance_status_records: ${statusError.message}`);
  }

  if (current.source !== "workera") return;

  const { error: attendanceError } = await supabase
    .from("attendance_records")
    .update({ is_current: false })
    .eq("id", current.id)
    .eq("source", "workera")
    .eq("is_current", true);

  if (attendanceError) {
    throw new Error(`deriveDailyAttendanceRecord: fallo reconciliando attendance_records: ${attendanceError.message}`);
  }
}

export async function deriveDailyAttendanceRecord(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workDate: string,
  /** El día es feriado legal. Lo resuelve el orquestador con una sola consulta a `holidays` para toda la fecha, en vez de 44 veces desde acá. */
  isHoliday = false
): Promise<DeriveDailyAttendanceResult> {
  const schedule = await resolveEffectiveSchedule(supabase, employeeId, workDate);

  const { data: current, error: currentError } = await supabase
    .from("attendance_records")
    .select("id, source, source_hash, source_version, actual_clock_in, actual_clock_out")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .maybeSingle();

  if (currentError) {
    throw new Error(`deriveDailyAttendanceRecord: fallo consultando attendance_records vigente: ${currentError.message}`);
  }

  if (schedule.kind === "EXEMPT") {
    await reconcileStaleDerivedAttendance(supabase, employeeId, workDate, current);
    return { status: "EXEMPT", attendanceRecordId: null, clockIn: null, clockOut: null };
  }
  if (schedule.kind === "NO_SCHEDULE_ASSIGNED") {
    await reconcileStaleDerivedAttendance(supabase, employeeId, workDate, current);
    return { status: "NO_SCHEDULE_ASSIGNED", attendanceRecordId: null, clockIn: null, clockOut: null };
  }

  const { data: events, error: eventsError } = await supabase
    .from("workera_attendance_events")
    .select("attendance_type_code, attendance_timestamp_interpreted, attendance_timestamp_raw, external_fingerprint")
    .eq("employee_id", employeeId)
    .eq("work_date", workDate)
    .eq("is_current", true)
    .order("attendance_timestamp_raw", { ascending: true });

  if (eventsError) {
    throw new Error(`deriveDailyAttendanceRecord: fallo consultando workera_attendance_events: ${eventsError.message}`);
  }

  const allEvents = events ?? [];

  const entradaEvents = allEvents.filter((e) => ENTRADA_TYPE_CODES.has(e.attendance_type_code));
  const salidaEvents = allEvents.filter((e) => SALIDA_TYPE_CODES.has(e.attendance_type_code));
  const hasRecognizedPunch = entradaEvents.length > 0 || salidaEvents.length > 0;

  // Una fila manual es la verdad explícita de una persona. No se sustituye ni
  // se invalida porque Workera deje de devolver eventos para el mismo día.
  if (current?.source === "manual") {
    return {
      status: "UNCHANGED",
      attendanceRecordId: current.id,
      clockIn: current.actual_clock_in,
      clockOut: current.actual_clock_out,
    };
  }

  // Un descanso sin marcaciones sigue siendo solo descanso. La versión
  // anterior retornaba antes de leer los eventos y, por eso, descartaba
  // también un sábado/domingo efectivamente trabajado.
  if (schedule.kind === "DAY_OFF" && !hasRecognizedPunch) {
    await reconcileStaleDerivedAttendance(supabase, employeeId, workDate, current);
    return {
      status: allEvents.length > 0 ? "SKIPPED_NO_EVENTS" : isHoliday ? "HOLIDAY" : "DAY_OFF",
      attendanceRecordId: null,
      clockIn: null,
      clockOut: null,
    };
  }

  // Feriado sin ninguna marcación: es un día de descanso pagado, no una
  // ausencia. No se crea `attendance_record` (así el trigger de tarjeta no
  // marcada no dispara) ni se marca "?". Si el trabajador SÍ marcó, se sigue
  // de largo y se deriva normal -- las horas del feriado se pagan HH100.
  if (isHoliday && !hasRecognizedPunch) {
    await reconcileStaleDerivedAttendance(supabase, employeeId, workDate, current);
    return {
      status: allEvents.length > 0 ? "SKIPPED_NO_EVENTS" : "HOLIDAY",
      attendanceRecordId: null,
      clockIn: null,
      clockOut: null,
    };
  }

  // Primer ENTRADA del día, último SALIDA del día -- limitación documentada
  // (docs/BUSINESS_RULES_PHASE7.md): no distingue múltiples turnos ni
  // eventos de descanso todavía.
  const clockIn = entradaEvents[0]?.attendance_timestamp_interpreted ?? null;
  const clockOut = salidaEvents[salidaEvents.length - 1]?.attendance_timestamp_interpreted ?? null;

  const sourceHash = computeSourceHash(allEvents.map((e) => e.external_fingerprint ?? ""));

  if (current && current.source_hash === sourceHash) {
    return { status: "UNCHANGED", attendanceRecordId: current.id, clockIn, clockOut };
  }

  // Retira primero las hojas calculadas y después la raíz. Además de evitar
  // que un candidato visible apunte temporalmente a una asistencia histórica,
  // mantiene el mismo orden de locks que el guard de decisiones en la base.
  await reconcileStaleDerivedAttendance(supabase, employeeId, workDate, current);

  const { data: inserted, error: insertError } = await supabase
    .from("attendance_records")
    .insert({
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
