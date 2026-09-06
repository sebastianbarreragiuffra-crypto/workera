import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * Seed administrativo ÚNICO (Fase 7, PASO 5-8) para las excepciones de
 * horario/control-horario confirmadas explícitamente por el negocio para
 * trabajadores reales nombrados. Los nombres se usan SOLO aquí, en tiempo
 * de seed, para resolver un employee_id de forma segura -- el motor de
 * reglas en sí (schedule.ts, late-arrival.ts, etc.) nunca compara nombres,
 * solo usa las filas que este seed produce.
 *
 * Resolución EXACTA (normalizada por trim + mayúsculas), NUNCA fuzzy. Si un
 * nombre no resuelve a exactamente un empleado, esa excepción puntual queda
 * UNRESOLVED y se reporta -- el resto del seed continúa sin bloquearse.
 */

export interface SeedKnownSchedulesResult {
  resolved: { label: string; employeeId: string; action: string }[];
  unresolved: { label: string; matchCount: number }[];
}

async function resolveExactlyOneEmployee(
  supabase: SupabaseClient<Database>,
  companyId: string,
  firstNameContains: string,
  lastNameContains: string
): Promise<{ id: string } | { matchCount: number }> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, first_name, last_name")
    .eq("company_id", companyId)
    .ilike("first_name", `%${firstNameContains}%`)
    .ilike("last_name", `%${lastNameContains}%`);

  if (error) throw new Error(`resolveExactlyOneEmployee: fallo consultando employees: ${error.message}`);
  if (!data || data.length !== 1) return { matchCount: data?.length ?? 0 };
  return { id: data[0].id };
}

async function ensureIndividualSchedule(
  supabase: SupabaseClient<Database>,
  companyId: string,
  name: string,
  rules: { dayOfWeek: number; start: string | null; end: string | null }[]
): Promise<string> {
  const { data: existing, error: existingError } = await supabase
    .from("work_schedules")
    .select("id")
    .eq("company_id", companyId)
    .eq("active", true)
    .eq("name", name)
    .maybeSingle();
  if (existingError) throw new Error(`ensureIndividualSchedule: fallo consultando work_schedules: ${existingError.message}`);
  if (existing) return existing.id;

  const { data: createdId, error: createError } = await supabase.rpc("upsert_work_schedule", {
    p_company_id: companyId,
    p_schedule_id: null as unknown as string,
    p_name: name,
    p_rules: rules.map((r) => ({
      day_of_week: r.dayOfWeek,
      scheduled_start: r.start ?? "",
      scheduled_end: r.end ?? "",
    })),
  });
  if (createError || !createdId) {
    throw new Error(`ensureIndividualSchedule: fallo creando work_schedules: ${createError?.message ?? "sin id"}`);
  }

  return createdId;
}

async function assignSchedule(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  workScheduleId: string,
  effectiveFrom: string
): Promise<void> {
  // El historial es append-only para el cliente. El RPC cierra la vigencia en
  // effectiveFrom - 1, valida empresa/versión activa y registra confirmación.
  const { error } = await supabase.rpc("apply_schedule_assignment", {
    p_employee_id: employeeId,
    p_work_schedule_id: workScheduleId,
    p_effective_from: effectiveFrom,
  });
  if (error) throw new Error(`assignSchedule: fallo insertando schedule_assignments: ${error.message}`);
}

async function assignExemption(
  supabase: SupabaseClient<Database>,
  employeeId: string,
  legalBasis: "NO_MARKING_REQUIRED" | "ARTICLE_22",
  effectiveFrom: string,
  createdBy: string,
  reason: string
): Promise<void> {
  const { data: existing } = await supabase
    .from("employee_time_control_policies")
    .select("id")
    .eq("employee_id", employeeId)
    .is("effective_to", null)
    .maybeSingle();
  if (existing) return;

  const { error } = await supabase.rpc("set_time_control_exemption", {
    p_employee_id: employeeId,
    p_legal_basis: legalBasis,
    p_effective_from: effectiveFrom,
    p_reason: reason,
    p_actor_id: createdBy,
  });
  if (error) throw new Error(`assignExemption: fallo confirmando la exención de control horario: ${error.message}`);
}

