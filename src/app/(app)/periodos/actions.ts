"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import {
  createReportingPeriod,
  transitionReportingPeriod,
  type ReportingPeriodStatus,
} from "../../../lib/periods/reporting-periods";
import { enforceWorkforceActionRateLimit } from "../../../lib/decisions/workforce-action-rate-limit";

/**
 * Server Actions de administración de períodos (MB-7). Cliente de SESIÓN
 * siempre: la RLS `reporting_periods_insert_admin` / `_update_admin`
 * (is_privileged_admin()) es el gate real. El chequeo de rol de acá solo da
 * un mensaje claro.
 */

export interface PeriodActionState {
  status: "idle" | "success" | "error";
  message: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES: ReportingPeriodStatus[] = ["OPEN", "IN_REVIEW", "READY_TO_CLOSE", "CLOSED", "REOPENED"];

async function requirePeriodAdmin() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") {
    throw new Error("Esta operación requiere rol SUPER_ADMIN o ADMIN_RRHH.");
  }
  await enforceWorkforceActionRateLimit(await createClient(), "workforce.periods.manage");
  return profile;
}

function toError(err: unknown, fallback: string): PeriodActionState {
  return { status: "error", message: err instanceof Error ? err.message : fallback };
}

function revalidate() {
  revalidatePath("/periodos");
  revalidatePath("/dashboard");
}

export async function createPeriodAction(_prev: PeriodActionState, formData: FormData): Promise<PeriodActionState> {
  await requirePeriodAdmin();
  try {
    const periodStart = String(formData.get("periodStart") ?? "").trim();
    const periodEnd = String(formData.get("periodEnd") ?? "").trim();
    if (!DATE_PATTERN.test(periodStart) || !DATE_PATTERN.test(periodEnd)) {
      throw new Error("Las fechas del período no son válidas.");
    }

    const supabase = await createClient();
    await createReportingPeriod(supabase, { periodStart, periodEnd });
    revalidate();
    return { status: "success", message: `Período ${periodStart} al ${periodEnd} creado (abierto).` };
  } catch (err) {
    return toError(err, "No pudimos crear el período.");
  }
}

export async function transitionPeriodAction(_prev: PeriodActionState, formData: FormData): Promise<PeriodActionState> {
  const profile = await requirePeriodAdmin();
  try {
    const periodId = String(formData.get("periodId") ?? "");
    const from = String(formData.get("from") ?? "") as ReportingPeriodStatus;
    const to = String(formData.get("to") ?? "") as ReportingPeriodStatus;
    const reopenReason = (formData.get("reopenReason") as string) || null;

    if (!periodId || !VALID_STATUSES.includes(from) || !VALID_STATUSES.includes(to)) {
      throw new Error("Parámetros de transición inválidos.");
    }

    const supabase = await createClient();
    await transitionReportingPeriod(supabase, { periodId, from, to, actorId: profile.id, reopenReason });
    revalidate();

    const msg =
      to === "CLOSED"
        ? "Período cerrado. Ya no se pueden corregir marcaciones de esas fechas."
        : to === "REOPENED"
          ? "Período reabierto."
          : "Estado del período actualizado.";
    return { status: "success", message: msg };
  } catch (err) {
    return toError(err, "No pudimos cambiar el estado del período.");
  }
}
