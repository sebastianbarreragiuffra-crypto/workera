import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import type { HttpWorkeraClient } from "../workera/http-client";
import type { NormalizedWorkeraEmployeeRosterEntry } from "../workera/types/employee-roster";
import { normalizeName } from "./name-matching";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reconciliación del roster de empleados (Pre-Fase-8, extendida en la fase
 * de "roster bootstrap" -- ver `personnel-roster-import.ts`). Resuelve el
 * hallazgo de Fase 7: un trabajador que nunca genera eventos de asistencia
 * (exento de marcación) nunca aparece vía `workera_attendance_events`/
 * `syncWorkeraAttendance` -- ahora se usa `GET /employee` (roster completo,
 * confirmado real en esta fase) para completar `employees` antes de volver
 * a intentar resolver esos casos.
 *
 * Jerarquía de matching (orden de prioridad, nunca fuzzy):
 *   1. `employees.external_workera_id` ya existente (coincide con
 *      `roster.code` -- mismo espacio de identificador que
 *      `employee.code` de attendanceData). Si Workera entrega un estado
 *      laboral conocido, también se sincroniza `employees.active` usando
 *      ese identificador estable; nunca se reconcilia vigencia por nombre.
 *   2. Un empleado ACTIVO `source='excel_roster'` o
 *      `source='local_provisional'`
 *      (bootstrap administrativo, ver `personnel-roster-import.ts`) SIN vínculo real a Workera todavía,
 *      con nombre completo EXACTO normalizado y sin otro código Workera con
 *      ese mismo nombre -- se "promueve" (se le
 *      asigna el `external_workera_id` real y pasa a `source='workera'`,
 *      la fuente de mayor confianza) EN VEZ de crear una fila duplicada.
 *      Límite real documentado: `GET /employee` no expone RUT a esta capa
 *      (`mapWorkeraEmployeeRosterEntry` lo descarta deliberadamente, misma
 *      decisión de minimización de datos Pre-Fase-8) -- si lo expusiera,
 *      la promoción podría hacerse por RUT (igual de alta confianza que en
 *      el bootstrap de Excel) en vez de depender del nombre exacto. Esto
 *      queda documentado como una decisión de negocio pendiente de
 *      confirmar (ver reporte de la fase de roster bootstrap), no una
 *      limitación técnica que se pueda resolver aquí sin esa decisión.
 *   3. Si el nombre es ambiguo, aparece en dos códigos Workera o la ficha
 *      remota está INACTIVA, NUNCA se elige/desactiva una fila administrativa
 *      por nombre. Se crea la identidad Workera separada y se reporta en
 *      `reconciliationRequired` para revisión manual.
 *   4. Si nada de lo anterior resuelve de forma única -> se bootstrapea una
 *      fila nueva `source='workera'` sólo con ACTIVO/INACTIVO confirmado.
 *      Si cualquier estado es desconocido, el preflight bloquea todo el lote
 *      antes de consultar o escribir la base: nunca se aplica parcialmente ni
 *      se deja que el default `active=true` invente vigencia.
 */

export interface RosterReconciliationRequired {
  rosterCode: string;
  matchedNames: string[];
}

export interface BootstrapRosterResult {
  totalRosterEmployees: number;
  alreadyExisting: number;
  newlyBootstrapped: number;
  promotedToWorkera: number;
  /** @deprecated Usa promotedToWorkera; se conserva para compatibilidad de consumidores anteriores. */
  promotedFromExcelRoster: number;
  reconciliationRequired: RosterReconciliationRequired[];
  /** Códigos únicos cuyo employeeStatus fue interpretado como ACTIVO. */
  workeraActiveCount: number;
  /** Códigos únicos cuyo employeeStatus fue interpretado como INACTIVO. */
  workeraInactiveCount: number;
  /** Códigos únicos con employeeStatus nulo, vacío o no reconocido. En una ejecución exitosa siempre es cero: el preflight falla cerrado. */
  unknownStatusCount: number;
  /** Filas existentes cuyo `active` cambió por un estado conocido de Workera. */
  statusUpdatedCount: number;
  /** Filas existentes que ya tenían el `active` indicado por Workera. */
  statusUnchangedCount: number;
  /** Alias conservado para consumidores anteriores; el preflight actual bloquea todo el lote y nunca aplica parcialmente. */
  skippedUnknownStatusCount: number;
  /** Entradas repetidas con el mismo código y estado compatible que se deduplicaron. */
  duplicateRosterCount: number;
}

