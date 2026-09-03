import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncWorkeraAttendance, type SyncWorkeraAttendanceResult } from "./workera-attendance-sync";
import { isRetryableSyncErrorCategory } from "./errors";
import { resolveTargetDate, resolveReconciliationWindow } from "./target-date";
import { requireCurrentRole, AuthorizationError } from "../supabase/authorize";
import { createAdminClient } from "../supabase/admin-client";
import type { Database } from "../supabase/database.types";
import { WORKERA_COMPANY_ID } from "../tenant/company-scope";

/**
 * Orquestación de la automatización de Fase 6B. Reutiliza
 * `syncWorkeraAttendance` (Fase 6A) sin modificarlo más allá de las
 * extensiones aditivas ya hechas (triggeredBy/attempt/retryOf/errorCategory/
 * ALREADY_RUNNING) -- esta capa nunca reimplementa fetch/validación/
 * persistencia, solo decide CUÁNDO y CUÁNTAS VECES llamar al mismo servicio.
 */

// ---------------------------------------------------------------------------
// Configuración (Fase 6B, PASO 15/40): constantes de código para parámetros
// de ajuste interno (nunca expuestos como env var -- "no inventar
// configuración excesiva"); env vars solo para lo que de verdad depende del
// entorno de despliegue.

/** Nunca infinite retry (PASO 15). 1 intento inicial + 2 reintentos. */
export const MAX_SYNC_ATTEMPTS = 3;

/**
 * Backoff corto (PASO 15/31: "no reintentar una hora después... preferir
 * fallar claramente" -- todo esto corre dentro de una sola invocación de
 * función serverless con límite de tiempo de plataforma). Un jitter de hasta
 * 300ms evita que reintentos de múltiples corridas paralelas se agrupen.
 */
const RETRY_BASE_DELAYS_MS = [1_000, 3_000] as const;

/** Rango máximo para un rerun manual (PASO 9): recuperar semanas, no años. */
export const MAX_MANUAL_SYNC_DAYS = 31;

/** Umbral de "lock huérfano" pasado a reclaim_stale_workera_sync_runs (PASO 20/25). */
const STALE_RUNNING_SECONDS = 900; // 15 minutos

const DEFAULT_RECONCILIATION_DAYS = 2;

/**
 * Días adicionales antes de D-1 que el cron reconsulta (PASO 18/19). Default
 * documentado (no una cifra arbitraria sin justificar): 2 -- captura
 * MODIFICADO/INACTIVO/correcciones reportadas en Workera hasta 2 días
 * después del sync original, sin acercarse a un backfill histórico.
 * Configurable vía WORKERA_SYNC_RECONCILIATION_DAYS.
 */
export function getReconciliationDays(): number {
  const raw = process.env.WORKERA_SYNC_RECONCILIATION_DAYS;
  if (!raw) return DEFAULT_RECONCILIATION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`WORKERA_SYNC_RECONCILIATION_DAYS debe ser un entero >= 0, recibido: "${raw}"`);
  }
  return parsed;
}

/**
 * Interruptor de seguridad (PASO 41: "scheduler no debe activarse
 * accidentalmente"). Defensa en profundidad independiente de si el cron de
 * Vercel está desplegado o no -- aunque `vercel.json` llegara a producción
 * sin querer, el handler no hace nada real hasta que esta variable esté
 * EXPLÍCITAMENTE en "true".
 */
export function isAutomatedSyncEnabled(): boolean {
  return process.env.WORKERA_SYNC_ENABLED === "true";
}

/** Cliente Workera inyectable en tests -- mismo tipo que acepta syncWorkeraAttendance. */
type InjectableWorkeraClient = NonNullable<Parameters<typeof syncWorkeraAttendance>[1]>["workeraClient"];

