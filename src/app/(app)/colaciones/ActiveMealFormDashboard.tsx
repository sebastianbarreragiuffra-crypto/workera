"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "../../../components/shell/Badge";
import type { CreatedWeeklyMealGoogleForm } from "../../../lib/colaciones/google-forms";
import type { MealFormResponseStatus } from "../../../lib/colaciones/form-business-state";
import { buildMealReminderMessage, mealReminderAvailableAt, type MealResponseTracking } from "../../../lib/colaciones/response-tracking";

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("El navegador no permitió copiar el texto.");
}

function formatDateTime(value: Date | null) {
  if (!value) return "sin espera configurada";
  return new Intl.DateTimeFormat("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santiago",
  }).format(value);
}

export function ActiveMealFormDashboard({
  activeForm,
  responseStatus,
  tracking,
  trackingError,
  showPending,
  onCreateForm,
  onViewPending,
}: {
  activeForm: CreatedWeeklyMealGoogleForm | null;
  responseStatus: MealFormResponseStatus;
  tracking: MealResponseTracking | null;
  trackingError: string | null;
  showPending: boolean;
  onCreateForm: () => void;
  onViewPending: () => void;
}) {
  const router = useRouter();
  const [now, setNow] = useState(() => new Date());
  const [copyNotice, setCopyNotice] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const reminderAvailableAt = activeForm
    ? mealReminderAvailableAt(activeForm.createdAt, activeForm.reminderAfterHours ?? 24)
    : null;
  const reminderIsAvailable = !reminderAvailableAt || now.getTime() >= reminderAvailableAt.getTime();
  const reminderMessage = useMemo(
    () => activeForm && tracking ? buildMealReminderMessage(tracking.pendingWorkers, activeForm.responderUrl) : "",
    [activeForm, tracking],
  );

  async function copy(value: string, successMessage: string) {
    try {
      await copyToClipboard(value);
      setCopyNotice(successMessage);
    } catch (error) {
      setCopyNotice(error instanceof Error ? error.message : "No se pudo copiar el texto.");
    }
  }

  if (!activeForm) {
    return (
      <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Seguimiento de respuestas</h2>
        <p className="mt-2 text-sm text-slate-600">Todavía no existe un formulario de colaciones activo.</p>
        <button type="button" onClick={onCreateForm} className="mt-4 rounded-md bg-arcotex-blue px-4 py-2 text-sm font-semibold text-white hover:bg-arcotex-blue-dark">
          Crear formulario
        </button>
      </section>
    );
  }

  const pendingCount = tracking?.pendingCount ?? 0;
  const reminderDisabled = !tracking || pendingCount === 0 || !reminderIsAvailable;
  const statusBadge = responseStatus === "ABIERTO"
    ? { label: "ABIERTO", tone: "positive" as const }
    : { label: "CERRADO", tone: "negative" as const };

  return (
    <section aria-labelledby="active-meal-form-heading" className="rounded-lg border border-border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Seguimiento de respuestas</p>
          <h2 id="active-meal-form-heading" className="mt-1 truncate text-lg font-semibold text-slate-900">{activeForm.title}</h2>
        </div>
        <Badge label={statusBadge.label} tone={statusBadge.tone} />
      </div>

      {trackingError && (
        <p role="alert" className="mt-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
          {trackingError}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "Total trabajadores", value: tracking?.totalWorkers ?? "—" },
          { label: "Respondieron", value: tracking?.respondedCount ?? "—" },
          { label: "Pendientes", value: tracking?.pendingCount ?? "—" },
        ].map((metric) => (
          <div key={metric.label} className="rounded-lg border border-border bg-slate-50 p-4">
            <p className="text-xs text-slate-500">{metric.label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{metric.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <button type="button" onClick={onCreateForm} className="rounded-md bg-arcotex-blue px-3 py-2 text-sm font-semibold text-white hover:bg-arcotex-blue-dark">
          Crear formulario
        </button>
        <button type="button" onClick={() => void copy(activeForm.responderUrl, "Link del formulario copiado.")} className="rounded-md border border-arcotex-blue bg-white px-3 py-2 text-sm font-semibold text-arcotex-blue-dark hover:bg-blue-50">
          Copiar link del formulario
        </button>
        <button type="button" disabled={!tracking} onClick={() => { onViewPending(); router.refresh(); }} className="rounded-md border border-border bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400">
          Ver pendientes
        </button>
        <button type="button" disabled={reminderDisabled} onClick={() => void copy(reminderMessage, "Recordatorio copiado. Pégalo manualmente en el grupo de WhatsApp.")} className="rounded-md bg-arcotex-blue px-3 py-2 text-sm font-semibold text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:bg-slate-300">
          Copiar recordatorio WhatsApp
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Recordatorio manual configurado después de {activeForm.reminderAfterHours ?? 24} hora(s). Disponible desde {formatDateTime(reminderAvailableAt)}. La aplicación solo copia el mensaje; no lo envía.
      </p>
      {copyNotice && <p role="status" className="mt-3 rounded-md border border-info-border bg-info-bg px-3 py-2 text-sm text-info">{copyNotice}</p>}

      {showPending && tracking && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-900">Trabajadores pendientes</h3>
            <Badge label={`${tracking.pendingCount} pendiente${tracking.pendingCount === 1 ? "" : "s"}`} tone={tracking.pendingCount ? "warning" : "positive"} />
          </div>
          {tracking.pendingWorkers.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="border-b border-border text-xs text-slate-500">
                  <tr><th className="px-2 py-2 font-medium">Nombre</th><th className="px-2 py-2 font-medium">Apellido</th><th className="px-2 py-2 font-medium">Estado</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {tracking.pendingWorkers.map((worker) => (
                    <tr key={worker.employeeId}>
                      <td className="px-2 py-3 text-slate-800">{worker.firstName}</td>
                      <td className="px-2 py-3 text-slate-800">{worker.lastName}</td>
                      <td className="px-2 py-3"><Badge label="PENDIENTE" tone="warning" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p role="status" className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">Todos los trabajadores respondieron.</p>
          )}
        </div>
      )}
    </section>
  );
}
