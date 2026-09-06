import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { resolvePayrollPeriod } from "../business-rules/attendance-export-periods";
import {
  ALLOWED_TRANSITIONS,
  statusLabel,
  type ReportingPeriod,
  type ReportingPeriodStatus,
} from "./reporting-period-status";

export {
  ALLOWED_TRANSITIONS,
  statusLabel,
  type ReportingPeriod,
  type ReportingPeriodStatus,
} from "./reporting-period-status";

/**
 * Administración de `reporting_periods` (MB-7).
 *
 * Hasta esta fase `/periodos` era un stub y la tabla solo se podía escribir
 * por SQL. Sin período configurado, la barra lateral muestra "Sin período
 * configurado" y NADA impide corregir marcaciones de una fecha ya pagada --
 * el trigger `prevent_attendance_correction_on_closed_period` solo bloquea
 * cuando existe un período en estado CLOSED que cubra esa fecha.
 *
 * Todo pasa por el cliente de SESIÓN (nunca admin): la RLS
 * `reporting_periods_insert_admin` / `_update_admin` (`is_admin_rrhh()`)
 * es el gate real. La reapertura atribuye `reopened_by` al usuario actual;
 * el cierre queda reservado al RPC que crea el snapshot en la misma
 * transacción.
 *
 * Ciclo de estados (enum `reporting_period_status`):
 *   OPEN -> IN_REVIEW -> READY_TO_CLOSE -> CLOSED
 *   CLOSED -> REOPENED (con motivo obligatorio) -> ... -> CLOSED de nuevo
 *
 * `CLOSED` no se escribe desde este helper genérico: requiere el protocolo
 * de snapshot exacto (`closePayrollPeriodWithSnapshot`) y su RPC atómico.
 */

interface RawPeriod {
  id: string;
  company_id: string;
  period_start: string;
  period_end: string;
  status: ReportingPeriodStatus;
  closed_at: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
}

function toPeriod(r: RawPeriod): ReportingPeriod {
  return {
    id: r.id,
    companyId: r.company_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    closedAt: r.closed_at,
    reopenedAt: r.reopened_at,
    reopenReason: r.reopen_reason,
  };
}

export interface ReportingPeriodsBoard {
  periods: ReportingPeriod[];
  /** Sugerencia para "crear el siguiente período": el ciclo de pago 16-15 que sigue al último período existente. */
  suggestedNext: { periodStart: string; periodEnd: string; label: string };
}

/** Dado un `period_end` (día 15), el mes de pago del siguiente ciclo. */
function nextPayrollYearMonth(lastEnd: string | null): string {
  const now = new Date();
  if (!lastEnd) {
    // Sin períodos: sugiere el ciclo del mes en curso.
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const [y, m] = lastEnd.split("-").map(Number);
  // El período que termina el 15 de un mes ES el ciclo de pago de ese mes;
  // el siguiente ciclo es el mes siguiente.
  const nextMonth = m === 12 ? 1 : m + 1;
  const nextYear = m === 12 ? y + 1 : y;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

export async function getReportingPeriodsBoard(
  supabase: SupabaseClient<Database>,
  companyId: string,
): Promise<ReportingPeriodsBoard> {
  const { data, error } = await supabase
    .from("reporting_periods")
    .select("id, company_id, period_start, period_end, status, closed_at, reopened_at, reopen_reason")
    .eq("company_id", companyId)
    .order("period_start", { ascending: false });

  if (error) throw new Error(`getReportingPeriodsBoard: fallo leyendo reporting_periods: ${error.message}`);

  const periods = (data ?? []).map((r) => toPeriod(r as RawPeriod));
  const lastEnd = periods.length > 0 ? periods[0].periodEnd : null;
  const suggested = resolvePayrollPeriod(nextPayrollYearMonth(lastEnd));

  return {
    periods,
    suggestedNext: { periodStart: suggested.startDate, periodEnd: suggested.endDate, label: suggested.label },
  };
}

// --- Escritura ---

function translateError(message: string): string {
  if (message.includes("no_overlap") || message.includes("exclusion")) {
    return "Ese rango de fechas se solapa con un período que ya existe.";
  }
  if (message.includes("range_chk")) {
    return "La fecha de término no puede ser anterior a la de inicio.";
  }
  if (message.includes("row-level security") || message.includes("violates row-level")) {
    return "No tienes permiso para administrar períodos.";
  }
  return message;
}

export async function createReportingPeriod(
  supabase: SupabaseClient<Database>,
  input: { companyId: string; periodStart: string; periodEnd: string }
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from("reporting_periods")
    .insert({ company_id: input.companyId, period_start: input.periodStart, period_end: input.periodEnd, status: "OPEN" })
    .select("id")
    .single();

  if (error || !data) throw new Error(translateError(error?.message ?? "no se pudo crear el período."));
  return { id: data.id };
}

export async function transitionReportingPeriod(
  supabase: SupabaseClient<Database>,
  input: { companyId: string; periodId: string; from: ReportingPeriodStatus; to: ReportingPeriodStatus; actorId: string; reopenReason?: string | null }
): Promise<void> {
  if (!ALLOWED_TRANSITIONS[input.from].includes(input.to)) {
    throw new Error(`Transición no permitida: ${statusLabel(input.from)} -> ${statusLabel(input.to)}.`);
  }
  if (input.to === "CLOSED" || input.to === "READY_TO_CLOSE") {
    throw new Error(
      input.to === "CLOSED"
        ? "Cerrar un período exige generar y confirmar su snapshot Excel exacto."
        : "Aprobar un período exige recalcular pendientes y registrar la evidencia conciliada de RR. HH.",
    );
  }

  type PeriodPatch = Database["public"]["Tables"]["reporting_periods"]["Update"];
  const patch: PeriodPatch = { status: input.to };

  if (input.to === "REOPENED") {
    const reason = (input.reopenReason ?? "").trim();
    if (!reason) throw new Error("Reabrir un período cerrado exige un motivo.");
    patch.reopened_by = input.actorId;
    patch.reopened_at = new Date().toISOString();
    patch.reopen_reason = reason;
  }

  // Solo transiciona si el estado actual sigue siendo el esperado -- evita
  // pisar un cambio concurrente de otro admin.
  const { data, error } = await supabase
    .from("reporting_periods")
    .update(patch)
    .eq("id", input.periodId)
    .eq("company_id", input.companyId)
    .eq("status", input.from)
    .select("id");

  if (error) throw new Error(translateError(error.message));
  if (!data || data.length === 0) {
    throw new Error("El período cambió de estado mientras tanto. Recarga la página.");
  }
}
