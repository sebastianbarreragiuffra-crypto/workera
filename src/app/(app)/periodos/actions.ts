"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { assertSecondFactorForPrivileged } from "../../../lib/auth/mfa-account";
import {
  createReportingPeriod,
  transitionReportingPeriod,
  type ReportingPeriodStatus,
} from "../../../lib/periods/reporting-periods";
import { enforceWorkforceActionRateLimit } from "../../../lib/decisions/workforce-action-rate-limit";
import { closePayrollPeriodWithSnapshot } from "../../../lib/payroll/payroll-period-close";
import { approvePayrollPeriodReady } from "../../../lib/payroll/payroll-period-approval";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../../lib/tenant/legacy-workforce";
import { resolvePayrollCompanyRole } from "../../../lib/payroll/payroll-company-role";

/**
 * Server Actions de administración de períodos (MB-7). Cliente de SESIÓN
 * siempre: la RLS `reporting_periods_insert_admin` / `_update_admin`
 * (`is_admin_rrhh()`) es el gate real. SUPER_ADMIN conserva auditoría
 * técnica, pero el veredicto final y la reapertura pertenecen solo a RR. HH.
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
  const supabase = await createClient();
  const payrollRole = await resolvePayrollCompanyRole(
    supabase,
    ARCOTEX_WORKFORCE_COMPANY_ID,
    ["ADMIN_RRHH"],
  );
  if (payrollRole !== "ADMIN_RRHH") {
    throw new Error("Solo RR. HH. puede crear, cambiar, cerrar o reabrir un período de pago.");
  }
  await assertSecondFactorForPrivileged(supabase);
  await enforceWorkforceActionRateLimit(supabase, "workforce.periods.manage");
  return { profile, supabase, payrollRole };
}

function toError(err: unknown, fallback: string): PeriodActionState {
  return { status: "error", message: err instanceof Error ? err.message : fallback };
}

function revalidate() {
  revalidatePath("/periodos");
  revalidatePath("/dashboard");
}

export async function createPeriodAction(_prev: PeriodActionState, formData: FormData): Promise<PeriodActionState> {
  const { supabase } = await requirePeriodAdmin();
  try {
    const periodStart = String(formData.get("periodStart") ?? "").trim();
    const periodEnd = String(formData.get("periodEnd") ?? "").trim();
    if (!DATE_PATTERN.test(periodStart) || !DATE_PATTERN.test(periodEnd)) {
      throw new Error("Las fechas del período no son válidas.");
    }

    await createReportingPeriod(supabase, {
      companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
      periodStart,
      periodEnd,
    });
    revalidate();
    return { status: "success", message: `Período ${periodStart} al ${periodEnd} creado (abierto).` };
  } catch (err) {
    return toError(err, "No pudimos crear el período.");
  }
}

export async function transitionPeriodAction(_prev: PeriodActionState, formData: FormData): Promise<PeriodActionState> {
  const { profile, supabase, payrollRole } = await requirePeriodAdmin();
  try {
    const periodId = String(formData.get("periodId") ?? "");
    const from = String(formData.get("from") ?? "") as ReportingPeriodStatus;
    const to = String(formData.get("to") ?? "") as ReportingPeriodStatus;
    const reopenReason = (formData.get("reopenReason") as string) || null;

    if (!periodId || !VALID_STATUSES.includes(from) || !VALID_STATUSES.includes(to)) {
      throw new Error("Parámetros de transición inválidos.");
    }

    if (to === "CLOSED") {
      if (from !== "READY_TO_CLOSE") {
        throw new Error("El cierre solo puede iniciarse desde Aprobado por RR. HH.");
      }
      await closePayrollPeriodWithSnapshot(supabase, {
        companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
        reportingPeriodId: periodId,
        // requirePeriodAdmin ya redujo la identidad; el RPC vuelve a derivar
        // rol, membresía y MFA desde la sesión antes de confirmar el cierre.
        callerRole: payrollRole,
      });
    } else if (to === "READY_TO_CLOSE") {
      if (from !== "IN_REVIEW" && from !== "REOPENED") {
        throw new Error("La aprobación final solo puede iniciarse desde En revisión o Reabierto.");
      }
      await approvePayrollPeriodReady(supabase, {
        actorId: profile.id,
        companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
        reportingPeriodId: periodId,
        from,
        callerRole: payrollRole,
      });
    } else {
      await transitionReportingPeriod(supabase, {
        companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
        periodId,
        from,
        to,
        actorId: profile.id,
        reopenReason,
      });
    }
    revalidate();

    const msg =
      to === "CLOSED"
        ? "Período cerrado con snapshot Excel exacto y auditable. Ya no se pueden corregir marcaciones de esas fechas."
        : to === "READY_TO_CLOSE"
          ? "Pre-nómina conciliada y aprobada expresamente por RR. HH."
        : to === "REOPENED"
          ? "Período reabierto."
          : "Estado del período actualizado.";
    return { status: "success", message: msg };
  } catch (err) {
    return toError(err, "No pudimos cambiar el estado del período.");
  }
}
