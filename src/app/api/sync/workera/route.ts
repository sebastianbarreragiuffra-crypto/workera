import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import {
  runScheduledWorkeraSync,
  rerunWorkeraSync,
  RerunAuthorizationError,
  RerunRangeError,
} from "@/lib/sync/scheduler";
import { runRuleEngineWithServiceRole } from "@/lib/rule-engine/service";
import { createClient } from "@/lib/supabase/server";
import { enforceWorkforceActionRateLimit } from "@/lib/decisions/workforce-action-rate-limit";
import { ApplicationActionLimitError } from "@/lib/shared/action-rate-limit";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "@/lib/tenant/legacy-workforce";
import {
  datesReadyForRuleEngine,
  isValidCronSecret,
  readManualRerunBody,
  worstHttpStatus,
} from "./route-utils";

/**
 * Route Handler server-only del scheduler (Fase 6B). Dos métodos HTTP, dos
 * caminos de autorización COMPLETAMENTE INDEPENDIENTES (PASO 6/36):
 *
 *  GET  -- disparo del cron real. Vercel Cron invoca por defecto con GET
 *     (no POST) y agrega automáticamente `Authorization: Bearer
 *     $CRON_SECRET` cuando esa variable de entorno está configurada en el
 *     proyecto de Vercel. CRON_SECRET es un secreto INDEPENDIENTE de
 *     WORKERA_API_KEY y de SUPABASE_SERVICE_ROLE_KEY -- nunca se reutiliza
 *     ninguno de esos dos como secreto de cron. Sin este header válido,
 *     GET siempre responde 401 -- este método NUNCA acepta sesión de
 *     usuario como alternativa (evita que cualquier navegador autenticado
 *     dispare el cron por accidente visitando la URL).
 *
 *  POST -- rerun administrativo. Requiere sesión real de Supabase con rol
 *     SUPER_ADMIN o ADMIN_RRHH (verificado dentro de `rerunWorkeraSync` vía
 *     `requireCurrentRole` -- la MISMA autorización que ya usa
 *     src/lib/admin/user-management.ts). Nunca acepta el secreto de cron
 *     como alternativa.
 *
 * Ningún camino devuelve 200 si el sync en sí falló (PASO 30), y ninguno
 * expone detalles internos/secretos en el cuerpo de la respuesta.
 */

/**
 * MB-2: la ingesta por sí sola no produce nada visible para un supervisor --
 * `syncWorkeraAttendance` deja los eventos crudos en
 * `workera_attendance_events` y explícitamente NO calcula atrasos, horas
 * extra ni colapsa marcaciones. Este paso ejecuta el motor de Fase 7 sobre
 * cada fecha recién sincronizada, que es lo que finalmente puebla
 * `attendance_records` y las tablas de candidatos que lee `/revision-diaria`.
 *
 * Corre bajo service_role igual que la ingesta: el camino del cron no tiene
 * sesión de usuario, y `rule_engine_runs` no tiene policy de escritura para
 * `authenticated` a propósito.
 */
async function runRuleEngineForSyncedDates(
  results: Record<string, { status: string }>,
  triggeredBy: "CRON" | "MANUAL",
  companyId: string
): Promise<Record<string, { status: string; lateCandidates: number; overtimeCandidates: number; withoutSchedule: number }>> {
  const dates = datesReadyForRuleEngine(results);
  if (dates.length === 0) return {};

  const summary: Record<string, { status: string; lateCandidates: number; overtimeCandidates: number; withoutSchedule: number }> = {};

  for (const date of dates) {
    try {
      const outcome = await runRuleEngineWithServiceRole(date, { companyId, triggeredBy });
      summary[date] = {
        status: outcome.status,
        lateCandidates: outcome.result?.lateCandidates ?? 0,
        overtimeCandidates: outcome.result?.overtimeCandidates ?? 0,
        withoutSchedule: outcome.result?.withoutSchedule ?? 0,
      };
    } catch {
      // Nunca se propaga el mensaje crudo al cuerpo HTTP (mismo criterio que
      // el resto de este handler). El detalle queda en `rule_engine_runs`.
      summary[date] = { status: "FAILED", lateCandidates: 0, overtimeCandidates: 0, withoutSchedule: 0 };
    }
  }

  return summary;
}

