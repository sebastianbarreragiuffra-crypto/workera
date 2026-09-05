import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpWorkeraClient } from "../workera/http-client";
import { createAdminClient } from "../supabase/admin-client";
import { getWorkeraConfig } from "../workera/config";
import type { NormalizedWorkeraAttendanceEvent } from "../workera/types/attendance-event";
import type { Database } from "../supabase/database.types";
import { classifySyncError, type SyncErrorCategory } from "./errors";

/**
 * Ingesta controlada Workera -> Supabase (Fase 6A). Orquesta:
 *
 *   GET /attendanceData (paginado completo)
 *     -> resolución de identidad de empleados (external_workera_id, sin
 *        heurísticas de nombre/apellido)
 *     -> clasificación insert/version/unchanged por fingerprint
 *     -> persistencia idempotente (workera_attendance_events + employees
 *        bootstrap mínimo + sync_runs)
 *
 * NUNCA calcula atrasos/horas extra/bonos, NUNCA colapsa eventos a
 * clock_in/clock_out, NUNCA escribe en Workera. Rango máximo por corrida:
 * 1 día (Fase 6A, PASO 21 — "no crear todavía backfill masivo histórico").
 */

const MAX_DAYS_PER_SYNC = 1;

export interface SyncWorkeraAttendanceParams {
  /** yyyy-MM-dd */
  startDate: string;
  /** yyyy-MM-dd */
  endDate: string;
  /** true = no persiste nada; calcula y reporta qué haría. Default false. */
  dryRun?: boolean;
  /** Quién dispara esta corrida (Fase 6B). Default "MANUAL" -- preserva el comportamiento de Fase 6A. */
  triggeredBy?: "CRON" | "MANUAL";
  /** Número de intento dentro de una secuencia de reintentos (Fase 6B). Default 1. */
  attempt?: number;
  /** sync_runs.id del intento anterior de la misma secuencia, si aplica (Fase 6B). */
  retryOf?: string | null;
}

export type SyncWorkeraAttendanceStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "DRY_RUN"
  | "BLOCKED_UNRESOLVED_EMPLOYEES"
  | "BLOCKED_RANGE_TOO_LARGE"
  /**
   * Ya existe un sync_run RUNNING para este mismo rango de fechas (Fase 6B,
   * PASO 10/50) -- rechazado por el índice único parcial
   * `sync_runs_no_concurrent_running_key`, nunca por un boolean en memoria.
   * No es un fallo del proceso que lo recibe: es la señal correcta de "otro
   * proceso ya está sincronizando este día, no dupliques el trabajo".
   */
  | "ALREADY_RUNNING";

export interface SyncWorkeraAttendanceResult {
  syncRunId: string | null;
  status: SyncWorkeraAttendanceStatus;
  errorMessage?: string;
  /** Poblado solo cuando status="FAILED" (Fase 6B, PASO 27) -- ver src/lib/sync/errors.ts. */
  errorCategory?: SyncErrorCategory;
  pagesFetched: number;
  eventsFetched: number;
  employeesDistinct: number;
  employeesResolvedExisting: number;
  employeesBootstrapped: number;
  employeesUnresolved: number;
  /** Códigos de ficha (no PII -- nunca nombre/RUT) de eventos con employee.code vacío/ausente, si los hay. */
  unresolvedEmployeeCodes: string[];
  wouldInsert: number;
  wouldVersion: number;
  wouldUnchanged: number;
  inserted: number;
  versioned: number;
  unchanged: number;
}

export interface SyncWorkeraAttendanceDeps {
  workeraClient?: HttpWorkeraClient;
  supabaseAdmin?: SupabaseClient<Database>;
}

function buildFingerprint(
  externalEmployeeCode: string,
  timestampRaw: string,
  typeCode: number,
  originCode: string | null
): string {
  return `WORKERA|${externalEmployeeCode}|${timestampRaw}|${typeCode}|${originCode ?? ""}`;
}

