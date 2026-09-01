"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { Badge } from "../../../components/shell/Badge";
import { buildMealFormOptions } from "../../../lib/colaciones/menu-options";
import { parseMealMenuAction, retryCreateGoogleFormAction, type MenuUploadState } from "./actions";
import type { CreatedWeeklyMealGoogleForm } from "../../../lib/colaciones/google-forms";
import type { MealFormBusinessState } from "../../../lib/colaciones/form-business-state";
import { formatDateTimeInSantiago } from "../../../lib/view-models/date-utils";

const INITIAL_STATE: MenuUploadState = { status: "idle", message: "", fileName: "", menu: null, googleForm: null, pendingPayload: null };

const PROGRESS_STEPS = ["Subiendo menú...", "Validando información...", "Creando formulario Google..."];

function formatCloseAt(value: string) {
  if (!value) return "Fecha de cierre no disponible";
  const [date, time = ""] = value.split("T");
  const [year, month, day] = date.split("-");
  return `Cierra ${day}/${month}/${year}${time ? ` a las ${time.slice(0, 5)}` : ""}`;
}

function formatCreatedAt(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatDateTimeInSantiago(parsed);
}

/** Ticker visual que avanza por las 3 etapas mientras la Server Action está en curso -- no hay progreso real streameado del servidor, así que se simula localmente y se reinicia al terminar. */
function useProgressStep(pending: boolean) {
  const [stepIndex, setStepIndex] = useState(0);
  useEffect(() => {
    if (!pending) {
      const timeout = setTimeout(() => setStepIndex(0), 0);
      return () => clearTimeout(timeout);
    }
    const interval = setInterval(() => {
      setStepIndex((current) => Math.min(current + 1, PROGRESS_STEPS.length - 1));
    }, 900);
    return () => clearInterval(interval);
  }, [pending]);
  return pending ? PROGRESS_STEPS[stepIndex] : null;
}

