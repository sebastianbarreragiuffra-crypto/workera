import "server-only";
import { createAdminClient } from "../supabase/admin-client";
import {
  runRuleEngineForDate,
  processAttendanceDay,
  type RuleEngineRunOutcome,
  type ProcessAttendanceDayOptions,
  type ProcessAttendanceDayResult,
} from "../business-rules/process-attendance-day";
import { WORKERA_COMPANY_ID } from "../tenant/company-scope";

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
    triggeredBy: "CRON" | "MANUAL";
    triggeredByProfile?: string | null;
    options?: ProcessAttendanceDayOptions;
  }
): Promise<RuleEngineRunOutcome> {
  const supabase = createAdminClient();
  return runRuleEngineForDate(supabase, date, { ...params, companyId: WORKERA_COMPANY_ID });
}

/**
 * Re-derivación acotada a UN trabajador y UN día (MB-3), tras corregir su
 * marcación.
 *
 * Deliberadamente NO abre una fila en `rule_engine_runs`: esa bitácora
 * registra corridas de día completo, y su índice de concurrencia es por fecha.
 * Anotar ahí cada corrección individual ensuciaría el historial (con
 * `employees_processed = 1` junto a corridas de 44) y, peor, una corrección
 * hecha mientras el cron procesa esa misma fecha chocaría contra el índice y
 * se perdería en silencio.
 *
 * Igual que el resto de este módulo: no autoriza nada. Quien llame ya debe
 * haber validado, contra su sesión real, que puede gestionar a ese trabajador
 * -- lo cual la RLS de `attendance_corrections` ya hizo al aceptar la
 * corrección que motiva esta llamada.
 */
export async function reprocessEmployeeDay(employeeId: string, date: string): Promise<ProcessAttendanceDayResult> {
  const supabase = createAdminClient();
  return processAttendanceDay(supabase, date, { companyId: WORKERA_COMPANY_ID, employeeIds: [employeeId] });
}
