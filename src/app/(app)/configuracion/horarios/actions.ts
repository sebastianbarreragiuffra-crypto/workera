"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../lib/auth/session";
import {
  assignScheduleToEmployee,
  assignScheduleToUnassigned,
  setTimeControlExemption,
  clearTimeControlExemption,
  upsertWorkSchedule,
  type LegalBasis,
  type WorkScheduleRule,
} from "../../../../lib/schedules/schedule-administration";

/**
 * Server Actions de administración de horarios (MB-1).
 *
 * Todas usan el cliente de SESIÓN (`createClient`), nunca el admin client: la
 * RLS `is_privileged_admin()` de `schedule_assignments` /
 * `employee_time_control_policies` / `work_schedules` es el gate real de
 * autorización. El chequeo de rol de acá es una cortesía de UI para dar un
 * mensaje claro, no la frontera de seguridad -- mismo criterio que
 * `revision-diaria/actions.ts` y `licencias/roster-actions.ts`.
 */

export interface ScheduleActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export const SCHEDULE_ACTION_INITIAL: ScheduleActionState = { status: "idle", message: "" };

async function requireScheduleAdmin() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") {
    throw new Error("Esta operación requiere rol SUPER_ADMIN o ADMIN_RRHH.");
  }
  return profile;
}

function revalidateScheduleViews() {
  revalidatePath("/configuracion/horarios");
  revalidatePath("/revision-diaria");
  revalidatePath("/dashboard");
  revalidatePath("/licencias");
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

function readDate(formData: FormData, field: string): string {
  const value = String(formData.get(field) ?? "").trim();
  if (!DATE_PATTERN.test(value)) throw new Error("La fecha de vigencia no es válida.");
  return value;
}

function readRequired(formData: FormData, field: string, label: string): string {
  const value = String(formData.get(field) ?? "").trim();
  if (!value) throw new Error(`${label} es obligatorio.`);
  return value;
}

function toActionError(err: unknown, fallback: string): ScheduleActionState {
  return { status: "error", message: err instanceof Error ? err.message : fallback };
}

// ---------------------------------------------------------------------------

export async function assignScheduleAction(_prev: ScheduleActionState, formData: FormData): Promise<ScheduleActionState> {
  await requireScheduleAdmin();
  try {
    const employeeId = readRequired(formData, "employeeId", "El trabajador");
    const workScheduleId = readRequired(formData, "workScheduleId", "El horario");
    const effectiveFrom = readDate(formData, "effectiveFrom");

    const supabase = await createClient();
    await assignScheduleToEmployee(supabase, { employeeId, workScheduleId, effectiveFrom });
    revalidateScheduleViews();
    return { status: "success", message: `Horario asignado desde ${effectiveFrom}.` };
  } catch (err) {
    return toActionError(err, "No pudimos asignar el horario.");
  }
}

export async function assignScheduleToUnassignedAction(
  _prev: ScheduleActionState,
  formData: FormData
): Promise<ScheduleActionState> {
  await requireScheduleAdmin();
  try {
    const workScheduleId = readRequired(formData, "workScheduleId", "El horario");
    const effectiveFrom = readDate(formData, "effectiveFrom");

    const supabase = await createClient();
    const count = await assignScheduleToUnassigned(supabase, { workScheduleId, effectiveFrom });
    revalidateScheduleViews();

    if (count === 0) {
      return { status: "success", message: "Todos los trabajadores activos ya tenían horario vigente. No se cambió nada." };
    }
    return { status: "success", message: `${count} trabajador(es) quedaron con horario desde ${effectiveFrom}.` };
  } catch (err) {
    return toActionError(err, "No pudimos aplicar el horario base.");
  }
}

const VALID_LEGAL_BASIS: LegalBasis[] = ["NO_MARKING_REQUIRED", "ARTICLE_22", "OTHER"];

export async function setExemptionAction(_prev: ScheduleActionState, formData: FormData): Promise<ScheduleActionState> {
  const profile = await requireScheduleAdmin();
  try {
    const employeeId = readRequired(formData, "employeeId", "El trabajador");
    const effectiveFrom = readDate(formData, "effectiveFrom");
    const legalBasis = String(formData.get("legalBasis") ?? "") as LegalBasis;
    if (!VALID_LEGAL_BASIS.includes(legalBasis)) {
      throw new Error("Selecciona una base legal válida para la exención.");
    }
    // La base de datos exige `reason` no vacío solo para algunos casos, pero
    // una exención sin motivo escrito no es auditable -- se pide siempre.
    const reason = readRequired(formData, "reason", "El motivo de la exención");

    const supabase = await createClient();
    await setTimeControlExemption(supabase, { employeeId, legalBasis, effectiveFrom, reason, actorId: profile.id });
    revalidateScheduleViews();
    return { status: "success", message: `Exención registrada desde ${effectiveFrom}.` };
  } catch (err) {
    return toActionError(err, "No pudimos registrar la exención.");
  }
}

export async function clearExemptionAction(_prev: ScheduleActionState, formData: FormData): Promise<ScheduleActionState> {
  await requireScheduleAdmin();
  try {
    const employeeId = readRequired(formData, "employeeId", "El trabajador");
    const effectiveFrom = readDate(formData, "effectiveFrom");

    const supabase = await createClient();
    await clearTimeControlExemption(supabase, { employeeId, effectiveFrom });
    revalidateScheduleViews();
    return {
      status: "success",
      message: `Vuelve a control horario normal desde ${effectiveFrom}. Recuerda asignarle un horario si no tiene.`,
    };
  } catch (err) {
    return toActionError(err, "No pudimos quitar la exención.");
  }
}

/**
 * Formulario simplificado a los tres tramos que la empresa usa realmente
 * (entrada única, salida lunes-jueves, salida viernes), más un sábado opcional.
 * Un horario con otra forma sigue siendo modelable -- `upsert_work_schedule`
 * acepta cualquier combinación de reglas por día; lo que este formulario acota
 * es solo la entrada de la UI.
 */
export async function createScheduleAction(_prev: ScheduleActionState, formData: FormData): Promise<ScheduleActionState> {
  await requireScheduleAdmin();
  try {
    const name = readRequired(formData, "name", "El nombre del horario");
    const start = readRequired(formData, "start", "La hora de entrada");
    const endMonThu = readRequired(formData, "endMonThu", "La salida de lunes a jueves");
    const endFri = readRequired(formData, "endFri", "La salida del viernes");
    const endSat = String(formData.get("endSat") ?? "").trim();

    for (const [label, value] of [["entrada", start], ["salida L-J", endMonThu], ["salida viernes", endFri]] as const) {
      if (!TIME_PATTERN.test(value)) throw new Error(`La hora de ${label} no es válida.`);
    }
    if (endSat && !TIME_PATTERN.test(endSat)) throw new Error("La hora de salida del sábado no es válida.");

    const rules: WorkScheduleRule[] = [
      ...[1, 2, 3, 4].map((dayOfWeek) => ({ dayOfWeek, scheduledStart: start, scheduledEnd: endMonThu })),
      { dayOfWeek: 5, scheduledStart: start, scheduledEnd: endFri },
      ...(endSat ? [{ dayOfWeek: 6, scheduledStart: start, scheduledEnd: endSat }] : []),
    ];

    const supabase = await createClient();
    await upsertWorkSchedule(supabase, { scheduleId: null, name, rules });
    revalidateScheduleViews();
    return { status: "success", message: `Horario "${name}" creado. Ya puedes asignarlo.` };
  } catch (err) {
    return toActionError(err, "No pudimos crear el horario.");
  }
}
