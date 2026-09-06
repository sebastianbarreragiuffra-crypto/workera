import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

export const LOCAL_PROVISIONAL_CODE_PREFIX = "LOCAL-PROVISIONAL:";
export const CLAUDIO_BARRERA_PROVISIONAL_CODE = `${LOCAL_PROVISIONAL_CODE_PREFIX}CLAUDIO-BARRERA`;

export function isLocalProvisionalCode(value: string): boolean {
  return value.startsWith(LOCAL_PROVISIONAL_CODE_PREFIX);
}

export interface EnsureLocalProvisionalEmployeeResult {
  employeeId: string;
  created: boolean;
  temporaryCode: string;
}

/**
 * Crea o recupera de forma idempotente la ficha provisional autorizada de
 * Claudio. El prefijo reservado evita presentar el valor técnico como código
 * Workera real. No usa RUT ni intenta adivinar otra identidad.
 */
export async function ensureClaudioBarreraProvisional(
  supabase: SupabaseClient<Database>,
  companyId: string,
): Promise<EnsureLocalProvisionalEmployeeResult> {
  const { data: existing, error: existingError } = await supabase
    .from("employees")
    .select("id")
    .eq("company_id", companyId)
    .eq("source", "local_provisional")
    .eq("external_workera_id", CLAUDIO_BARRERA_PROVISIONAL_CODE)
    .maybeSingle();
  if (existingError) throw new Error(`ensureClaudioBarreraProvisional: fallo buscando ficha provisional: ${existingError.message}`);
  if (existing) return { employeeId: existing.id, created: false, temporaryCode: CLAUDIO_BARRERA_PROVISIONAL_CODE };

  const { data: group, error: groupError } = await supabase
    .from("employee_groups")
    .select("id")
    .eq("company_id", companyId)
    .eq("code", "ADMINISTRATION")
    .single();
  if (groupError || !group) throw new Error(`ensureClaudioBarreraProvisional: no se pudo resolver el grupo ADMINISTRATION: ${groupError?.message ?? "sin fila"}`);

  const { data: created, error: createError } = await supabase
    .from("employees")
    .insert({
      company_id: companyId,
      external_workera_id: CLAUDIO_BARRERA_PROVISIONAL_CODE,
      rut: null,
      first_name: "CLAUDIO",
      last_name: "BARRERA",
      display_name: "CLAUDIO BARRERA",
      employee_group_id: group.id,
      active: true,
      source: "local_provisional",
    })
    .select("id")
    .single();

  if (createError?.code === "23505") {
    const { data: concurrent, error: concurrentError } = await supabase
      .from("employees")
      .select("id")
      .eq("company_id", companyId)
      .eq("source", "local_provisional")
      .eq("external_workera_id", CLAUDIO_BARRERA_PROVISIONAL_CODE)
      .maybeSingle();
    if (!concurrentError && concurrent) {
      return { employeeId: concurrent.id, created: false, temporaryCode: CLAUDIO_BARRERA_PROVISIONAL_CODE };
    }
  }
  if (createError || !created) throw new Error(`ensureClaudioBarreraProvisional: fallo creando ficha provisional: ${createError?.message ?? "sin fila"}`);

  return { employeeId: created.id, created: true, temporaryCode: CLAUDIO_BARRERA_PROVISIONAL_CODE };
}

export interface ReconcileLocalProvisionalEmployeeResult {
  employeeId: string;
  reconciled: boolean;
  conflictEmployeeId: string | null;
}

/**
 * Promueve la misma fila provisional cuando RR.HH. obtiene identidad oficial.
 * Si el código/RUT ya pertenece a otra fila, falla cerrado y exige una fusión
 * humana; nunca crea una segunda persona.
 */
export async function reconcileLocalProvisionalEmployee(
  supabase: SupabaseClient<Database>,
  params: {
    companyId: string;
    employeeId: string;
    officialWorkeraId: string;
    rut?: string | null;
  },
): Promise<ReconcileLocalProvisionalEmployeeResult> {
  if (!params.officialWorkeraId.trim() || isLocalProvisionalCode(params.officialWorkeraId)) {
    throw new Error("La reconciliación exige un código Workera oficial, no una clave provisional.");
  }

  const { data: target, error: targetError } = await supabase
    .from("employees")
    .select("id, source, external_workera_id, rut")
    .eq("company_id", params.companyId)
    .eq("id", params.employeeId)
    .maybeSingle();
  if (targetError) throw new Error(`reconcileLocalProvisionalEmployee: fallo leyendo ficha: ${targetError.message}`);
  if (!target) throw new Error("La ficha provisional no existe en la empresa indicada.");
  if (target.source === "workera") {
    const sameCode = target.external_workera_id === params.officialWorkeraId;
    const sameRut = !params.rut || target.rut === params.rut;
    if (sameCode && sameRut) return { employeeId: target.id, reconciled: false, conflictEmployeeId: null };
    throw new Error("La ficha ya fue reconciliada con otra identidad oficial.");
  }
  if (target.source !== "local_provisional") throw new Error("La ficha indicada no tiene procedencia local provisional.");

  const { data: codeConflict, error: conflictError } = await supabase
    .from("employees")
    .select("id")
    .eq("company_id", params.companyId)
    .eq("external_workera_id", params.officialWorkeraId)
    .neq("id", params.employeeId)
    .maybeSingle();
  if (conflictError) throw new Error(`reconcileLocalProvisionalEmployee: fallo comprobando código oficial: ${conflictError.message}`);
  if (codeConflict) return { employeeId: params.employeeId, reconciled: false, conflictEmployeeId: codeConflict.id };

  if (params.rut) {
    const { data: rutConflict, error: rutConflictError } = await supabase
      .from("employees")
      .select("id")
      .eq("company_id", params.companyId)
      .eq("rut", params.rut)
      .neq("id", params.employeeId)
      .maybeSingle();
    if (rutConflictError) throw new Error(`reconcileLocalProvisionalEmployee: fallo comprobando RUT oficial: ${rutConflictError.message}`);
    if (rutConflict) return { employeeId: params.employeeId, reconciled: false, conflictEmployeeId: rutConflict.id };
  }

  const { data: updated, error: updateError } = await supabase
    .from("employees")
    .update({
      external_workera_id: params.officialWorkeraId,
      rut: params.rut ?? null,
      source: "workera",
    })
    .eq("company_id", params.companyId)
    .eq("id", params.employeeId)
    .eq("source", "local_provisional")
    .select("id")
    .single();
  if (updateError || !updated) throw new Error(`reconcileLocalProvisionalEmployee: fallo promoviendo ficha: ${updateError?.message ?? "sin fila"}`);

  return { employeeId: updated.id, reconciled: true, conflictEmployeeId: null };
}