interface SyncDeps {
  supabaseAdmin?: SupabaseClient<Database>;
  workeraClient?: InjectableWorkeraClient;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunForDateResult extends SyncWorkeraAttendanceResult {
  attempts: number;
}

/**
 * Corre (con reintentos acotados) una sincronización para UN día, respetando
 * la concurrencia real a nivel de BD (índice único parcial de sync_runs) --
 * ver migración 20260819100000. Reutiliza `syncWorkeraAttendance` en cada
 * intento; nunca reimplementa fetch/persistencia.
 */
export async function runWorkeraSyncForDate(
  date: string,
  opts: { triggeredBy: "CRON" | "MANUAL"; deps?: SyncDeps; sleep?: (ms: number) => Promise<void> }
): Promise<RunForDateResult> {
  const supabaseAdmin = opts.deps?.supabaseAdmin ?? createAdminClient();
  const sleep = opts.sleep ?? defaultSleep;

  // Libera locks huérfanos de procesos caídos ANTES de competir por el
  // índice único -- una fila RUNNING de un intento nuestro previo en esta
  // misma secuencia ya no está RUNNING (terminó FAILED), así que esto solo
  // afecta corridas de OTROS procesos que nunca terminaron limpio.
  await supabaseAdmin.rpc("reclaim_stale_workera_sync_runs", {
    p_company_id: WORKERA_COMPANY_ID,
    p_stale_after_seconds: STALE_RUNNING_SECONDS,
  });

  let lastResult: SyncWorkeraAttendanceResult | null = null;
  let retryOf: string | null = null;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
    const result = await syncWorkeraAttendance(
      {
        companyId: WORKERA_COMPANY_ID,
        startDate: date,
        endDate: date,
        triggeredBy: opts.triggeredBy,
        attempt,
        retryOf,
      },
      { supabaseAdmin, workeraClient: opts.deps?.workeraClient }
    );
    lastResult = result;

    if (result.status !== "FAILED") {
      // SUCCEEDED, DRY_RUN, ALREADY_RUNNING, BLOCKED_* -- ninguno de estos
      // se arregla reintentando la MISMA corrida inmediatamente.
      return { ...result, attempts: attempt };
    }

    if (result.syncRunId) retryOf = result.syncRunId;

    const isLastAttempt = attempt === MAX_SYNC_ATTEMPTS;
    if (isLastAttempt || !isRetryableSyncErrorCategory(result.errorCategory)) {
      return { ...result, attempts: attempt };
    }

    const baseDelay = RETRY_BASE_DELAYS_MS[attempt - 1] ?? RETRY_BASE_DELAYS_MS[RETRY_BASE_DELAYS_MS.length - 1];
    const jitterMs = Math.floor(Math.random() * 300);
    await sleep(baseDelay + jitterMs);
  }

  // Inalcanzable en la práctica (el loop siempre retorna dentro de sí
  // mismo), pero TypeScript no puede probarlo -- devuelve el último
  // resultado conocido en vez de `undefined`.
  return { ...(lastResult as SyncWorkeraAttendanceResult), attempts: MAX_SYNC_ATTEMPTS };
}

export interface ScheduledSyncSummary {
  enabled: boolean;
  targetDate: string;
  reconciliationDates: string[];
  results: Record<string, RunForDateResult>;
}

/**
 * Punto de entrada del cron (Fase 6B, PASO 2/18/19/41). Resuelve D-1 en
 * America/Santiago + la ventana de reconciliación, y sincroniza cada fecha
 * en secuencia (nunca en paralelo -- evita llamadas concurrentes
 * innecesarias a Workera y mantiene el uso de recursos predecible).
 * No hace NADA real si `isAutomatedSyncEnabled()` es false.
 */
