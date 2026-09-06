import "server-only";
import { createAdminClient } from "../supabase/admin-client";
import {
  runRuleEngineForDate,
  type RuleEngineRunOutcome,
  type ProcessAttendanceDayResult,
} from "../business-rules/process-attendance-day";

/**
 * Único punto de entrada del motor de reglas bajo `service_role` (MB-2).
 *
 * Existe como módulo propio para NO tener que abrir la allowlist de
 * `createAdminClient` a `src/app/**` (ver `src/lib/admin/security.test.ts`):
 * un Route Handler o una Server Action jamás debe obtener el cliente
 * service_role por su cuenta. Misma categoría y mismo criterio con el que
 * Fase 6A incorporó `src/lib/sync` -- sigue siendo una allowlist cerrada de
 * directorios server-only auditados, no una relajación.
 *
 * Por qué el motor necesita service_role y no la sesión del usuario:
 *  - El camino del cron (`GET /api/sync/workera`) no tiene sesión alguna.
 *  - `rule_engine_runs` no tiene policy de escritura para `authenticated` a
 *    propósito: la bitácora la escribe el sistema, nunca el navegador.
 *
 * Este módulo NO decide autorización. Quien lo invoque desde un camino con
 * usuario debe validar el rol contra su sesión real ANTES de llamar aquí --
 * exactamente el mismo contrato que `src/lib/admin/user-management.ts`.
 */
export async function runRuleEngineWithServiceRole(
  date: string,
  params: {
    companyId: string;
    triggeredBy: "CRON" | "MANUAL";
    triggeredByProfile?: string | null;
  }
): Promise<RuleEngineRunOutcome> {
  const supabase = createAdminClient("attendance-rule-engine");
  return runRuleEngineForDate(supabase, date, params);
}

/**
 * Re-derivación del DÍA COMPLETO tras corregir un trabajador (MB-3).
 *
 * No se limita al trabajador editado: una corrida parcial de una sola persona
 * no puede sobrescribir la señal de que otro trabajador del mismo día seguía
 * fallando. Abre la misma bitácora/lease full. Así una caída entre
 * la raíz diaria y cualquiera de sus candidatos queda FAILED/PARTIAL y el
 * export no puede confundir un reproceso incompleto con la última corrida
 * sana. La concurrencia se rechaza de forma visible, nunca se pierde.
 *
 * Igual que el resto de este módulo: no autoriza nada. Quien llame ya debe
 * haber validado, contra su sesión real, que puede gestionar a ese trabajador
 * -- y el RPC atómico de corrección vuelve a comprobar actor, empresa y
 * autoridad histórica. `companyId` sigue siendo obligatorio: el cliente admin
 * no puede inferir un tenant desde RLS ni desde una sesión.
 */
export async function reprocessEmployeeDay(
  _employeeId: string,
  date: string,
  companyId: string,
  triggeredByProfile: string,
): Promise<ProcessAttendanceDayResult> {
  const supabase = createAdminClient("attendance-rule-engine");
  const outcome = await runRuleEngineForDate(supabase, date, {
    companyId,
    triggeredBy: "MANUAL",
    triggeredByProfile,
    // `employeeId` se conserva en la firma para trazabilidad del llamador,
    // pero la corrida intencionalmente cubre todo el padrón del día.
  });
  if (!outcome.result || outcome.status === "FAILED" || outcome.status === "ALREADY_RUNNING") {
    throw new Error(
      outcome.status === "ALREADY_RUNNING"
        ? "Ya existe un recálculo en curso para esta fecha. Reintenta al finalizar."
        : `No fue posible completar el recálculo: ${outcome.errorSummary ?? "sin resultado"}`
    );
  }
  return outcome.result;
}
