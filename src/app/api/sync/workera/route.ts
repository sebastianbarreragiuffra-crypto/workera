import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  runScheduledWorkeraSync,
  rerunWorkeraSync,
  RerunAuthorizationError,
  MAX_MANUAL_SYNC_DAYS,
} from "@/lib/sync/scheduler";

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

export function isValidCronSecret(request: NextRequest): boolean {
  const configured = process.env.CRON_SECRET;
  if (!configured) return false; // fail-closed: sin secreto configurado, el camino cron nunca se acepta.

  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);

  const providedBuf = Buffer.from(provided);
  const configuredBuf = Buffer.from(configured);
  if (providedBuf.length !== configuredBuf.length) return false; // timingSafeEqual exige igual longitud.
  return timingSafeEqual(providedBuf, configuredBuf);
}

/** Peor status entre los resultados de una tanda de fechas, para el código HTTP de la respuesta. */
export function worstHttpStatus(statuses: string[]): number {
  if (statuses.some((s) => s === "FAILED")) return 500;
  if (statuses.some((s) => s === "ALREADY_RUNNING")) return 409;
  if (statuses.some((s) => s.startsWith("BLOCKED_"))) return 422;
  return 200;
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

  const statuses = Object.values(summary.results).map((r) => r.status);
  return NextResponse.json(
    {
      enabled: true,
      targetDate: summary.targetDate,
      reconciliationDates: summary.reconciliationDates,
      results: summarizeResults(summary.results),
    },
    { status: worstHttpStatus(statuses) }
  );
}

export async function POST(request: NextRequest) {
  let body: { startDate?: string; endDate?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo de la request inválido -- se espera JSON." }, { status: 400 });
  }

  if (!body.startDate || !body.endDate) {
    return NextResponse.json({ error: "startDate y endDate son requeridos." }, { status: 400 });
  }

  try {
    const result = await rerunWorkeraSync({ startDate: body.startDate, endDate: body.endDate });
    const statuses = Object.values(result.results).map((r) => r.status);
    return NextResponse.json(
      { dates: result.dates, results: summarizeResults(result.results) },
      { status: worstHttpStatus(statuses) }
    );
  } catch (err) {
    if (err instanceof RerunAuthorizationError) {
      const status = err.message.includes("sesión autenticada") ? 401 : 403;
      return NextResponse.json({ error: "No autorizado." }, { status });
    }
    if (err instanceof Error && err.message.includes(String(MAX_MANUAL_SYNC_DAYS))) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: "Fallo interno procesando el rerun." }, { status: 500 });
  }
}