/**
 * Única traducción autorizada desde `employeeStatus` de Workera al booleano
 * local. El endpoint real entregó ACTIVO/INACTIVO; cualquier otro valor se
 * conserva como desconocido (`null`) y jamás se convierte implícitamente en
 * activo o inactivo.
 */
export function activeFromWorkeraEmployeeStatus(employeeStatus: string | null): boolean | null {
  const normalizedStatus = employeeStatus?.trim().toUpperCase();
  if (normalizedStatus === "ACTIVO") return true;
  if (normalizedStatus === "INACTIVO") return false;
  return null;
}

interface ClassifiedRosterEntry {
  entry: NormalizedWorkeraEmployeeRosterEntry;
  active: boolean | null;
}

function normalizedRosterIdentityName(entry: NormalizedWorkeraEmployeeRosterEntry): string {
  return normalizeName(
    [entry.firstName?.trim(), entry.lastName?.trim()]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  );
}

/**
 * Deduplica por el identificador estable antes de cualquier escritura. Si el
 * proveedor contradice la vigencia conocida de un mismo código, aborta todo
 * el lote: elegir ACTIVO o INACTIVO por orden de llegada sería arbitrario.
 * Un estado conocido puede completar otra copia sin estado, pero nunca se
 * inventa el estado de una entrada cuando todas sus copias son desconocidas.
 */
function classifyUniqueRosterEntries(roster: NormalizedWorkeraEmployeeRosterEntry[]): {
  entries: ClassifiedRosterEntry[];
  duplicateRosterCount: number;
} {
  const byCode = new Map<string, ClassifiedRosterEntry>();
  let duplicateRosterCount = 0;

  for (const rawEntry of roster) {
    const code = rawEntry.code.trim();
    if (!code) {
      throw new Error("bootstrapEmployeesFromRoster: Workera entregó una ficha sin código válido; no se aplicó ningún cambio.");
    }
    const entry = code === rawEntry.code ? rawEntry : { ...rawEntry, code };
    const active = activeFromWorkeraEmployeeStatus(entry.employeeStatus);
    const previous = byCode.get(entry.code);
    if (!previous) {
      byCode.set(entry.code, { entry, active });
      continue;
    }

    duplicateRosterCount += 1;
    if (previous.active !== null && active !== null && previous.active !== active) {
      throw new Error("bootstrapEmployeesFromRoster: Workera entregó estados ACTIVO/INACTIVO contradictorios para un mismo código; no se aplicó ningún cambio.");
    }
    if (normalizedRosterIdentityName(previous.entry) !== normalizedRosterIdentityName(entry)) {
      throw new Error("bootstrapEmployeesFromRoster: Workera entregó nombres normalizados contradictorios para un mismo código; no se aplicó ningún cambio.");
    }
    if (previous.active === null && active !== null) {
      byCode.set(entry.code, { entry, active });
    }
  }

  return { entries: [...byCode.values()], duplicateRosterCount };
}

interface WorkeraRosterStatusUpdate {
  [key: string]: string | boolean;
  id: string;
  external_workera_id: string;
  prior_active: boolean;
  prior_updated_at: string;
  active: boolean;
}

interface WorkeraRosterPromotion {
  [key: string]: string | boolean;
  id: string;
  prior_external_workera_id: string;
  external_workera_id: string;
  prior_active: boolean;
  prior_updated_at: string;
  active: boolean;
}

interface WorkeraRosterInsert {
  [key: string]: string | boolean;
  external_workera_id: string;
  first_name: string;
  last_name: string;
  display_name: string;
  active: boolean;
}

function readAppliedCounts(value: unknown): {
  statusUpdatedCount: number;
  promotedCount: number;
  insertedCount: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bootstrapEmployeesFromRoster: la base no devolvió el resumen esperado de la conciliación.");
  }
  const record = value as Record<string, unknown>;
  const statusUpdatedCount = record.status_updated_count;
  const promotedCount = record.promoted_count;
  const insertedCount = record.inserted_count;
  if (
    !Number.isInteger(statusUpdatedCount) || Number(statusUpdatedCount) < 0 ||
    !Number.isInteger(promotedCount) || Number(promotedCount) < 0 ||
    !Number.isInteger(insertedCount) || Number(insertedCount) < 0
  ) {
    throw new Error("bootstrapEmployeesFromRoster: la base devolvió conteos inválidos para la conciliación.");
  }
  return {
    statusUpdatedCount: Number(statusUpdatedCount),
    promotedCount: Number(promotedCount),
    insertedCount: Number(insertedCount),
  };
}