export function MenuUploadDashboard({
  recentForms,
  formsError,
  formBusinessState,
}: {
  recentForms: CreatedWeeklyMealGoogleForm[];
  formsError: string | null;
  formBusinessState: MealFormBusinessState;
}) {
  const [uploadState, uploadFormAction, uploadPending] = useActionState(parseMealMenuAction, INITIAL_STATE);
  const [retryState, retryFormAction, retryPending] = useActionState(retryCreateGoogleFormAction, INITIAL_STATE);

  // El estado más reciente entre "subir" y "reintentar" es el que se muestra -- ambos comparten la misma forma (MenuUploadState).
  const state = retryState.status !== "idle" ? retryState : uploadState;
  const pending = uploadPending || retryPending;
  const progressLabel = useProgressStep(pending);

  const visibleForms = useMemo(() => {
    if (!state.googleForm) return recentForms;
    const current = state.googleForm;
    return [current, ...recentForms.filter((item) => item.formId !== current.formId)];
  }, [recentForms, state.googleForm]);

  const needsRetry = state.status === "error" && state.pendingPayload !== null && state.menu !== null;

  return (
    <section className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Adjuntar menú de colaciones</h2>
          <p className="mt-1 text-sm text-slate-500">Carga el documento Word que envía el proveedor -- el Google Form se crea automáticamente al validarse.</p>
        </div>
        <Badge label="Formato Word .docx" tone="info" />
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(260px,0.75fr)_minmax(0,1.5fr)]">
        <form action={uploadFormAction} className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
          <label htmlFor="menuFile" className="block text-sm font-medium text-slate-800">Documento del proveedor</label>
          <p className="mt-1 text-xs text-slate-500">Debe incluir los días lunes a viernes y sus opciones de menú.</p>
          <input id="menuFile" name="menuFile" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required className="mt-4 block w-full rounded-md border border-arcotex-copper-border bg-arcotex-copper-light p-2 text-sm text-slate-600 shadow-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-arcotex-copper file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-arcotex-copper-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-copper" />
          <div className="mt-4 rounded-md border border-info-border bg-info-bg px-3 py-2 text-xs text-info">
            <strong>Cierre automático:</strong> viernes a las 13:00. Si el menú se carga después de esa hora, se programa para el viernes siguiente.
          </div>
          <label htmlFor="reminderAfterHours" className="mt-3 block text-xs font-medium text-slate-600">
            Habilitar recordatorio manual después de
            <select id="reminderAfterHours" name="reminderAfterHours" defaultValue="24" className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-700">
              <option value="0">Inmediatamente</option>
              <option value="6">6 horas</option>
              <option value="12">12 horas</option>
              <option value="24">24 horas</option>
              <option value="48">48 horas</option>
            </select>
          </label>
          <button type="submit" disabled={pending} className="mt-4 w-full rounded-md bg-arcotex-blue px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue disabled:cursor-not-allowed disabled:bg-slate-300">
            {uploadPending ? "Procesando..." : "Adjuntar menú"}
          </button>

          {progressLabel && (
            <p role="status" className="mt-3 flex items-center gap-2 rounded-md border border-info-border bg-info-bg px-3 py-2 text-xs text-info">
              <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-arcotex-blue" />
              {progressLabel}
            </p>
          )}

          {!pending && state.status === "success" && (
            <p role="status" className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-xs text-success">
              ✓ Formulario creado correctamente. {state.message}
            </p>
          )}
          {!pending && state.status === "error" && (
            <p role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-xs text-critical">
              {state.message}
            </p>
          )}
          {state.fileName && <p className="mt-2 truncate text-xs text-slate-500">Archivo: {state.fileName}</p>}

          {needsRetry && state.pendingPayload && state.menu && (
            <form action={retryFormAction} className="mt-3">
              <input type="hidden" name="pendingPayload" value={JSON.stringify(state.pendingPayload)} />
              <input type="hidden" name="pendingMenu" value={JSON.stringify(state.menu)} />
              <input type="hidden" name="fileName" value={state.fileName} />
              <button
                type="submit"
                disabled={retryPending}
                className="w-full rounded-md border border-critical-border bg-white px-3 py-2 text-sm font-semibold text-critical shadow-sm hover:bg-critical-bg disabled:cursor-not-allowed disabled:opacity-60"
              >
                {retryPending ? "Reintentando..." : "Reintentar creación"}
              </button>
            </form>
          )}
        </form>

        <div className="min-w-0">
          {state.menu ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Vista previa detectada</p><h3 className="text-sm font-semibold text-slate-900">{state.menu.title}</h3></div>
                <Badge label={`${state.menu.days.length} días habilitados`} tone="positive" />
              </div>
              {state.menu.omittedDays.length > 0 && (
                <p className="mb-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
                  Día feriado omitido del formulario: {state.menu.omittedDays.join(" y ")}.
                </p>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
                {state.menu.days.map((day) => (
                  <article key={day.day} className="rounded-md border border-border bg-white p-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-arcotex-blue-dark">{day.day}</h4>
                    <div className="mt-2 rounded-md bg-blue-50 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-arcotex-blue-dark">Menú de colación</p>
                      <ul className="mt-1 space-y-1 text-[11px] text-slate-700">
                        {buildMealFormOptions(day).map((option) => <li key={option}>• {option}</li>)}
                      </ul>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="flex min-h-48 items-center justify-center rounded-lg border border-border bg-white p-6 text-center">
              <div><p className="text-sm font-medium text-slate-700">Vista previa del menú</p><p className="mt-1 max-w-md text-xs text-slate-500">Al adjuntar el Word aparecerán aquí las opciones finales de lunes a viernes -- el formulario se crea automáticamente.</p></div>
            </div>
          )}
          {state.googleForm && (
            <div className="mt-4 rounded-lg border border-success-border bg-success-bg p-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-success">Formulario listo para compartir</p>
                  <p className="mt-1 text-xs text-slate-600">Revisa el formulario, copia su enlace desde el panel activo o descarga la planilla del proveedor.</p>
                </div>
                <Badge label={state.googleForm.reused ? "Formulario reutilizado" : "Google Form creado"} tone="positive" />
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
                {formatCreatedAt(state.googleForm.createdAt) && <span>Creado: {formatCreatedAt(state.googleForm.createdAt)}</span>}
                <span>Estado: {state.googleForm.reused ? "Reutilizado (ya existía para este menú)" : "Nuevo"}</span>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <a href={state.googleForm.responderUrl} target="_blank" rel="noreferrer" className="rounded-md bg-arcotex-blue px-3 py-2 text-center text-sm font-medium text-white hover:bg-arcotex-blue-dark">Abrir formulario</a>
                <a href={state.googleForm.responseSheetDownloadUrl} className="rounded-md border border-arcotex-blue bg-white px-3 py-2 text-center text-sm font-medium text-arcotex-blue-dark hover:bg-blue-50">Descargar Excel proveedor</a>
                <a href={state.googleForm.editUrl} target="_blank" rel="noreferrer" className="text-center text-xs font-medium text-arcotex-blue-dark underline sm:py-2">Editar en Google Forms</a>
                <a href={state.googleForm.responseSheetUrl} target="_blank" rel="noreferrer" className="text-center text-xs font-medium text-slate-600 underline sm:py-2">Ver planilla de respuestas</a>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <section className="rounded-lg border border-border bg-white p-4 shadow-sm" aria-label="Formularios recientes">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Formularios recientes</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{visibleForms.length}</p>
          </section>
          <section className={`rounded-lg border p-4 shadow-sm ${formBusinessState.activeFormCount ? "border-success-border bg-success-bg" : "border-border bg-slate-50"}`} aria-label="Formularios activos">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Formularios activos</p>
            <div className="mt-2 flex items-center gap-2">
              <span aria-hidden="true" className={`h-3 w-3 rounded-full ${formBusinessState.activeFormCount ? "bg-emerald-500" : "bg-slate-300"}`} />
              <p className="text-2xl font-semibold text-slate-900">{formBusinessState.activeFormCount}</p>
            </div>
          </section>
          <section className="rounded-lg border border-border bg-white p-4 shadow-sm" aria-label="Status de respuestas">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status de respuestas</p>
            <div className="mt-3">
              <Badge label={formBusinessState.responseStatus} tone={formBusinessState.responseStatus === "ABIERTO" ? "positive" : "negative"} />
            </div>
          </section>
        </div>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Historial de formularios</h3>
            <p className="mt-1 text-xs text-slate-500">Los formularios cerrados permanecen disponibles para revisar respuestas y descargar el pedido del proveedor.</p>
          </div>
          <Badge label={`${visibleForms.length} guardado${visibleForms.length === 1 ? "" : "s"}`} tone={visibleForms.length ? "positive" : "neutral"} />
        </div>

        {formsError && <p role="status" className="mt-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">{formsError}</p>}

        {visibleForms.length > 0 ? (
          <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
            {visibleForms.map((form) => (
              <article key={form.formId} className="rounded-lg border border-border bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-semibold text-slate-900">{form.title || "Formulario de colaciones"}</h4>
                    <p className="mt-1 text-xs text-slate-500">{formatCloseAt(form.closeAtLocal)}</p>
                  </div>
                  <Badge label={form.reused ? "Existente" : "Google Form"} tone="info" />
                </div>
                {form.omittedDays.length > 0 && <p className="mt-2 text-xs text-warning">Feriado omitido: {form.omittedDays.join(" y ")}</p>}
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <a href={form.responderUrl} target="_blank" rel="noreferrer" className="rounded-md bg-arcotex-blue px-3 py-2 text-center text-xs font-medium text-white hover:bg-arcotex-blue-dark">Revisar formulario</a>
                  <a href={form.responseSheetUrl} target="_blank" rel="noreferrer" className="rounded-md border border-border bg-white px-3 py-2 text-center text-xs font-medium text-slate-700 hover:bg-slate-50">Ver respuestas</a>
                  <a href={form.responseSheetDownloadUrl} className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-center text-xs font-medium text-success hover:bg-white">Descargar Excel</a>
                </div>
                <a href={form.editUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-xs font-medium text-arcotex-blue-dark underline">Editar formulario</a>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">Cuando adjuntes el primer menú, su formulario aparecerá aquí permanentemente.</p>
        )}
        <p className="mt-3 text-[11px] text-slate-500">El Excel conserva fecha y correo como columnas ocultas y muestra directamente Nombre y apellido más los días hábiles.</p>
      </div>
    </section>
  );
}
