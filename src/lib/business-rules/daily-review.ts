import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Work queue diaria por supervisor (Fase 7, PASO 12/45/46/47). Reune, para
 * un área y una fecha, qué trabajadores REQUIRE REVISIÓN vs. cuáles no
 * tienen novedades -- backend server-side, sin UI (Fase 8).
 *
 * Scoping de área aplicado en ESTE servicio, no solo confiado a RLS (PASO
 * 11: "no solo filtro visual") -- un SUPERVISOR_PRODUCTION nunca puede
 * pedir el área INSTALLATION exitosamente, incluso aunque la RLS de las
 * tablas subyacentes sea de lectura amplia (mismo criterio ya establecido
 * desde Fase 3 para overtime_records/late_arrival_records).
 */

export class DailyReviewAuthorizationError extends Error {}

export type DailyReviewCategory =
  | "LATE"
  | "EARLY_DEPARTURE"
  | "MISSING_PUNCH"
  | "ABSENCE"
  | "OVERTIME_CANDIDATE"
  | "LICENSE_DOCUMENT_REQUIRED"
  | "MEDICAL_DOCUMENT_REQUIRED";

export interface DailyReviewEmployeeEntry {
  employeeId: string;
  displayName: string;
  categories: DailyReviewCategory[];
}

export interface DailyReviewResult {
  groupCode: "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION";
  date: string;
  requiresReview: DailyReviewEmployeeEntry[];
  noIssues: DailyReviewEmployeeEntry[];
}

export type CallerRole = "SUPER_ADMIN" | "ADMIN_RRHH" | "SUPERVISOR_PRODUCTION" | "SUPERVISOR_INSTALLATION";

function assertGroupAccessAllowed(callerRole: CallerRole, groupCode: string): void {
  if (callerRole === "SUPER_ADMIN" || callerRole === "ADMIN_RRHH") return;
  if (callerRole === "SUPERVISOR_PRODUCTION" && groupCode === "PRODUCTION") return;
  if (callerRole === "SUPERVISOR_INSTALLATION" && groupCode === "INSTALLATION") return;
  throw new DailyReviewAuthorizationError(
    `El rol ${callerRole} no puede consultar la revisión diaria del área ${groupCode}.`
  );
}

export async function getDailyReview(
  supabase: SupabaseClient<Database>,
  callerRole: CallerRole,
  groupCode: DailyReviewResult["groupCode"],
  date: string
): Promise<DailyReviewResult> {
  assertGroupAccessAllowed(callerRole, groupCode);

  const { data: group, error: groupError } = await supabase
    .from("employee_groups")
    .select("id")
    .eq("code", groupCode)
    .single();
  if (groupError || !group) {
    throw new Error(`getDailyReview: fallo resolviendo employee_groups.code=${groupCode}: ${groupError?.message ?? "sin fila"}`);
  }

  const { data: employees, error: employeesError } = await supabase
    .from("employees")
    .select("id, display_name")
    .eq("employee_group_id", group.id)
    .eq("active", true);
  if (employeesError) {
    throw new Error(`getDailyReview: fallo listando employees del área: ${employeesError.message}`);
  }

  const employeeIds = (employees ?? []).map((e) => e.id);
  const categories = new Map<string, Set<DailyReviewCategory>>();
  const addCategory = (employeeId: string, category: DailyReviewCategory) => {
    if (!categories.has(employeeId)) categories.set(employeeId, new Set());
    categories.get(employeeId)!.add(category);
  };

  if (employeeIds.length > 0) {
    const [lateRows, earlyRows, missingPunchRows, absenceRows, overtimeRows] = await Promise.all([
      supabase
        .from("late_arrival_records")
        .select("employee_id, late_arrival_decisions(is_current)")
        .in("employee_id", employeeIds)
        .eq("work_date", date)
        .eq("is_current", true),
      supabase
        .from("early_departure_records")
        .select("id, employee_id, early_departure_decisions(is_current, reason_category, document_required)")
        .in("employee_id", employeeIds)
        .eq("work_date", date)
        .eq("is_current", true),
      supabase
        .from("attendance_missing_punch_flags")
        .select("employee_id, status")
        .in("employee_id", employeeIds)
        .eq("work_date", date)
        .in("status", ["PENDING_CONTACT", "CONTACTED"]),
      supabase
        .from("absence_records")
        .select("employee_id, absence_decisions(is_current, decision_status)")
        .in("employee_id", employeeIds)
        .lte("start_date", date)
        .gte("end_date", date)
        .eq("is_current", true),
      supabase
        .from("overtime_records")
        .select("employee_id, overtime_decisions(is_current)")
        .in("employee_id", employeeIds)
        .eq("work_date", date)
        .eq("is_current", true),
    ]);

    for (const err of [lateRows.error, earlyRows.error, missingPunchRows.error, absenceRows.error, overtimeRows.error]) {
      if (err) throw new Error(`getDailyReview: fallo agregando candidatos del día: ${err.message}`);
    }

    for (const row of lateRows.data ?? []) {
      const hasCurrentDecision = Array.isArray(row.late_arrival_decisions)
        ? row.late_arrival_decisions.some((d) => d.is_current)
        : false;
      if (!hasCurrentDecision) addCategory(row.employee_id, "LATE");
    }

    for (const row of earlyRows.data ?? []) {
      const decisions = Array.isArray(row.early_departure_decisions) ? row.early_departure_decisions : [];
      const current = decisions.find((d) => d.is_current);
      if (!current) {
        addCategory(row.employee_id, "EARLY_DEPARTURE");
      } else if (current.reason_category === "MEDICAL" && current.document_required) {
        // Documento médico pendiente sigue siendo revisión aunque ya exista
        // una decisión intermedia (PENDING_DOCUMENT conceptual, PASO 19).
        addCategory(row.employee_id, "MEDICAL_DOCUMENT_REQUIRED");
      }
    }

    for (const row of missingPunchRows.data ?? []) {
      addCategory(row.employee_id, "MISSING_PUNCH");
    }

    for (const row of absenceRows.data ?? []) {
      const decisions = Array.isArray(row.absence_decisions) ? row.absence_decisions : [];
      const current = decisions.find((d) => d.is_current);
      if (!current) {
        addCategory(row.employee_id, "ABSENCE");
      } else if (current.decision_status === "PENDING_DOCUMENT") {
        addCategory(row.employee_id, "LICENSE_DOCUMENT_REQUIRED");
      } else if (current.decision_status === "DISPUTED") {
        addCategory(row.employee_id, "ABSENCE");
      }
    }

    for (const row of overtimeRows.data ?? []) {
      const hasCurrentDecision = Array.isArray(row.overtime_decisions) ? row.overtime_decisions.some((d) => d.is_current) : false;
      if (!hasCurrentDecision) addCategory(row.employee_id, "OVERTIME_CANDIDATE");
    }
  }

  const requiresReview: DailyReviewEmployeeEntry[] = [];
  const noIssues: DailyReviewEmployeeEntry[] = [];

  for (const employee of employees ?? []) {
    const employeeCategories = categories.get(employee.id);
    if (employeeCategories && employeeCategories.size > 0) {
      requiresReview.push({ employeeId: employee.id, displayName: employee.display_name, categories: [...employeeCategories] });
    } else {
      noIssues.push({ employeeId: employee.id, displayName: employee.display_name, categories: [] });
    }
  }

  return { groupCode, date, requiresReview, noIssues };
}