export async function runScheduledWorkeraSync(
  opts: {
    now?: Date;
    timeZone?: string;
    deps?: SyncDeps;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<ScheduledSyncSummary> {
  const now = opts.now ?? new Date();
  const targetDate = resolveTargetDate(now, opts.timeZone);
  const reconciliationDays = getReconciliationDays();
  const reconciliationDates = resolveReconciliationWindow(targetDate, reconciliationDays);

  if (!isAutomatedSyncEnabled()) {
    return { enabled: false, targetDate, reconciliationDates, results: {} };
  }

  const results: Record<string, RunForDateResult> = {};
  for (const date of reconciliationDates) {
    results[date] = await runWorkeraSyncForDate(date, {
      triggeredBy: "CRON",
      deps: opts.deps,
      sleep: opts.sleep,
    });
  }

  return { enabled: true, targetDate, reconciliationDates, results };
}

export interface RerunWorkeraSyncParams {
  startDate: string;
  endDate: string;
}

export interface RerunWorkeraSyncResult {
  actorId: string;
  actorRole: "SUPER_ADMIN" | "ADMIN_RRHH";
  dates: string[];
  results: Record<string, RunForDateResult>;
}

/**
 * Rerun administrativo controlado (Fase 6B, PASO 8/9/34). Autorización:
 * SUPER_ADMIN y ADMIN_RRHH pueden reejecutar; ningún supervisor puede
 * (documentado en docs/WORKERA_SYNC_PHASE6B.md). Rango acotado por
 * MAX_MANUAL_SYNC_DAYS -- nunca un backfill accidental. Recorre cada día del
 * rango en secuencia, reutilizando el mismo `runWorkeraSyncForDate` que usa
 * el cron (misma concurrencia, mismos reintentos, mismo pipeline).
 */
export async function rerunWorkeraSync(
  params: RerunWorkeraSyncParams,
  deps?: SyncDeps,
  sleep?: (ms: number) => Promise<void>,
  /** Inyectable en tests -- default llama a la sesión real (requireCurrentRole). */
  authorize: () => ReturnType<typeof requireCurrentRole> = () => requireCurrentRole("SUPER_ADMIN", "ADMIN_RRHH")
): Promise<RerunWorkeraSyncResult> {
  const { actorId, actorRole } = await authorize();

  const start = new Date(`${params.startDate}T00:00:00Z`);
  const end = new Date(`${params.endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    throw new Error(`Rango inválido: startDate="${params.startDate}", endDate="${params.endDate}".`);
  }
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (spanDays > MAX_MANUAL_SYNC_DAYS) {
    throw new Error(
      `Rango solicitado (${spanDays} días) excede el máximo permitido para rerun manual (${MAX_MANUAL_SYNC_DAYS} días).`
    );
  }

  const dates: string[] = [];
  for (let i = 0; i < spanDays; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000);
    dates.push(d.toISOString().slice(0, 10));
  }

  const results: Record<string, RunForDateResult> = {};
  for (const date of dates) {
    results[date] = await runWorkeraSyncForDate(date, { triggeredBy: "MANUAL", deps, sleep });
  }

  return { actorId, actorRole: actorRole as "SUPER_ADMIN" | "ADMIN_RRHH", dates, results };
}

export { AuthorizationError as RerunAuthorizationError };

// ---------------------------------------------------------------------------
// Salud/estado (Fase 6B, PASO 24/25) -- sin UI, sin notificaciones. Solo
// consultas server-side sobre `sync_runs`.

export type WorkeraSyncHealthStatus = "HEALTHY" | "STALE" | "RUNNING" | "DEGRADED" | "UNKNOWN";

export interface WorkeraSyncHealth {
  status: WorkeraSyncHealthStatus;
  lastSuccess: { syncRunId: string; targetDate: string; finishedAt: string } | null;
  lastFailure: { syncRunId: string; targetDate: string; finishedAt: string | null; errorCategory: string | null } | null;
  currentlyRunning: { syncRunId: string; targetDate: string; startedAt: string }[];
}

/**
 * `staleAfterHours` define cuánto tiempo sin un SUCCEEDED se considera
 * STALE (PASO 25). Parámetro explícito (no un env var más) porque depende
 * del contexto de quien llama (una alerta operativa podría querer un umbral
 * distinto al de un health-check de infraestructura) -- default 30h: cubre
 * un día calendario completo de margen sobre la cadencia diaria esperada.
 */
export async function getWorkeraSyncHealth(
  deps: { supabaseAdmin?: SupabaseClient<Database> } = {},
  staleAfterHours = 30
): Promise<WorkeraSyncHealth> {
  const supabaseAdmin = deps.supabaseAdmin ?? createAdminClient();

  const [{ data: successRows }, { data: failureRows }, { data: runningRows }] = await Promise.all([
    supabaseAdmin
      .from("sync_runs")
      .select("id, target_period_start, finished_at")
      .eq("company_id", WORKERA_COMPANY_ID)
      .eq("status", "SUCCEEDED")
      .order("finished_at", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("sync_runs")
      .select("id, target_period_start, finished_at, error_category")
      .eq("company_id", WORKERA_COMPANY_ID)
      .eq("status", "FAILED")
      .order("started_at", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("sync_runs")
      .select("id, target_period_start, started_at")
      .eq("company_id", WORKERA_COMPANY_ID)
      .eq("status", "RUNNING")
      .order("started_at", { ascending: false }),
  ]);

  const lastSuccess = successRows?.[0]
    ? {
        syncRunId: successRows[0].id,
        targetDate: successRows[0].target_period_start ?? "",
        finishedAt: successRows[0].finished_at ?? "",
      }
    : null;

  const lastFailure = failureRows?.[0]
    ? {
        syncRunId: failureRows[0].id,
        targetDate: failureRows[0].target_period_start ?? "",
        finishedAt: failureRows[0].finished_at,
        errorCategory: failureRows[0].error_category,
      }
    : null;

  const currentlyRunning = (runningRows ?? []).map((r) => ({
    syncRunId: r.id,
    targetDate: r.target_period_start ?? "",
    startedAt: r.started_at,
  }));

  let status: WorkeraSyncHealthStatus;
  if (currentlyRunning.length > 0) {
    status = "RUNNING";
  } else if (!lastSuccess) {
    status = "UNKNOWN";
  } else {
    const hoursSinceSuccess = (Date.now() - new Date(lastSuccess.finishedAt).getTime()) / 3_600_000;
    if (hoursSinceSuccess > staleAfterHours) {
      status = "STALE";
    } else if (lastFailure && lastFailure.finishedAt && lastFailure.finishedAt > lastSuccess.finishedAt) {
      status = "DEGRADED";
    } else {
      status = "HEALTHY";
    }
  }

  return { status, lastSuccess, lastFailure, currentlyRunning };
}