/**
 * Trae el roster COMPLETO (todas las páginas, GET /employee sin filtrar) y
 * concilia contra `employees`: código ya existente -> sincroniza `active`
 * sólo cuando employeeStatus es ACTIVO/INACTIVO; nombre exacto coincide con
 * UN empleado `excel_roster` sin vincular -> promueve (nunca duplica); si no
 * -> prepara una fila nueva únicamente cuando conoce su vigencia. El plan
 * completo se aplica mediante un único RPC transaccional y serializado por
 * empresa; no hay promociones o bajas parciales. Mismo
 * criterio de minimización de Fase 6A/Pre-8: solo external_workera_id/
 * first_name/last_name/display_name/active -- nunca RUT/fecha de nacimiento/
 * teléfono/correo/dirección, aunque el roster los entregara.
 */
export async function bootstrapEmployeesFromRoster(
  supabase: SupabaseClient<Database>,
  workeraClient: HttpWorkeraClient,
  companyId: string
): Promise<BootstrapRosterResult> {
  if (!UUID_PATTERN.test(companyId)) {
    throw new Error("bootstrapEmployeesFromRoster: companyId inválido.");
  }
  const { employees: roster } = await workeraClient.getAllEmployeeRoster();
  const { entries: classifiedRoster, duplicateRosterCount } = classifyUniqueRosterEntries(roster);
  const unknownStatusCount = classifiedRoster.filter(({ active }) => active === null).length;
  if (unknownStatusCount > 0) {
    throw new Error(
      `bootstrapEmployeesFromRoster: Workera entregó ${unknownStatusCount} estado(s) de empleado no reconocido(s); no se aplicó ningún cambio.`,
    );
  }

  const { data: existing, error: existingError } = await supabase
    .from("employees")
    .select("id, external_workera_id, source, first_name, last_name, active, updated_at")
    .eq("company_id", companyId);
  if (existingError) {
    throw new Error(`bootstrapEmployeesFromRoster: fallo consultando employees existentes: ${existingError.message}`);
  }

  const existingByCode = new Map((existing ?? []).map((employee) => [employee.external_workera_id, employee]));
  const unlinkedAdministrativeRows = (existing ?? []).filter((e) => e.source === "excel_roster" || e.source === "local_provisional");

  const statusUpdates: WorkeraRosterStatusUpdate[] = [];
  const promotions: WorkeraRosterPromotion[] = [];
  const toInsert: WorkeraRosterInsert[] = [];
  const reconciliationRequired: RosterReconciliationRequired[] = [];
  let alreadyExisting = 0;
  let workeraActiveCount = 0;
  let workeraInactiveCount = 0;
  let statusUnchangedCount = 0;

  const remoteRosterNameCounts = new Map<string, number>();
  for (const { entry } of classifiedRoster) {
    const name = normalizedRosterIdentityName(entry);
    remoteRosterNameCounts.set(name, (remoteRosterNameCounts.get(name) ?? 0) + 1);
  }

  for (const { entry, active: workeraActive } of classifiedRoster) {
    if (workeraActive === true) workeraActiveCount += 1;
    else if (workeraActive === false) workeraInactiveCount += 1;
    // El preflight anterior garantiza que el lote no contiene null aquí.
    else throw new Error("bootstrapEmployeesFromRoster: estado Workera no reconocido después del preflight.");

    const existingEmployee = existingByCode.get(entry.code);
    if (existingEmployee) {
      alreadyExisting += 1;
      if (existingEmployee.source !== "workera") {
        reconciliationRequired.push({
          rosterCode: entry.code,
          matchedNames: [`${existingEmployee.first_name} ${existingEmployee.last_name}`],
        });
        continue;
      }
      if (existingEmployee.active === workeraActive) {
        statusUnchangedCount += 1;
        continue;
      }
      statusUpdates.push({
        id: existingEmployee.id,
        external_workera_id: entry.code,
        prior_active: existingEmployee.active,
        prior_updated_at: existingEmployee.updated_at,
        active: workeraActive,
      });
      continue;
    }

    const firstName = entry.firstName?.trim() || "(sin nombre Workera)";
    const lastName = entry.lastName?.trim() || "(sin apellido Workera)";
    const candidateName = normalizedRosterIdentityName(entry);
    const nameMatches = unlinkedAdministrativeRows.filter((e) => normalizeName(`${e.first_name} ${e.last_name}`) === candidateName);

    const uniqueRemoteName = remoteRosterNameCounts.get(candidateName) === 1;
    if (nameMatches.length === 1 && uniqueRemoteName && workeraActive) {
      promotions.push({
        id: nameMatches[0].id,
        prior_external_workera_id: nameMatches[0].external_workera_id,
        external_workera_id: entry.code,
        prior_active: nameMatches[0].active,
        prior_updated_at: nameMatches[0].updated_at,
        active: true,
      });
      continue;
    }

    if (nameMatches.length > 0) {
      reconciliationRequired.push({ rosterCode: entry.code, matchedNames: nameMatches.map((m) => `${m.first_name} ${m.last_name}`) });
    }

    toInsert.push({
      external_workera_id: entry.code,
      first_name: firstName,
      last_name: lastName,
      display_name: `${firstName} ${lastName}`.trim(),
      active: workeraActive,
    });
  }

  let applied = { statusUpdatedCount: 0, promotedCount: 0, insertedCount: 0 };
  if (statusUpdates.length + promotions.length + toInsert.length > 0) {
    const { data, error } = await supabase.rpc("apply_workera_roster_reconciliation", {
      p_company_id: companyId,
      p_status_updates: statusUpdates,
      p_promotions: promotions,
      p_insert_rows: toInsert,
    });
    if (error) {
      throw new Error(`bootstrapEmployeesFromRoster: fallo aplicando la conciliación atómica (no se guardó ningún cambio): ${error.message}`);
    }
    applied = readAppliedCounts(data);
    const plannedExistingRows = statusUpdates.length + promotions.length;
    if (
      applied.statusUpdatedCount > plannedExistingRows ||
      applied.promotedCount > promotions.length ||
      applied.insertedCount > toInsert.length
    ) {
      throw new Error("bootstrapEmployeesFromRoster: la base devolvió conteos incompatibles con el plan.");
    }
    statusUnchangedCount += plannedExistingRows - applied.statusUpdatedCount;
  }

  return {
    totalRosterEmployees: roster.length,
    alreadyExisting,
    newlyBootstrapped: applied.insertedCount,
    promotedToWorkera: applied.promotedCount,
    promotedFromExcelRoster: applied.promotedCount,
    reconciliationRequired,
    workeraActiveCount,
    workeraInactiveCount,
    unknownStatusCount,
    statusUpdatedCount: applied.statusUpdatedCount,
    statusUnchangedCount,
    skippedUnknownStatusCount: 0,
    duplicateRosterCount,
  };
}

