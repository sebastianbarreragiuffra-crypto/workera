import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";
import { ensureClaudioBarreraProvisional } from "../employees/local-provisional-employee";

/**
 * Seed administrativo ÚNICO (Fase 7, PASO 5-8) para las excepciones de
 * horario/control-horario confirmadas explícitamente por el negocio para
 * trabajadores reales nombrados. Los nombres se usan SOLO aquí, en tiempo
 * de seed, para resolver un employee_id de forma segura -- el motor de
 * reglas en sí (schedule.ts, late-arrival.ts, etc.) nunca compara nombres,
 * solo usa las filas que este seed produce.
 *
 * Michel y Pablo se resuelven por código Workera estable. Las dos asignaciones
 * históricas anteriores (Alejandro/María) conservan su resolución acotada y
 * sólo avanzan cuando devuelven una única ficha. Claudio usa la ficha local
 * provisional explícitamente autorizada y luego se reconcilia sobre esa misma
 * fila al recibir un identificador oficial.
 */

export interface SeedKnownSchedulesResult {
  resolved: { label: string; employeeId: string; action: string; effectiveFrom: string }[];
  unresolved: {
    label: string;
    matchCount: number;
    reason?: "IDENTITY_NOT_UNIQUE" | "STABLE_IDENTIFIER_REQUIRED" | "STABLE_IDENTIFIER_NOT_FOUND";
  }[];
}

export const ALEJANDRO_VALENCIA_SCHEDULE = [
  { dayOfWeek: 1, start: "08:30:00", end: "18:00:00" },
  { dayOfWeek: 2, start: "08:30:00", end: "18:00:00" },
  { dayOfWeek: 3, start: "08:30:00", end: "18:00:00" },
  { dayOfWeek: 4, start: "08:30:00", end: "18:00:00" },
  { dayOfWeek: 5, start: "08:30:00", end: "15:50:00" },
] as const;

export const MARIA_VERA_SCHEDULE = [
  { dayOfWeek: 1, start: "08:00:00", end: "17:30:00" },
  { dayOfWeek: 2, start: "08:00:00", end: "17:30:00" },
  { dayOfWeek: 3, start: "08:00:00", end: "17:30:00" },
  { dayOfWeek: 4, start: "08:00:00", end: "17:30:00" },
  { dayOfWeek: 5, start: "08:00:00", end: "15:20:00" },
] as const;

/**
 * Semana completa confirmada para Pablo González. Al omitir miércoles y jueves
 * se mantienen expresamente como días no programados.
 */
export const PABLO_GONZALEZ_SCHEDULE = {
  externalWorkeraId: "15313100",
  rules: [
    { dayOfWeek: 1, start: "07:30:00", end: "17:00:00" },
    { dayOfWeek: 2, start: "07:30:00", end: "17:00:00" },
    { dayOfWeek: 5, start: "11:00:00", end: "15:00:00" },
  ],
} as const;

export const MICHEL_MENDY_EXEMPTION = {
  externalWorkeraId: "12696643",
  legalBasis: "ARTICLE_22",
} as const;

export const GESTORA_OPERATIONAL_EVIDENCE_START = "2026-08-24";

async function resolveExactlyOneEmployee(
  supabase: SupabaseClient<Database>,
  companyId: string,
  firstNameContains: string,
  lastNameContains: string
): Promise<{ id: string; hireDate: string | null } | { matchCount: number }> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, first_name, last_name, hire_date")
    .eq("company_id", companyId)
    .ilike("first_name", `%${firstNameContains}%`)
    .ilike("last_name", `%${lastNameContains}%`);

  if (error) throw new Error(`resolveExactlyOneEmployee: fallo consultando employees: ${error.message}`);
  if (!data || data.length !== 1) return { matchCount: data?.length ?? 0 };
  return { id: data[0].id, hireDate: data[0].hire_date };
}

async function resolveByStableWorkeraCode(
  supabase: SupabaseClient<Database>,
  companyId: string,
  externalWorkeraId: string,
): Promise<{ id: string; hireDate: string | null } | { matchCount: number }> {
  const { data, error } = await supabase
    .from("employees")
    .select("id, hire_date")
    .eq("company_id", companyId)
    .eq("external_workera_id", externalWorkeraId);
  if (error) throw new Error(`resolveByStableWorkeraCode: fallo consultando employees: ${error.message}`);
  if (!data || data.length !== 1) return { matchCount: data?.length ?? 0 };
  return { id: data[0].id, hireDate: data[0].hire_date };
}