function daysBetween(start: string, end: string): number {
  const s = new Date(`${start}T00:00:00Z`).getTime();
  const e = new Date(`${end}T00:00:00Z`).getTime();
  return Math.round((e - s) / 86_400_000) + 1;
}

function emptyCounts(): Pick<
  SyncWorkeraAttendanceResult,
  | "pagesFetched"
  | "eventsFetched"
  | "employeesDistinct"
  | "employeesResolvedExisting"
  | "employeesBootstrapped"
  | "employeesUnresolved"
  | "unresolvedEmployeeCodes"
  | "wouldInsert"
  | "wouldVersion"
  | "wouldUnchanged"
  | "inserted"
  | "versioned"
  | "unchanged"
> {
  return {
    pagesFetched: 0,
    eventsFetched: 0,
    employeesDistinct: 0,
    employeesResolvedExisting: 0,
    employeesBootstrapped: 0,
    employeesUnresolved: 0,
    unresolvedEmployeeCodes: [],
    wouldInsert: 0,
    wouldVersion: 0,
    wouldUnchanged: 0,
    inserted: 0,
    versioned: 0,
    unchanged: 0,
  };
}

export async function syncWorkeraAttendance(
  params: SyncWorkeraAttendanceParams,
  deps: SyncWorkeraAttendanceDeps = {}
): Promise<SyncWorkeraAttendanceResult> {
  const dryRun = params.dryRun ?? false;

  const spanDays = daysBetween(params.startDate, params.endDate);
  if (spanDays > MAX_DAYS_PER_SYNC) {
    return {
      syncRunId: null,
      status: "BLOCKED_RANGE_TOO_LARGE",
      errorMessage: `Rango solicitado (${spanDays} días) excede el máximo permitido en Fase 6A (${MAX_DAYS_PER_SYNC} día). Backfill masivo histórico queda fuera de alcance de esta fase.`,
      errorCategory: "CONFIGURATION",
      ...emptyCounts(),
    };
  }

  const workeraClient =
    deps.workeraClient ??
    (() => {
      const config = getWorkeraConfig();
      if (config.provider !== "http" || !config.baseUrl || !config.apiUser || !config.apiKey) {
        throw new Error(
          "syncWorkeraAttendance requiere WORKERA_PROVIDER=http con WORKERA_BASE_URL/WORKERA_API_USER/WORKERA_API_KEY configurados."
        );
      }
      return new HttpWorkeraClient({
        baseUrl: config.baseUrl,
        apiUser: config.apiUser,
        apiKey: config.apiKey,
        requestTimeoutMs: config.requestTimeoutMs,
      });
    })();

  const supabaseAdmin = deps.supabaseAdmin ?? createAdminClient("workera-attendance-sync");

  // 1) Fetch completo (todas las páginas).
  let events: NormalizedWorkeraAttendanceEvent[];
  let pagesFetched: number;
  try {
    const fetched = await workeraClient.getAllAttendanceEvents({ start: params.startDate, end: params.endDate });
    events = fetched.events;
    pagesFetched = fetched.pagesFetched;
  } catch (err) {
    return {
      syncRunId: null,
      status: "FAILED",
      errorMessage: err instanceof Error ? err.message : "Fallo desconocido consultando Workera.",
      errorCategory: classifySyncError(err),
      ...emptyCounts(),
    };
  }

  // 2) Identidad de empleados -- SOLO por employee.code == employees.external_workera_id,
  // nunca heurística de nombre/apellido (Fase 6A, PASO 6).
  const employeesWithBlankCode = events.filter((e) => !e.employeeExternalId || e.employeeExternalId.trim().length === 0);
  const distinctCodeMap = new Map<string, NormalizedWorkeraAttendanceEvent["employee"]>();
  for (const e of events) {
    if (e.employeeExternalId && e.employeeExternalId.trim().length > 0) {
      distinctCodeMap.set(e.employeeExternalId, e.employee);
    }
  }
  const distinctCodes = [...distinctCodeMap.keys()];

  if (employeesWithBlankCode.length > 0) {
    // Gate explícito (PASO 24): un evento sin employee.code no se puede
    // resolver de ninguna forma -- nunca se persiste nada de esta corrida.
    return {
      syncRunId: null,
      status: "BLOCKED_UNRESOLVED_EMPLOYEES",
      errorMessage: `${employeesWithBlankCode.length} evento(s) sin employee.code -- no se puede resolver identidad, no se persiste nada.`,
      errorCategory: "EMPLOYEE_RESOLUTION",
      ...emptyCounts(),
      pagesFetched,
      eventsFetched: events.length,
      employeesUnresolved: employeesWithBlankCode.length,
      unresolvedEmployeeCodes: ["(código vacío)"],
    };
  }

  const { data: existingEmployees, error: employeesLookupError } = await supabaseAdmin
    .from("employees")
    .select("id, external_workera_id")
    .in("external_workera_id", distinctCodes.length > 0 ? distinctCodes : ["__none__"]);

  if (employeesLookupError) {
    return {
      syncRunId: null,
      status: "FAILED",
      errorMessage: `Fallo consultando employees existentes: ${employeesLookupError.message}`,
      errorCategory: "DATABASE",
      ...emptyCounts(),
      pagesFetched,
      eventsFetched: events.length,
    };
  }

  const codeToEmployeeId = new Map<string, string>();
  for (const row of existingEmployees ?? []) {
    codeToEmployeeId.set(row.external_workera_id, row.id);
  }

  // Bootstrap: SOLO se crea una fila nueva para códigos que NO existen
  // todavía. Un empleado ya existente NUNCA se sobrescribe (Fase 6A, PASO
  // 10 -- "no hacer overwrite ciego de datos internos administrados
  // manualmente"). RUT deliberadamente no se puebla desde este pipeline
  // (minimización de datos, PASO 9).
  const missingCodes = distinctCodes.filter((c) => !codeToEmployeeId.has(c));
  const bootstrapRows = missingCodes.map((code) => {
    const detail = distinctCodeMap.get(code)!;
    const firstName = detail.name?.trim() || "(sin nombre Workera)";
    const lastName = detail.lastName?.trim() || "(sin apellido Workera)";
    return {
      external_workera_id: code,
      first_name: firstName,
      last_name: lastName,
      display_name: `${firstName} ${lastName}`.trim(),
    };
  });

  let employeesBootstrapped = 0;
  if (!dryRun && bootstrapRows.length > 0) {
    const { data: inserted, error: bootstrapError } = await supabaseAdmin
      .from("employees")
      .insert(bootstrapRows)
      .select("id, external_workera_id");

    if (bootstrapError) {
      return {
        syncRunId: null,
        status: "FAILED",
        errorMessage: `Fallo creando empleados nuevos (bootstrap): ${bootstrapError.message}`,
        errorCategory: "DATABASE",
        ...emptyCounts(),
        pagesFetched,
        eventsFetched: events.length,
      };
    }
    for (const row of inserted ?? []) {
      codeToEmployeeId.set(row.external_workera_id, row.id);
    }
    employeesBootstrapped = inserted?.length ?? 0;
  } else if (dryRun) {
    employeesBootstrapped = bootstrapRows.length;
  }

  // 3) Clasificar cada evento por fingerprint: insert / version / unchanged.
  const fingerprints = events.map((e) =>
    buildFingerprint(e.employeeExternalId, e.attendanceTimestampRaw, e.attendanceTypeCode, e.originCode)
  );

  const { data: existingCurrentRows, error: existingLookupError } = await supabaseAdmin
    .from("workera_attendance_events")
    .select("id, external_fingerprint, external_attendance_status, checksum, device_name, origin, origin_code, source_version")
    .in("external_fingerprint", fingerprints.length > 0 ? fingerprints : ["__none__"])
    .eq("is_current", true);

  if (existingLookupError) {
    return {
      syncRunId: null,
      status: "FAILED",
      errorMessage: `Fallo consultando eventos vigentes existentes: ${existingLookupError.message}`,
      errorCategory: "DATABASE",
      ...emptyCounts(),
      pagesFetched,
      eventsFetched: events.length,
    };
  }

  const existingByFingerprint = new Map((existingCurrentRows ?? []).map((r) => [r.external_fingerprint, r]));

  const toInsert: NormalizedWorkeraAttendanceEvent[] = [];
  const toVersion: { event: NormalizedWorkeraAttendanceEvent; existingId: string; nextVersion: number }[] = [];
  let unchangedCount = 0;

  for (const event of events) {
    const fp = buildFingerprint(event.employeeExternalId, event.attendanceTimestampRaw, event.attendanceTypeCode, event.originCode);
    const existing = existingByFingerprint.get(fp);

    if (!existing) {
      toInsert.push(event);
      continue;
    }

    const changed =
      existing.external_attendance_status !== event.externalAttendanceStatus ||
      existing.checksum !== event.checksum ||
      existing.device_name !== event.deviceName ||
      existing.origin !== event.origin ||
      existing.origin_code !== event.originCode;

    if (changed) {
      toVersion.push({ event, existingId: existing.id, nextVersion: existing.source_version + 1 });
    } else {
      unchangedCount += 1;
    }
  }

  const employeesResolvedExisting = distinctCodes.length - missingCodes.length;

  if (dryRun) {
    return {
      syncRunId: null,
      status: "DRY_RUN",
      pagesFetched,
      eventsFetched: events.length,
      employeesDistinct: distinctCodes.length,
      employeesResolvedExisting,
      employeesBootstrapped,
      employeesUnresolved: 0,
      unresolvedEmployeeCodes: [],
      wouldInsert: toInsert.length,
      wouldVersion: toVersion.length,
      wouldUnchanged: unchangedCount,
      inserted: 0,
      versioned: 0,
      unchanged: 0,
    };
  }

  // 4) Persistencia real. sync_runs registra el resultado; si algo falla a
  // mitad de camino, termina FAILED explícito (nunca SUCCEEDED parcial,
  // PASO 19 del encargo). Nota de diseño (riesgo residual documentado en
  // docs/WORKERA_SYNC_PHASE6A.md): supabase-js sobre PostgREST no ofrece una
  // transacción multi-tabla real desde el cliente; la protección efectiva
  // ante un fallo a mitad de camino es que CADA escritura es en sí misma
  // idempotente (el índice único de fingerprint vigente + el matching por
  // external_workera_id garantizan que reintentar la misma corrida nunca
  // duplica nada), no una atomicidad instantánea de Postgres.
  const { data: syncRun, error: syncRunError } = await supabaseAdmin
    .from("sync_runs")
    .insert({
      status: "RUNNING",
      target_period_start: params.startDate,
      target_period_end: params.endDate,
      triggered_by: params.triggeredBy ?? "MANUAL",
      attempt: params.attempt ?? 1,
      retry_of: params.retryOf ?? null,
    })
    .select("id")
    .single();

  if (syncRunError || !syncRun) {
    // 23505 = choca con el índice único parcial
    // sync_runs_no_concurrent_running_key (Fase 6B) -- ya hay un sync_run
    // RUNNING para este mismo rango. No es un fallo de este proceso: es la
    // señal correcta de "otro proceso ya está sincronizando este día".
    if (syncRunError?.code === "23505") {
      return {
        syncRunId: null,
        status: "ALREADY_RUNNING",
        errorMessage: "Ya existe una sincronización en curso para este rango de fechas.",
        errorCategory: "CONCURRENCY",
        pagesFetched,
        eventsFetched: events.length,
        employeesDistinct: distinctCodes.length,
        employeesResolvedExisting,
        employeesBootstrapped,
        employeesUnresolved: 0,
        unresolvedEmployeeCodes: [],
        wouldInsert: 0,
        wouldVersion: 0,
        wouldUnchanged: 0,
        inserted: 0,
        versioned: 0,
        unchanged: 0,
      };
    }
    return {
      syncRunId: null,
      status: "FAILED",
      errorMessage: `Fallo creando sync_run: ${syncRunError?.message ?? "sin fila devuelta"}`,
      errorCategory: "DATABASE",
      pagesFetched,
      eventsFetched: events.length,
      employeesDistinct: distinctCodes.length,
      employeesResolvedExisting,
      employeesBootstrapped,
      employeesUnresolved: 0,
      unresolvedEmployeeCodes: [],
      wouldInsert: 0,
      wouldVersion: 0,
      wouldUnchanged: 0,
      inserted: 0,
      versioned: 0,
      unchanged: 0,
    };
  }

  try {
    for (const { existingId } of toVersion) {
      const { error } = await supabaseAdmin
        .from("workera_attendance_events")
        .update({ is_current: false })
        .eq("id", existingId);
      if (error) throw new Error(`Fallo marcando versión anterior no vigente (${existingId}): ${error.message}`);
    }

    const rows = [
      ...toInsert.map((e) => ({
        employee_id: codeToEmployeeId.get(e.employeeExternalId)!,
        external_employee_code: e.employeeExternalId,
        work_date: e.attendanceTimestampRaw.slice(0, 10),
        attendance_timestamp_raw: e.attendanceTimestampRaw,
        attendance_type_code: e.attendanceTypeCode,
        attendance_type_label: e.attendanceTypeLabel,
        attendance_status: e.attendanceStatus,
        external_attendance_status: e.externalAttendanceStatus,
        origin: e.origin,
        origin_code: e.originCode,
        device_name: e.deviceName,
        checksum: e.checksum,
        source_version: 1,
        sync_run_id: syncRun.id as string,
      })),
      ...toVersion.map(({ event: e, nextVersion }) => ({
        employee_id: codeToEmployeeId.get(e.employeeExternalId)!,
        external_employee_code: e.employeeExternalId,
        work_date: e.attendanceTimestampRaw.slice(0, 10),
        attendance_timestamp_raw: e.attendanceTimestampRaw,
        attendance_type_code: e.attendanceTypeCode,
        attendance_type_label: e.attendanceTypeLabel,
        attendance_status: e.attendanceStatus,
        external_attendance_status: e.externalAttendanceStatus,
        origin: e.origin,
        origin_code: e.originCode,
        device_name: e.deviceName,
        checksum: e.checksum,
        source_version: nextVersion,
        sync_run_id: syncRun.id as string,
      })),
    ];

    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from("workera_attendance_events").insert(rows);
      if (error) throw new Error(`Fallo insertando eventos: ${error.message}`);
    }

    await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "SUCCEEDED",
        finished_at: new Date().toISOString(),
        records_read: events.length,
        records_created: toInsert.length,
        records_updated: toVersion.length,
        records_unchanged: unchangedCount,
      })
      .eq("id", syncRun.id);

    return {
      syncRunId: syncRun.id,
      status: "SUCCEEDED",
      pagesFetched,
      eventsFetched: events.length,
      employeesDistinct: distinctCodes.length,
      employeesResolvedExisting,
      employeesBootstrapped,
      employeesUnresolved: 0,
      unresolvedEmployeeCodes: [],
      wouldInsert: 0,
      wouldVersion: 0,
      wouldUnchanged: 0,
      inserted: toInsert.length,
      versioned: toVersion.length,
      unchanged: unchangedCount,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fallo desconocido durante la persistencia.";
    await supabaseAdmin
      .from("sync_runs")
      .update({
        status: "FAILED",
        finished_at: new Date().toISOString(),
        records_read: events.length,
        error_summary: { message },
        error_category: "DATABASE",
      })
      .eq("id", syncRun.id);

    return {
      syncRunId: syncRun.id,
      status: "FAILED",
      errorMessage: message,
      errorCategory: "DATABASE",
      pagesFetched,
      eventsFetched: events.length,
      employeesDistinct: distinctCodes.length,
      employeesResolvedExisting,
      employeesBootstrapped,
      employeesUnresolved: 0,
      unresolvedEmployeeCodes: [],
      wouldInsert: 0,
      wouldVersion: 0,
      wouldUnchanged: 0,
      inserted: 0,
      versioned: 0,
      unchanged: 0,
    };
  }
}
