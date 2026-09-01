"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../../lib/auth/session";
import { runRuleEngineWithServiceRole } from "../../../../lib/rule-engine/service";

/**
 * Disparo manual del motor de reglas (MB-2).
 *
 * Autoriza contra la SESIÓN real primero y solo después usa el admin client,
 * exactamente el mismo patrón que `src/lib/admin/user-management.ts` y que el
 * rerun de sincronización: `rule_engine_runs` no tiene policy de escritura
 * para `authenticated` a propósito, porque el motor también corre desde el
 * cron, donde no hay sesión.
 */

export interface ProcessDayActionState {
  status: "idle" | "success" | "warning" | "error";
  message: string;
}

export const PROCESS_DAY_INITIAL: ProcessDayActionState = { status: "idle", message: "" };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function processAttendanceDayAction(
  _prev: ProcessDayActionState,
  formData: FormData
): Promise<ProcessDayActionState> {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") {
    return { status: "error", message: "Esta operación requiere rol SUPER_ADMIN o ADMIN_RRHH." };
  }

  const date = String(formData.get("date") ?? "").trim();
  if (!DATE_PATTERN.test(date)) {
    return { status: "error", message: "La fecha no es válida." };
  }

  try {
    const outcome = await runRuleEngineWithServiceRole(date, {
      triggeredBy: "MANUAL",
      triggeredByProfile: profile.id,
    });

    revalidatePath("/configuracion/motor-de-reglas");
    revalidatePath("/revision-diaria");
    revalidatePath("/dashboard");

    if (outcome.status === "ALREADY_RUNNING") {
      return { status: "warning", message: `Ya hay una corrida en curso para el ${date}. Espera a que termine.` };
    }
    if (outcome.status === "FAILED") {
      return { status: "error", message: `La corrida del ${date} falló: ${outcome.errorSummary ?? "sin detalle"}` };
    }

    const r = outcome.result!;
    const parts = [
      `${r.employeesProcessed} trabajadores procesados`,
      `${r.lateCandidates} atraso(s)`,
      `${r.earlyDepartureCandidates} salida(s) anticipada(s)`,
      `${r.overtimeCandidates} hora(s) extra`,
    ];

    // La cobertura incompleta se avisa siempre: un trabajador sin horario
    // vigente queda fuera del motor en silencio, y durante una marcha blanca
    // eso es exactamente el error que no se puede pasar por alto.
    if (r.withoutSchedule > 0) {
      return {
        status: "warning",
        message: `${parts.join(", ")}. Atención: ${r.withoutSchedule} trabajador(es) sin horario vigente quedaron fuera del cálculo.`,
      };
    }
    if (outcome.status === "PARTIAL") {
      return { status: "warning", message: `${parts.join(", ")}. ${r.failures.length} trabajador(es) fallaron individualmente.` };
    }

    return { status: "success", message: `${parts.join(", ")}.` };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos procesar el día." };
  }
}
