"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { parseMealMenuDocx, type ParsedMealMenu } from "../../../lib/colaciones/menu-docx";
import { buildWeeklyMealGoogleFormPayload, type WeeklyMealGoogleFormPayload } from "../../../lib/colaciones/google-forms-payload";
import { createWeeklyMealGoogleForm } from "../../../lib/colaciones/google-forms";
import { getNextFridayMealFormClosing } from "../../../lib/colaciones/weekly-form-schedule";

/**
 * Flujo de colaciones: subir el menú crea el Google Form automáticamente,
 * en la MISMA Server Action -- nunca hay un botón "Crear formulario"
 * separado. La protección de duplicados es real y ya existía: `requestId`
 * (sha256 de archivo+cierre+recordatorio+nómina) se manda a
 * `createWeeklyMealGoogleForm`, que lo reenvía al Apps Script
 * (`google-apps-script/colaciones-forms.gs`); ESE script (no esta app)
 * guarda un registro por `requestId` en PropertiesService y devuelve
 * `reused:true` si ya existe -- nunca se reimplementa esa lógica acá.
 *
 * Si la creación del formulario falla DESPUÉS de validar el menú
 * correctamente, el menú NUNCA se pierde: `pendingPayload` queda con el
 * payload ya construido (mismo `requestId`) para que `retryCreateGoogleFormAction`
 * pueda reintentar la creación sin pedir el archivo de nuevo -- al reenviar
 * el MISMO requestId, el Apps Script aplica la misma protección de
 * duplicados que en la subida original (nunca crea dos formularios).
 */

export interface CreatedFormState {
  formId: string;
  title: string;
  responderUrl: string;
  editUrl: string;
  responseSheetUrl: string;
  responseSheetDownloadUrl: string;
  closeAtLocal: string;
  reminderAfterHours: number;
  createdAt: string;
  dayLabels: string[];
  omittedDays: string[];
  reused: boolean;
}

export interface MenuUploadState {
  status: "idle" | "success" | "error";
  message: string;
  fileName: string;
  menu: ParsedMealMenu | null;
  googleForm: CreatedFormState | null;
  /** Presente SOLO si el menú se validó correctamente pero la creación del Google Form falló -- habilita reintentar sin volver a subir el archivo. */
  pendingPayload: WeeklyMealGoogleFormPayload | null;
}

const IDLE_STATE_BASE = { fileName: "", menu: null, googleForm: null, pendingPayload: null };

function toCreatedFormState(created: Awaited<ReturnType<typeof createWeeklyMealGoogleForm>>): CreatedFormState {
  return {
    formId: created.formId,
    title: created.title,
    responderUrl: created.responderUrl,
    editUrl: created.editUrl,
    responseSheetUrl: created.responseSheetUrl,
    responseSheetDownloadUrl: created.responseSheetDownloadUrl,
    closeAtLocal: created.closeAtLocal,
    reminderAfterHours: created.reminderAfterHours,
    createdAt: created.createdAt,
    dayLabels: created.dayLabels,
    omittedDays: created.omittedDays,
    reused: created.reused,
  };
}