/**
 * `companyId`: empresa laboral explícita; el dominio no depende del resolver
 * de tenant de plataforma. `effectiveFrom`: fecha desde la que rigen las excepciones (inyectada, no
 * `new Date()` interno). `createdBy`: profile.id de quien ejecuta el seed
 * (ADMIN_RRHH real; SUPER_ADMIN conserva solo lectura técnica).
 */
export async function seedKnownScheduleExceptions(
  supabase: SupabaseClient<Database>,
  companyId: string,
  effectiveFrom: string,
  createdBy: string
): Promise<SeedKnownSchedulesResult> {
  const resolved: SeedKnownSchedulesResult["resolved"] = [];
  const unresolved: SeedKnownSchedulesResult["unresolved"] = [];

  // --- Alejandro Valencia: L-J 08:30-18:00, V 08:30-15:50 ---
  const alejandro = await resolveExactlyOneEmployee(supabase, companyId, "ALEJANDRO", "VALENCIA");
  if ("id" in alejandro) {
    const scheduleId = await ensureIndividualSchedule(supabase, companyId, "Horario individual — Alejandro Valencia", [
      { dayOfWeek: 1, start: "08:30:00", end: "18:00:00" },
      { dayOfWeek: 2, start: "08:30:00", end: "18:00:00" },
      { dayOfWeek: 3, start: "08:30:00", end: "18:00:00" },
      { dayOfWeek: 4, start: "08:30:00", end: "18:00:00" },
      { dayOfWeek: 5, start: "08:30:00", end: "15:50:00" },
    ]);
    await assignSchedule(supabase, alejandro.id, scheduleId, effectiveFrom);
    resolved.push({ label: "Alejandro Valencia", employeeId: alejandro.id, action: "schedule_assignment" });
  } else {
    unresolved.push({ label: "Alejandro Valencia", matchCount: alejandro.matchCount });
  }

  // --- María Vera: L-J 08:00-17:30, V 08:00-15:20 ---
  const maria = await resolveExactlyOneEmployee(supabase, companyId, "MARIA", "VERA");
  if ("id" in maria) {
    const scheduleId = await ensureIndividualSchedule(supabase, companyId, "Horario individual — María Vera", [
      { dayOfWeek: 1, start: "08:00:00", end: "17:30:00" },
      { dayOfWeek: 2, start: "08:00:00", end: "17:30:00" },
      { dayOfWeek: 3, start: "08:00:00", end: "17:30:00" },
      { dayOfWeek: 4, start: "08:00:00", end: "17:30:00" },
      { dayOfWeek: 5, start: "08:00:00", end: "15:20:00" },
    ]);
    await assignSchedule(supabase, maria.id, scheduleId, effectiveFrom);
    resolved.push({ label: "María Vera", employeeId: maria.id, action: "schedule_assignment" });
  } else {
    unresolved.push({ label: "María Vera", matchCount: maria.matchCount });
  }

  // --- Claudio Andrés Barrera: exento, sin marcación ---
  const claudio = await resolveExactlyOneEmployee(supabase, companyId, "CLAUDIO", "BARRERA");
  if ("id" in claudio) {
    await assignExemption(
      supabase,
      claudio.id,
      "NO_MARKING_REQUIRED",
      effectiveFrom,
      createdBy,
      "No realiza clock-in/clock-out (Fase 7, PASO 7 del encargo)."
    );
    resolved.push({ label: "Claudio Andrés Barrera", employeeId: claudio.id, action: "time_control_exemption" });
  } else {
    unresolved.push({ label: "Claudio Andrés Barrera", matchCount: claudio.matchCount });
  }

  // --- Michel Mendy: Artículo 22 ---
  const michel = await resolveExactlyOneEmployee(supabase, companyId, "MICHEL", "MENDY");
  if ("id" in michel) {
    await assignExemption(
      supabase,
      michel.id,
      "ARTICLE_22",
      effectiveFrom,
      createdBy,
      "Sujeto a Artículo 22 (Fase 7, PASO 8 del encargo)."
    );
    resolved.push({ label: "Michel Mendy", employeeId: michel.id, action: "time_control_exemption" });
  } else {
    unresolved.push({ label: "Michel Mendy", matchCount: michel.matchCount });
  }

  return { resolved, unresolved };
}
