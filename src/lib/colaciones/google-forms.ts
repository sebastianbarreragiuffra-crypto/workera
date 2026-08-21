import "server-only";

import type { WeeklyMealGoogleFormPayload } from "./google-forms-payload";

export interface CreatedWeeklyMealGoogleForm {
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

export interface WeeklyMealGoogleFormStatus {
  formId: string;
  respondentNames: string[];
  responseCount: number;
  acceptingResponses: boolean;
  updatedAt: string;
}

export class GoogleFormsConfigurationError extends Error {}

function getGoogleFormsConfiguration() {
  const endpoint = process.env.GOOGLE_FORMS_WEB_APP_URL?.trim();
  const sharedSecret = process.env.GOOGLE_FORMS_SHARED_SECRET?.trim();
  if (!endpoint || !sharedSecret) {
    throw new GoogleFormsConfigurationError("La automatización de Google Forms todavía no está conectada.");
  }
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !url.pathname.endsWith("/exec")) {
    throw new GoogleFormsConfigurationError("La URL configurada para Google Forms no es válida.");
  }
  return { endpoint: url.toString(), sharedSecret };
}

export async function createWeeklyMealGoogleForm(payload: WeeklyMealGoogleFormPayload): Promise<CreatedWeeklyMealGoogleForm> {
  const { endpoint, sharedSecret } = getGoogleFormsConfiguration();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: sharedSecret, operation: "create", payload }),
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });

  if (!response.ok) throw new Error(`Google Forms respondió con estado ${response.status}.`);
  const result = await response.json() as { ok?: boolean; error?: string; form?: CreatedWeeklyMealGoogleForm };
  if (!result.ok || !result.form?.responderUrl || !result.form.editUrl || !result.form.responseSheetDownloadUrl) {
    throw new Error(result.error || "Google Forms no devolvió un enlace válido.");
  }
  return result.form;
}

export const COLACIONES_FORMS_LIST_CACHE_TAG = "colaciones-forms-list";
export const COLACIONES_FORM_STATUS_CACHE_TAG_PREFIX = "colaciones-form-status-";

/**
 * Historial de formularios: cambia solo cuando alguien crea uno nuevo (una
 * acción explícita, ya invalida este tag -- ver `retryCreateGoogleFormAction`
 * en actions.ts), nunca "por sí solo" entre cargas de página. Un TTL corto
 * (45s) evita repetir el round-trip completo a Apps Script -- que puede
 * tardar varios segundos por el cold start del propio Apps Script -- en cada
 * carga de /colaciones, sin arriesgar datos operacionalmente obsoletos.
 */
export async function listWeeklyMealGoogleForms(): Promise<CreatedWeeklyMealGoogleForm[]> {
  const { endpoint, sharedSecret } = getGoogleFormsConfiguration();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: sharedSecret, operation: "list" }),
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    next: { revalidate: 45, tags: [COLACIONES_FORMS_LIST_CACHE_TAG] },
  });

  if (!response.ok) throw new Error(`Google Forms respondió con estado ${response.status}.`);
  const result = await response.json() as { ok?: boolean; error?: string; forms?: CreatedWeeklyMealGoogleForm[] };
  if (!result.ok || !Array.isArray(result.forms)) {
    throw new Error(result.error || "No se pudo recuperar el historial de formularios.");
  }
  const validForms = result.forms.filter((form) => Boolean(
    form.formId
    && form.responderUrl
    && form.editUrl
    && form.responseSheetUrl
    && form.responseSheetDownloadUrl,
  ));
  return validForms.filter((form) => {
    const isLegacyTestRecord = !form.title || form.title === "Formulario de colaciones";
    if (!isLegacyTestRecord || !form.closeAtLocal) return true;
    return !validForms.some((candidate) => (
      candidate.formId !== form.formId
      && candidate.closeAtLocal === form.closeAtLocal
      && Boolean(candidate.title)
      && candidate.title !== "Formulario de colaciones"
    ));
  });
}

/**
 * TTL más corto (15s) que el historial: el conteo de respuestas SÍ importa
 * operacionalmente (un supervisor puede querer ver una respuesta recién
 * enviada), así que se prioriza frescura sobre el ahorro máximo -- igual
 * evita repetir el round-trip a Apps Script en recargas rápidas seguidas.
 */
export async function getWeeklyMealGoogleFormStatus(formId: string): Promise<WeeklyMealGoogleFormStatus> {
  if (!formId.trim()) throw new Error("El formulario activo no es válido.");
  const { endpoint, sharedSecret } = getGoogleFormsConfiguration();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: sharedSecret, operation: "status", formId }),
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    next: { revalidate: 15, tags: [`${COLACIONES_FORM_STATUS_CACHE_TAG_PREFIX}${formId}`] },
  });

  if (!response.ok) throw new Error(`Google Forms respondió con estado ${response.status}.`);
  const result = await response.json() as { ok?: boolean; error?: string; status?: WeeklyMealGoogleFormStatus };
  if (!result.ok || !result.status || result.status.formId !== formId || !Array.isArray(result.status.respondentNames)) {
    throw new Error(result.error || "No se pudo obtener el estado del formulario activo.");
  }
  return result.status;
}
