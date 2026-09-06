import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpWorkeraClient } from "../workera/http-client";
import { createAdminClient } from "../supabase/admin-client";
import { getWorkeraConfig } from "../workera/config";
import type { NormalizedWorkeraAttendanceEvent } from "../workera/types/attendance-event";
import type { Database } from "../supabase/database.types";
import { classifySyncError, type SyncErrorCategory } from "./errors";
import { WorkeraConfigurationError } from "../workera/errors";

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
  /** Tenant explícito; nunca se infiere desde un default de esquema. */
  companyId: string;
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
  const companyId = params.companyId.trim();
  if (!companyId) {
    return {
      syncRunId: null,
      status: "FAILED",
      errorMessage: "companyId es obligatorio para sincronizar Workera.",
      errorCategory: "CONFIGURATION",
      ...emptyCounts(),
    };
  }

  const spanDays = daysBetween(params.startDate, params.endDate);
  if (!Number.isFinite(spanDays) || spanDays !== MAX_DAYS_PER_SYNC || params.startDate !== params.endDate) {
    return {
      syncRunId: null,
      status: "BLOCKED_RANGE_TOO_LARGE",
      errorMessage: `Rango solicitado (${spanDays} días) excede el máximo permitido en Fase 6A (${MAX_DAYS_PER_SYNC} día). Backfill masivo histórico queda fuera de alcance de esta fase.`,
      errorCategory: "CONFIGURATION",
      ...emptyCounts(),
    };
  }

  const supabaseAdmin = deps.supabaseAdmin ?? createAdminClient("workera-attendance-sync");

  // El lease se abre ANTES de consultar Workera. Así un timeout, payload
  // inválido o identidad irresoluble queda registrado como último intento
  // FAILED y no permite que cierre reutilice una sincronización antigua.
  let syncRun: { id: string } | null = null;
  if (!dryRun) {
    const { data, error } = await supabaseAdmin.rpc("begin_workera_sync_run", {
      p_company_id: companyId,
      p_period_start: params.startDate,
      p_period_end: params.endDate,
      p_triggered_by: params.triggeredBy ?? "MANUAL",
      p_attempt: params.attempt ?? 1,
      p_retry_of: params.retryOf ?? null,
    });

    if (error) {
      return {
        syncRunId: null,
        status: "FAILED",
        errorMessage: `Fallo creando sync_run: ${error.message}`,
        errorCategory: "DATABASE",
        ...emptyCounts(),
      };
    }
    if (typeof data !== "string") {
      return {
        syncRunId: null,
        status: "ALREADY_RUNNING",
        errorMessage: "Ya existe una sincronización o recálculo en curso para este día.",
        errorCategory: "CONCURRENCY",
        ...emptyCounts(),
      };
    }
    syncRun = { id: data };
  }

  async function finishRun(
    status: "SUCCEEDED" | "FAILED",
    patch: Database["public"]["Tables"]["sync_runs"]["Update"]
  ): Promise<{ ok: boolean; error: string | null }> {
    if (!syncRun) return { ok: true, error: null };
    const { data, error } = await supabaseAdmin.rpc("finish_workera_sync_run", {
      p_company_id: companyId,
      p_sync_run_id: syncRun.id,
      p_status: status,
      p_records_read: patch.records_read ?? 0,
      p_records_created: patch.records_created ?? 0,
      p_records_updated: patch.records_updated ?? 0,
      p_records_unchanged: patch.records_unchanged ?? 0,
      p_error_summary: patch.error_summary ?? null,
      p_error_category: patch.error_category ?? null,
    });
    if (error) return { ok: false, error: error.message };
    if (data !== true) return { ok: false, error: "la corrida perdió su lease" };
    return { ok: true, error: null };
  }

  // 1) Fetch completo (todas las páginas).
  let events: NormalizedWorkeraAttendanceEvent[];
  let pagesFetched: number;
  try {
    const workeraClient =
      deps.workeraClient ??
      (() => {
        const config = getWorkeraConfig();
        if (config.provider !== "http" || !config.baseUrl || !config.apiUser || !config.apiKey) {
          throw new WorkeraConfigurationError(
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
    const fetched = await workeraClient.getAllAttendanceEvents({ start: params.startDate, end: params.endDate });
    events = fetched.events;
    pagesFetched = fetched.pagesFetched;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fallo desconocido consultando Workera.";
    const category = classifySyncError(err);
    const finished = await finishRun("FAILED", {
      records_read: 0,
      error_summary: { message },
      error_category: category,
    });
    return {
      syncRunId: syncRun?.id ?? null,
      status: "FAILED",
      errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
      errorCategory: category,
      ...emptyCounts(),
    };
  }

  const seenFingerprints = new Set<string>();
  const invalidRangeEvent = events.find(
    (event) =>
      event.attendanceTimestampRaw.slice(0, 10) !== params.startDate ||
      event.attendanceTimestampRaw.slice(0, 10) !== params.endDate
  );
  const duplicateFingerprint = events.find((event) => {
    const fingerprint = buildFingerprint(
      event.employeeExternalId,
      event.attendanceTimestampRaw,
      event.attendanceTypeCode,
      event.originCode
    );
    if (seenFingerprints.has(fingerprint)) return true;
    seenFingerprints.add(fingerprint);
    return false;
  });
  if (invalidRangeEvent || duplicateFingerprint) {
    const message = invalidRangeEvent
      ? "Workera devolvió una marcación fuera del día solicitado."
      : "Workera devolvió una marcación duplicada entre páginas.";
    const finished = await finishRun("FAILED", {
      records_read: events.length,
      error_summary: { message },
      error_category: "WORKERA_PAYLOAD",
    });
    return {
      syncRunId: syncRun?.id ?? null,
      status: "FAILED",
      errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
      errorCategory: "WORKERA_PAYLOAD",
      ...emptyCounts(),
      pagesFetched,
      eventsFetched: events.length,
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
    const message = `${employeesWithBlankCode.length} evento(s) sin employee.code -- no se puede resolver identidad, no se persiste nada.`;
    const finished = await finishRun("FAILED", {
      records_read: events.length,
      error_summary: { message },
      error_category: "EMPLOYEE_RESOLUTION",
    });
    return {
      syncRunId: syncRun?.id ?? null,
      status: "BLOCKED_UNRESOLVED_EMPLOYEES",
      errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
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
    .eq("company_id", companyId)
    .in("external_workera_id", distinctCodes.length > 0 ? distinctCodes : ["__none__"]);

  if (employeesLookupError) {
    const message = `Fallo consultando employees existentes: ${employeesLookupError.message}`;
    const finished = await finishRun("FAILED", {
      records_read: events.length,
      error_summary: { message },
      error_category: "DATABASE",
    });
    return {
      syncRunId: syncRun?.id ?? null,
      status: "FAILED",
      errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
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
      company_id: companyId,
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
      const message = `Fallo creando empleados nuevos (bootstrap): ${bootstrapError.message}`;
      const finished = await finishRun("FAILED", {
        records_read: events.length,
        error_summary: { message },
        error_category: "DATABASE",
      });
      return {
        syncRunId: syncRun?.id ?? null,
        status: "FAILED",
        errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
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
    .select(
      "id, employee_id, external_fingerprint, attendance_type_label, attendance_status, external_attendance_status, checksum, device_name, origin, origin_code, source_version"
    )
    .in("external_fingerprint", fingerprints.length > 0 ? fingerprints : ["__none__"])
    .eq("company_id", companyId)
    .eq("is_current", true);

  if (existingLookupError) {
    const message = `Fallo consultando eventos vigentes existentes: ${existingLookupError.message}`;
    const finished = await finishRun("FAILED", {
      records_read: events.length,
      error_summary: { message },
      error_category: "DATABASE",
    });
    return {
      syncRunId: syncRun?.id ?? null,
      status: "FAILED",
      errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
      errorCategory: "DATABASE",
      ...emptyCounts(),
      pagesFetched,
      eventsFetched: events.length,
    };
  }

  const existingByFingerprint = new Map((existingCurrentRows ?? []).map((r) => [r.external_fingerprint, r]));

  const toInsert: NormalizedWorkeraAttendanceEvent[] = [];
  const toVersion: NormalizedWorkeraAttendanceEvent[] = [];
  let unchangedCount = 0;

  for (const event of events) {
    const fp = buildFingerprint(event.employeeExternalId, event.attendanceTimestampRaw, event.attendanceTypeCode, event.originCode);
    const existing = existingByFingerprint.get(fp);

    if (!existing) {
      toInsert.push(event);
      continue;
    }

    const changed =
      existing.employee_id !== codeToEmployeeId.get(event.employeeExternalId) ||
      existing.attendance_type_label !== event.attendanceTypeLabel ||
      existing.attendance_status !== event.attendanceStatus ||
      existing.external_attendance_status !== event.externalAttendanceStatus ||
      existing.checksum !== event.checksum ||
      existing.device_name !== event.deviceName ||
      existing.origin !== event.origin ||
      existing.origin_code !== event.originCode;

    if (changed) {
      toVersion.push(event);
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

  // 4) Persistencia real. Cada evento se reconcilia dentro de UNA transacción
  // PostgreSQL y el RPC vuelve a comprobar tenant + lease. Un proceso
  // reclamado o una carrera con el motor no puede seguir escribiendo.
  try {
    let inserted = 0;
    let versioned = 0;
    let unchanged = 0;
    for (const event of events) {
      const employeeId = codeToEmployeeId.get(event.employeeExternalId);
      if (!employeeId || !syncRun) {
        throw new Error(`No se resolvió el trabajador para la ficha ${event.employeeExternalId}.`);
      }
      const { data, error } = await supabaseAdmin.rpc("upsert_workera_attendance_event", {
        p_company_id: companyId,
        p_sync_run_id: syncRun.id,
        p_employee_id: employeeId,
        p_external_employee_code: event.employeeExternalId,
        p_attendance_timestamp_raw: event.attendanceTimestampRaw,
        p_attendance_type_code: event.attendanceTypeCode,
        p_attendance_type_label: event.attendanceTypeLabel,
        p_attendance_status: event.attendanceStatus,
        p_external_attendance_status: event.externalAttendanceStatus,
        p_origin: event.origin,
        p_origin_code: event.originCode,
        p_device_name: event.deviceName,
        p_checksum: event.checksum,
      });
      if (error) throw new Error(`Fallo reconciliando evento Workera: ${error.message}`);
      if (data === "INSERTED") inserted += 1;
      else if (data === "VERSIONED") versioned += 1;
      else if (data === "UNCHANGED") unchanged += 1;
      else throw new Error(`Respuesta inesperada al reconciliar evento Workera: ${String(data)}`);
    }

    const finished = await finishRun("SUCCEEDED", {
      records_read: events.length,
      records_created: inserted,
      records_updated: versioned,
      records_unchanged: unchanged,
      error_summary: null,
      error_category: null,
    });
    if (!finished.ok) throw new Error(`No se pudo confirmar SUCCEEDED: ${finished.error}`);

    const completedRunId = syncRun?.id;
    if (!completedRunId) throw new Error("La corrida no conserva un lease válido al finalizar.");

    return {
      syncRunId: completedRunId,
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
      inserted,
      versioned,
      unchanged,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fallo desconocido durante la persistencia.";
    const finished = await finishRun("FAILED", {
      records_read: events.length,
      error_summary: { message },
      error_category: "DATABASE",
    });

    return {
      syncRunId: syncRun?.id ?? null,
      status: "FAILED",
      errorMessage: finished.ok ? message : `${message}; además no se pudo cerrar la corrida: ${finished.error}`,
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