function effectiveDate(hireDate: string | null, evidenceFloorDate: string): string {
  return hireDate || evidenceFloorDate;
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
  if (effectiveFrom !== GESTORA_OPERATIONAL_EVIDENCE_START) {
    throw new Error(`La vigencia operativa base debe ser ${GESTORA_OPERATIONAL_EVIDENCE_START}; una fecha de contratación real anterior se deriva por ficha.`);
  }
  const resolved: SeedKnownSchedulesResult["resolved"] = [];
  const unresolved: SeedKnownSchedulesResult["unresolved"] = [];

  // --- Alejandro Valencia: L-J 08:30-18:00, V 08:30-15:50 ---
  const alejandro = await resolveExactlyOneEmployee(supabase, companyId, "ALEJANDRO", "VALENCIA");
  if ("id" in alejandro) {
    const scheduleId = await ensureIndividualSchedule(supabase, companyId, "Horario individual — Alejandro Valencia", [...ALEJANDRO_VALENCIA_SCHEDULE]);
    const assignmentDate = effectiveDate(alejandro.hireDate, effectiveFrom);
    await assignSchedule(supabase, alejandro.id, scheduleId, assignmentDate);
    resolved.push({ label: "Alejandro Valencia", employeeId: alejandro.id, action: "schedule_assignment", effectiveFrom: assignmentDate });
  } else {
    unresolved.push({ label: "Alejandro Valencia", matchCount: alejandro.matchCount, reason: "IDENTITY_NOT_UNIQUE" });
  }

  // --- María Vera: L-J 08:00-17:30, V 08:00-15:20 ---
  const maria = await resolveExactlyOneEmployee(supabase, companyId, "MARIA", "VERA");
  if ("id" in maria) {
    const scheduleId = await ensureIndividualSchedule(supabase, companyId, "Horario individual — María Vera", [...MARIA_VERA_SCHEDULE]);
    const assignmentDate = effectiveDate(maria.hireDate, effectiveFrom);
    await assignSchedule(supabase, maria.id, scheduleId, assignmentDate);
    resolved.push({ label: "María Vera", employeeId: maria.id, action: "schedule_assignment", effectiveFrom: assignmentDate });
  } else {
    unresolved.push({ label: "María Vera", matchCount: maria.matchCount, reason: "IDENTITY_NOT_UNIQUE" });
  }

  // --- Claudio Andrés Barrera: ficha local provisional autorizada + exención ---
  const claudio = await ensureClaudioBarreraProvisional(supabase, companyId);
  await assignExemption(
    supabase,
    claudio.employeeId,
    "NO_MARKING_REQUIRED",
    effectiveFrom,
    createdBy,
    "Gerente exento de marcación; identidad local provisional autorizada, pendiente de código oficial/RUT.",
  );
  resolved.push({ label: "Claudio Barrera", employeeId: claudio.employeeId, action: "time_control_exemption", effectiveFrom });

  // --- Michel André Mendy Muñoz: Artículo 22, ficha confirmada por código Workera ---
  const michel = await resolveByStableWorkeraCode(supabase, companyId, MICHEL_MENDY_EXEMPTION.externalWorkeraId);
  if ("id" in michel) {
    const exemptionDate = effectiveDate(michel.hireDate, effectiveFrom);
    await assignExemption(
      supabase,
      michel.id,
      MICHEL_MENDY_EXEMPTION.legalBasis,
      exemptionDate,
      createdBy,
      "Sujeto a Artículo 22 (Fase 7, PASO 8 del encargo)."
    );
    resolved.push({ label: "Michel André Mendy Muñoz", employeeId: michel.id, action: "time_control_exemption", effectiveFrom: exemptionDate });
  } else {
    unresolved.push({ label: "Michel André Mendy Muñoz", matchCount: michel.matchCount, reason: "STABLE_IDENTIFIER_NOT_FOUND" });
  }

  // --- Pablo Andrés González Pinto: semana completa confirmada ---
  const pablo = await resolveByStableWorkeraCode(supabase, companyId, PABLO_GONZALEZ_SCHEDULE.externalWorkeraId);
  if ("id" in pablo) {
    const scheduleId = await ensureIndividualSchedule(supabase, companyId, "Horario individual — Pablo Andrés González Pinto", [...PABLO_GONZALEZ_SCHEDULE.rules]);
    const assignmentDate = effectiveDate(pablo.hireDate, effectiveFrom);
    await assignSchedule(supabase, pablo.id, scheduleId, assignmentDate);
    resolved.push({ label: "Pablo Andrés González Pinto", employeeId: pablo.id, action: "schedule_assignment", effectiveFrom: assignmentDate });
  } else {
    unresolved.push({ label: "Pablo Andrés González Pinto", matchCount: pablo.matchCount, reason: "STABLE_IDENTIFIER_NOT_FOUND" });
  }

  return { resolved, unresolved };
}
