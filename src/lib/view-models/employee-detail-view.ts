import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolveTimeControlPolicy, resolveEffectiveSchedule } from "../business-rules/schedule";
import { assertEmployeeAccessAllowed, type AreaCode, type CallerRole } from "../access/scope";

/**
 * Vista de detalle de un trabajador (Fase 8C, sección K). Complementa
 * `daily-review-view.ts` (que es SIEMPRE un día puntual) con una ventana de
 * historial reciente -- reutiliza `resolveTimeControlPolicy`/
 * `resolveEffectiveSchedule` (Fase 7) sin reimplementarlas, y aplica el mismo
 * scoping de área que el resto de Fase 8 (`assertEmployeeAccessAllowed`).
 * Solo lectura: ninguna decisión se toma desde esta pantalla.
 */

const RECENT_DAYS = 30;
const RECENT_LIMIT = 8;

export interface RecentLateArrival {
  workDate: string;
  detectedMinutes: number;
  justified: boolean | null;
}

export interface RecentOvertime {
  workDate: string;
  candidateMinutes: number;
  decisionStatus: string | null;
  approvedMinutes: number | null;
}

export interface RecentAbsence {
  startDate: string;
  endDate: string;
  absenceTypeName: string;
  decisionStatus: string | null;
}

export interface EmployeeDocumentEntry {
  id: string;
  documentType: string;
  originalFilename: string;
  uploadedAt: string;
}

export interface EmployeeDetailViewModel {
  employeeId: string;
  displayName: string;
  areaCode: AreaCode;
  active: boolean;
  timeControl: { kind: "NORMAL" } | { kind: "EXEMPT"; legalBasis: string };
  schedule:
    | { kind: "SCHEDULED"; scheduledStart: string; scheduledEnd: string }
    | { kind: "DAY_OFF" }
    | { kind: "EXEMPT" }
    | { kind: "NO_SCHEDULE_ASSIGNED" };
  recentLateArrivals: RecentLateArrival[];
  recentOvertime: RecentOvertime[];
  recentAbsences: RecentAbsence[];
  documents: EmployeeDocumentEntry[];
}

function subtractDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

export async function getEmployeeDetail(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  employeeId: string,
  today: string
): Promise<EmployeeDetailViewModel> {
  const areaCode = await assertEmployeeAccessAllowed(supabase, callerRole, employeeId);
  const since = subtractDays(today, RECENT_DAYS);

  const [employeeRes, policy, effectiveSchedule, lateRes, overtimeRes, absenceRes, documentsRes] = await Promise.all([
    supabase.from("employees").select("id, display_name, active").eq("id", employeeId).single(),
    resolveTimeControlPolicy(supabase, employeeId, today),
    resolveEffectiveSchedule(supabase, employeeId, today),
    supabase
      .from("late_arrival_records")
      .select("work_date, detected_minutes, late_arrival_decisions(justified, is_current)")
      .eq("employee_id", employeeId)
      .eq("is_current", true)
      .gte("work_date", since)
      .order("work_date", { ascending: false })
      .limit(RECENT_LIMIT),
    supabase
      .from("overtime_records")
      .select("work_date, candidate_minutes, overtime_decisions(decision_status, approved_minutes, is_current)")
      .eq("employee_id", employeeId)
      .eq("is_current", true)
      .gte("work_date", since)
      .order("work_date", { ascending: false })
      .limit(RECENT_LIMIT),
    supabase
      .from("absence_records")
      .select("start_date, end_date, absence_types(name), absence_decisions(decision_status, is_current)")
      .eq("employee_id", employeeId)
      .eq("is_current", true)
      .gte("start_date", since)
      .order("start_date", { ascending: false })
      .limit(RECENT_LIMIT),
    supabase
      .from("supporting_documents_metadata")
      .select("id, document_type, original_filename, uploaded_at")
      .eq("employee_id", employeeId)
      .order("uploaded_at", { ascending: false })
      .limit(RECENT_LIMIT),
  ]);

  if (employeeRes.error || !employeeRes.data) {
    throw new Error(`getEmployeeDetail: empleado no encontrado (${employeeId}).`);
  }
  for (const res of [lateRes, overtimeRes, absenceRes, documentsRes]) {
    if (res.error) throw new Error(`getEmployeeDetail: fallo leyendo historial reciente: ${res.error.message}`);
  }

  const timeControl: EmployeeDetailViewModel["timeControl"] =
    policy.code === "EXEMPT_FROM_TIME_CONTROL" ? { kind: "EXEMPT", legalBasis: policy.legalBasis } : { kind: "NORMAL" };

  let schedule: EmployeeDetailViewModel["schedule"];
  switch (effectiveSchedule.kind) {
    case "SCHEDULED":
      schedule = { kind: "SCHEDULED", scheduledStart: effectiveSchedule.scheduledStart, scheduledEnd: effectiveSchedule.scheduledEnd };
      break;
    case "DAY_OFF":
      schedule = { kind: "DAY_OFF" };
      break;
    case "EXEMPT":
      schedule = { kind: "EXEMPT" };
      break;
    default:
      schedule = { kind: "NO_SCHEDULE_ASSIGNED" };
  }

  function firstOf<T>(relation: T | T[] | null): T | null {
    return Array.isArray(relation) ? (relation[0] ?? null) : relation;
  }

  const recentLateArrivals: RecentLateArrival[] = (lateRes.data ?? []).map((row) => {
    const decision = firstOf(row.late_arrival_decisions);
    return { workDate: row.work_date, detectedMinutes: row.detected_minutes, justified: decision?.justified ?? null };
  });

  const recentOvertime: RecentOvertime[] = (overtimeRes.data ?? []).map((row) => {
    const decision = firstOf(row.overtime_decisions);
    return {
      workDate: row.work_date,
      candidateMinutes: row.candidate_minutes,
      decisionStatus: decision?.decision_status ?? null,
      approvedMinutes: decision?.approved_minutes ?? null,
    };
  });

  const recentAbsences: RecentAbsence[] = (absenceRes.data ?? []).map((row) => {
    const decision = firstOf(row.absence_decisions);
    const type = firstOf(row.absence_types);
    return {
      startDate: row.start_date,
      endDate: row.end_date,
      absenceTypeName: type?.name ?? "Ausencia",
      decisionStatus: decision?.decision_status ?? null,
    };
  });

  // La vista supporting_documents_metadata expone columnas nullable a nivel
  // de tipos (PostgREST no hereda NOT NULL de la tabla base vía una vista),
  // pero la tabla base las garantiza -- filtrar por id descarta cualquier
  // fila degenerada sin reinterpretar el contrato real.
  const documents: EmployeeDocumentEntry[] = (documentsRes.data ?? [])
    .filter((row): row is typeof row & { id: string; document_type: string; original_filename: string; uploaded_at: string } => row.id !== null)
    .map((row) => ({
      id: row.id,
      documentType: row.document_type,
      originalFilename: row.original_filename,
      uploadedAt: row.uploaded_at,
  }));

  return {
    employeeId: employeeRes.data.id,
    displayName: employeeRes.data.display_name,
    areaCode,
    active: employeeRes.data.active,
    timeControl,
    schedule,
    recentLateArrivals,
    recentOvertime,
    recentAbsences,
    documents,
  };
}