export async function parseMealMenuAction(_previousState: MenuUploadState, formData: FormData): Promise<MenuUploadState> {
  const profile = await getCurrentProfile();
  if (!profile?.role || !isPrivilegedAdmin(profile.role)) {
    return { status: "error", message: "No tienes permiso para adjuntar menús de colaciones.", ...IDLE_STATE_BASE };
  }

  const file = formData.get("menuFile");
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Selecciona un archivo Word antes de continuar.", ...IDLE_STATE_BASE };
  }
  if (!file.name.toLowerCase().endsWith(".docx")) {
    return { status: "error", message: "El menú debe estar en formato Word .docx.", ...IDLE_STATE_BASE, fileName: file.name };
  }
  if (file.size > 5 * 1024 * 1024) {
    return { status: "error", message: "El archivo supera el máximo permitido de 5 MB.", ...IDLE_STATE_BASE, fileName: file.name };
  }

  const reminderAfterHours = Number(formData.get("reminderAfterHours"));
  if (!Number.isInteger(reminderAfterHours) || reminderAfterHours < 0 || reminderAfterHours > 168) {
    return { status: "error", message: "Selecciona un plazo válido para habilitar el recordatorio manual.", ...IDLE_STATE_BASE, fileName: file.name };
  }

  // --- Fase 1: validar el menú -- si esto falla, no hay nada que reintentar (hay que volver a subir un archivo válido).
  let menu: ParsedMealMenu;
  let payload: WeeklyMealGoogleFormPayload;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    menu = parseMealMenuDocx(bytes);
    const { closeDate, closeTime } = getNextFridayMealFormClosing();
    const supabase = await createClient();
    const { data: employees, error: employeesError } = await supabase
      .from("employees")
      .select("display_name")
      .eq("active", true)
      .order("display_name");
    if (employeesError) throw new Error(`No se pudo cargar la nómina activa: ${employeesError.message}`);
    const employeeNames = (employees ?? []).map((employee) => employee.display_name);
    const requestId = createHash("sha256")
      .update(bytes)
      .update(closeDate)
      .update(closeTime)
      .update(String(reminderAfterHours))
      .update(employeeNames.join("\n"))
      .digest("hex");
    payload = buildWeeklyMealGoogleFormPayload({ menu, requestId, closeDate, closeTime, reminderAfterHours, employeeNames });
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "No se pudo validar el menú.", ...IDLE_STATE_BASE, fileName: file.name };
  }

  // --- Fase 2: crear (o reutilizar) el Google Form automáticamente -- nunca requiere un clic aparte.
  return createOrRetryGoogleForm(payload, menu, file.name);
}

/** Reintento -- recibe el MISMO payload ya validado (mismo requestId), nunca vuelve a pedir el archivo ni a re-parsear el menú. */
export async function retryCreateGoogleFormAction(_previousState: MenuUploadState, formData: FormData): Promise<MenuUploadState> {
  const profile = await getCurrentProfile();
  if (!profile?.role || !isPrivilegedAdmin(profile.role)) {
    return { status: "error", message: "No tienes permiso para reintentar la creación del formulario.", ...IDLE_STATE_BASE };
  }

  const rawPayload = formData.get("pendingPayload");
  const rawMenu = formData.get("pendingMenu");
  const fileName = String(formData.get("fileName") ?? "");
  if (typeof rawPayload !== "string" || typeof rawMenu !== "string") {
    return { status: "error", message: "No encontramos el menú a reintentar -- sube el archivo nuevamente.", ...IDLE_STATE_BASE };
  }

  let payload: WeeklyMealGoogleFormPayload;
  let menu: ParsedMealMenu;
  try {
    payload = JSON.parse(rawPayload) as WeeklyMealGoogleFormPayload;
    menu = JSON.parse(rawMenu) as ParsedMealMenu;
  } catch {
    return { status: "error", message: "No pudimos leer el menú a reintentar -- sube el archivo nuevamente.", ...IDLE_STATE_BASE };
  }

  return createOrRetryGoogleForm(payload, menu, fileName);
}

async function createOrRetryGoogleForm(payload: WeeklyMealGoogleFormPayload, menu: ParsedMealMenu, fileName: string): Promise<MenuUploadState> {
  try {
    const created = await createWeeklyMealGoogleForm(payload);
    revalidatePath("/colaciones");
    const holidayMessage = menu.omittedDays.length
      ? ` Se omitió ${menu.omittedDays.join(" y ")} porque está marcado como feriado.`
      : "";
    const reusedMessage = created.reused ? " Se reutilizó el formulario ya creado para este mismo menú." : " Google Form creado automáticamente.";
    return {
      status: "success",
      message: `Menú reconocido correctamente.${holidayMessage}${reusedMessage}`,
      fileName,
      menu,
      googleForm: toCreatedFormState(created),
      pendingPayload: null,
    };
  } catch {
    return {
      status: "error",
      message: "El menú fue cargado correctamente, pero no fue posible crear el formulario. Reintentar creación.",
      fileName,
      menu,
      googleForm: null,
      pendingPayload: payload,
    };
  }
}