function summarizeResults(results: Record<string, { status: string; attempts: number; inserted: number; versioned: number; unchanged: number }>) {
  return Object.fromEntries(
    Object.entries(results).map(([date, r]) => [
      date,
      { status: r.status, attempts: r.attempts, inserted: r.inserted, versioned: r.versioned, unchanged: r.unchanged },
    ])
  );
}

export async function GET(request: NextRequest) {
  if (!isValidCronSecret(request)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const summary = await runScheduledWorkeraSync();

  if (!summary.enabled) {
    return NextResponse.json(
      { enabled: false, targetDate: summary.targetDate, reason: "WORKERA_SYNC_ENABLED is not true" },
      { status: 200 }
    );
  }

  const ruleEngine = await runRuleEngineForSyncedDates(
    summary.results,
    "CRON",
    ARCOTEX_WORKFORCE_COMPANY_ID
  );

  const statuses = [
    ...Object.values(summary.results).map((r) => r.status),
    ...Object.values(ruleEngine).map((r) => r.status),
  ];
  return NextResponse.json(
    {
      enabled: true,
      targetDate: summary.targetDate,
      reconciliationDates: summary.reconciliationDates,
      results: summarizeResults(summary.results),
      ruleEngine,
    },
    { status: worstHttpStatus(statuses) }
  );
}

export async function POST(request: NextRequest) {
  try {
    await enforceWorkforceActionRateLimit(await createClient(), "workforce.sync.rerun");
  } catch (error) {
    if (error instanceof ApplicationActionLimitError) {
      if (error.decision.status === "RATE_LIMITED") {
        return NextResponse.json(
          { error: "Demasiadas solicitudes. Intenta nuevamente más tarde." },
          { status: 429, headers: { "Retry-After": String(error.decision.retryAfterSeconds) } },
        );
      }
      return NextResponse.json(
        { error: error.decision.status === "DENIED" ? "No autorizado." : "Control de seguridad no disponible." },
        { status: error.decision.status === "DENIED" ? 403 : 503 },
      );
    }
    return NextResponse.json({ error: "Control de seguridad no disponible." }, { status: 503 });
  }

  let body: { startDate?: string; endDate?: string };
  try {
    body = await readManualRerunBody(request) as { startDate?: string; endDate?: string };
  } catch (error) {
    if (error instanceof RangeError) {
      return NextResponse.json({ error: "El cuerpo supera el máximo permitido." }, { status: 413 });
    }
    return NextResponse.json({ error: "Cuerpo de la request inválido -- se espera JSON." }, { status: 400 });
  }

  if (!body.startDate || !body.endDate) {
    return NextResponse.json({ error: "startDate y endDate son requeridos." }, { status: 400 });
  }

  try {
    const result = await rerunWorkeraSync({ startDate: body.startDate, endDate: body.endDate });
    const ruleEngine = await runRuleEngineForSyncedDates(
      result.results,
      "MANUAL",
      ARCOTEX_WORKFORCE_COMPANY_ID
    );

    const statuses = [
      ...Object.values(result.results).map((r) => r.status),
      ...Object.values(ruleEngine).map((r) => r.status),
    ];
    return NextResponse.json(
      { dates: result.dates, results: summarizeResults(result.results), ruleEngine },
      { status: worstHttpStatus(statuses) }
    );
  } catch (err) {
    if (err instanceof RerunAuthorizationError) {
      const status = err.message.includes("sesión autenticada") ? 401 : 403;
      return NextResponse.json({ error: "No autorizado." }, { status });
    }
    // Se reconoce por TIPO, no por el texto del mensaje: `includes("31")`
    // devolvía crudo cualquier error interno cuyo mensaje contuviera ese
    // número, y una fecha como 2026-01-31 lo contiene.
    if (err instanceof RerunRangeError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    console.error("[sync/workera] fallo procesando el rerun", err instanceof Error ? err.message : "error desconocido");
    return NextResponse.json({ error: "Fallo interno procesando el rerun." }, { status: 500 });
  }
}