export interface ResolveEmployeeByFullNameResult {
  resolved: boolean;
  employeeId: string | null;
  matchCount: number;
}

/**
 * Match EXACTO por nombre completo normalizado (nunca separado en
 * first/last -- el roster puede traer nombre/segundo-nombre y
 * apellido/segundo-apellido en combinaciones no siempre predecibles desde
 * afuera; comparar el nombre completo concatenado evita asumir dónde cae el
 * límite entre "nombre" y "apellido"). Si no hay EXACTAMENTE una
 * coincidencia, se reporta sin resolver -- nunca se adivina.
 *
 * `sourceEquals` opcional -- usado por `bootstrapEmployeesFromRoster` para
 * acotar la búsqueda solo a empleados `excel_roster` sin vincular todavía
 * (nunca reconciliar contra alguien ya confirmado por Workera).
 */
export async function resolveEmployeeByFullName(
  supabase: SupabaseClient<Database>,
  fullName: string,
  companyId: string,
  options?: { sourceEquals?: string }
): Promise<ResolveEmployeeByFullNameResult> {
  if (!UUID_PATTERN.test(companyId)) {
    throw new Error("resolveEmployeeByFullName: companyId inválido.");
  }
  let query = supabase
    .from("employees")
    .select("id, first_name, last_name")
    .eq("company_id", companyId);
  if (options?.sourceEquals) query = query.eq("source", options.sourceEquals);
  const { data, error } = await query;
  if (error) {
    throw new Error(`resolveEmployeeByFullName: fallo consultando employees: ${error.message}`);
  }

  const target = normalizeName(fullName);
  const matches = (data ?? []).filter((e) => normalizeName(`${e.first_name} ${e.last_name}`) === target);

  if (matches.length !== 1) {
    return { resolved: false, employeeId: null, matchCount: matches.length };
  }
  return { resolved: true, employeeId: matches[0].id, matchCount: 1 };
}
