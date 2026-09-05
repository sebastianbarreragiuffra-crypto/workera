"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { computePersonnelRosterPreview, applyPersonnelRosterImport, type PersonnelRosterPreview } from "../../../lib/employees/personnel-roster-import";
import { getWorkeraConfig } from "../../../lib/workera/config";
import { WorkeraConfigurationError } from "../../../lib/workera/errors";
import { HttpWorkeraClient } from "../../../lib/workera/http-client";
import { bootstrapEmployeesFromRoster, type BootstrapRosterResult } from "../../../lib/business-rules/employee-roster-reconciliation";
import { enforceWorkforceActionRateLimit } from "../../../lib/decisions/workforce-action-rate-limit";

/**
 * Server Actions del bootstrap/actualización de roster administrativo
 * (planilla de personal). Privilegiado -- mismo criterio que el resto de
 * escritura de `employees` (RLS `employees_write_admin`, exclusiva de
 * `is_privileged_admin()`): SUPER_ADMIN/ADMIN_RRHH. Nunca supervisores.
 */
/** Mismo límite ya usado para el resto de importadores Excel de la app (Nómina/Colaciones) -- ninguna razón para que este sea el único sin tope. */
const MAX_ROSTER_FILE_SIZE_BYTES = 5 * 1024 * 1024;

async function requireRosterAdmin() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") {
    throw new Error("Esta operación requiere rol SUPER_ADMIN o ADMIN_RRHH.");
  }
  await enforceWorkforceActionRateLimit(await createClient(), "workforce.roster.manage");
  return profile;
}

export interface RosterPreviewActionState {
  status: "idle" | "ready" | "blocked" | "error";
  message: string;
  preview?: PersonnelRosterPreview;
}

export async function previewPersonnelRosterAction(_prev: RosterPreviewActionState, formData: FormData): Promise<RosterPreviewActionState> {
  await requireRosterAdmin();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona la planilla de personal antes de continuar." };
  }
  if (file.size > MAX_ROSTER_FILE_SIZE_BYTES) {
    return { status: "error", message: `El archivo supera el máximo permitido (${Math.round(MAX_ROSTER_FILE_SIZE_BYTES / 1024 / 1024)} MB).` };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  try {
    const preview = await computePersonnelRosterPreview(supabase, fileBytes);
    if (!preview.ok) {
      return { status: "blocked", message: preview.blockingError ?? "El archivo no pasó la validación.", preview };
    }
    return { status: "ready", message: "Vista previa calculada.", preview };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos leer la planilla." };
  }
}

export interface ApplyRosterActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export async function applyPersonnelRosterAction(_prev: ApplyRosterActionState, formData: FormData): Promise<ApplyRosterActionState> {
  const profile = await requireRosterAdmin();
  const supabase = await createClient();

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona la planilla de personal antes de confirmar." };
  }
  if (file.size > MAX_ROSTER_FILE_SIZE_BYTES) {
    return { status: "error", message: `El archivo supera el máximo permitido (${Math.round(MAX_ROSTER_FILE_SIZE_BYTES / 1024 / 1024)} MB).` };
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await applyPersonnelRosterImport(supabase, { fileBytes, actorId: profile.id });
    revalidatePath("/empleados");
    revalidatePath("/licencias");
    revalidatePath("/dashboard");
    return {
      status: "success",
      message: `Roster actualizado: ${result.insertedCount} nuevos, ${result.updatedCount} actualizados, ${result.reactivatedCount} reactivados, ${result.deactivatedCount} desactivados.`,
    };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos aplicar el roster." };
  }
}

export interface WorkeraRosterReconciliationActionState {
  status: "idle" | "success" | "credentials_required" | "error";
  message: string;
  result?: BootstrapRosterResult;
}

/**
 * Ejecución MANUAL y controlada de la reconciliación completa de roster vía
 * `GET /employee` (sección 10 del encargo -- nunca cron automático). Nunca
 * escribe en Workera (`getAllEmployeeRoster` es GET). Si no hay credenciales
 * reales configuradas (`WORKERA_PROVIDER` != "http"), NO bloquea ni rompe --
 * reporta que el bootstrap de Excel sigue siendo la fuente disponible.
 */
export async function runWorkeraRosterReconciliationAction(
  _prev: WorkeraRosterReconciliationActionState,
  _formData: FormData
): Promise<WorkeraRosterReconciliationActionState> {
  void _prev;
  void _formData;
  await requireRosterAdmin();

  let config;
  try {
    config = getWorkeraConfig();
  } catch (err) {
    // En producción (Vercel), getWorkeraConfig() es fail-closed y LANZA si
    // WORKERA_PROVIDER != "http" (nunca cae al mock silenciosamente) -- eso
    // es correcto para el resto de la app, pero acá el propio contrato de
    // esta acción (ver comentario de la función) es "no bloquea ni rompe".
    // Sin este catch, un staging sin credenciales reales (WORKERA_PROVIDER=
    // mock, el valor seguro por defecto) rompía esta acción con un error no
    // controlado en vez de reportar el estado esperado.
    if (err instanceof WorkeraConfigurationError) {
      return {
        status: "credentials_required",
        message: "La reconciliación con Workera está lista pero no hay credenciales reales configuradas (WORKERA_PROVIDER/WORKERA_BASE_URL/WORKERA_API_USER/WORKERA_API_KEY). El bootstrap por planilla de personal sigue disponible mientras tanto.",
      };
    }
    throw err;
  }
  if (config.provider !== "http" || !config.baseUrl || !config.apiUser || !config.apiKey) {
    return {
      status: "credentials_required",
      message: "La reconciliación con Workera está lista pero no hay credenciales reales configuradas (WORKERA_PROVIDER/WORKERA_BASE_URL/WORKERA_API_USER/WORKERA_API_KEY). El bootstrap por planilla de personal sigue disponible mientras tanto.",
    };
  }

  const supabase = await createClient();
  const client = new HttpWorkeraClient({ baseUrl: config.baseUrl, apiUser: config.apiUser, apiKey: config.apiKey, requestTimeoutMs: config.requestTimeoutMs });

  try {
    const result = await bootstrapEmployeesFromRoster(supabase, client);
    revalidatePath("/empleados");
    revalidatePath("/licencias");
    revalidatePath("/dashboard");
    return {
      status: "success",
      message: `Reconciliación completa: ${result.newlyBootstrapped} nuevos, ${result.promotedFromExcelRoster} promovidos desde el bootstrap de Excel, ${result.alreadyExisting} ya existentes.${result.reconciliationRequired.length > 0 ? ` ${result.reconciliationRequired.length} caso(s) requieren revisión manual.` : ""}`,
      result,
    };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos reconciliar el roster con Workera." };
  }
}
