"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  attachExpenseReceiptCaptureAction,
  captureExpenseReceiptAction,
  configureExpenseReceiptEmailAction,
  discardExpenseReceiptCaptureAction,
  type ExpenseActionState,
} from "@/app/(expenses)/empresas/[companySlug]/rendiciones/actions";
import type { ExpenseDraftItemOption } from "@/lib/expenses/captures";

const INITIAL_STATE: ExpenseActionState = { status: "idle", message: "" };

function Feedback({ state }: { state: ExpenseActionState }) {
  if (state.status === "idle") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${state.status === "error" ? "bg-critical-bg text-critical" : "bg-success-bg text-success"}`}>
      {state.message}
    </p>
  );
}

function PendingButton({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold disabled:cursor-wait disabled:opacity-60 ${tone === "danger" ? "border border-red-200 bg-white text-red-700 hover:bg-red-50" : "bg-arcotex-blue text-white shadow-sm hover:bg-arcotex-blue-dark"}`}
    >
      {pending ? "Procesando…" : children}
    </button>
  );
}

function CaptureUploadForm({ companySlug, camera }: { companySlug: string; camera: boolean }) {
  const [state, action] = useActionState(captureExpenseReceiptAction, INITIAL_STATE);
  const inputId = camera ? "camera-receipt" : "file-receipt";
  return (
    <form action={action} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="source" value={camera ? "WEB_CAMERA" : "WEB_UPLOAD"} />
      <div>
        <h2 className="font-semibold text-slate-900">{camera ? "Tomar una foto" : "Subir un archivo"}</h2>
        <p className="mt-1 text-xs text-slate-500">
          {camera ? "Abre la cámara trasera del celular para fotografiar la boleta." : "Selecciona una imagen o un PDF que ya tengas guardado."}
        </p>
      </div>
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
        Comprobante
        <input
          id={inputId}
          name="receipt"
          type="file"
          required
          accept={camera ? "image/jpeg,image/png" : "application/pdf,image/jpeg,image/png"}
          capture={camera ? "environment" : undefined}
          className="mt-2 block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-arcotex-blue-dark"
        />
      </label>
      <p className="text-[11px] text-slate-500">PDF, JPG o PNG · máximo 10 MB</p>
      <Feedback state={state} />
      <PendingButton>{camera ? "Guardar foto" : "Guardar archivo"}</PendingButton>
    </form>
  );
}

export function ExpenseCaptureUploadForms({ companySlug }: { companySlug: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <CaptureUploadForm companySlug={companySlug} camera />
      <CaptureUploadForm companySlug={companySlug} camera={false} />
    </div>
  );
}

export function ExpenseCaptureAttachForm({
  companySlug,
  captures,
  draftItems,
}: {
  companySlug: string;
  captures: Array<{ id: string; label: string }>;
  draftItems: ExpenseDraftItemOption[];
}) {
  const [state, action] = useActionState(attachExpenseReceiptCaptureAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="companySlug" value={companySlug} />
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-xs font-medium text-slate-700">
          Comprobante
          <select name="captureId" required defaultValue="" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900">
            <option value="" disabled>Selecciona un comprobante</option>
            {captures.map((capture) => <option key={capture.id} value={capture.id}>{capture.label}</option>)}
          </select>
        </label>
      <label className="block text-xs font-medium text-slate-700">
        Asociar a un gasto
        <select name="itemId" required defaultValue="" className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900">
          <option value="" disabled>Selecciona una rendición y gasto</option>
          {draftItems.map((item) => (
            <option key={item.id} value={item.id}>{item.reportLabel} — {item.itemLabel}</option>
          ))}
        </select>
      </label>
      </div>
      <Feedback state={state} />
      <PendingButton>Asociar comprobante</PendingButton>
    </form>
  );
}

export function ExpenseCaptureDiscardForm({ companySlug, captureId }: { companySlug: string; captureId: string }) {
  const [state, action] = useActionState(discardExpenseReceiptCaptureAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="captureId" value={captureId} />
      <Feedback state={state} />
      <PendingButton tone="danger">Descartar</PendingButton>
    </form>
  );
}

export function ExpenseEmailConnectorCard({
  companySlug,
  configured,
  enabled,
  address,
}: {
  companySlug: string;
  configured: boolean;
  enabled: boolean;
  address: string | null;
}) {
  const [state, action] = useActionState(configureExpenseReceiptEmailAction, INITIAL_STATE);
  return (
    <section className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4 text-sm text-blue-950">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Recibir comprobantes por correo</p>
          {!configured ? (
            <p className="mt-1 text-blue-800">El administrador todavía debe configurar el dominio seguro de recepción.</p>
          ) : address ? (
            <>
              <p className="mt-1 text-blue-800">Envía tus PDF, JPG o PNG como adjuntos a esta dirección privada:</p>
              <input
                aria-label="Dirección privada para comprobantes"
                readOnly
                value={address}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-2 w-full rounded-lg border border-blue-200 bg-white px-3 py-2 font-mono text-xs text-slate-900"
              />
              <p className="mt-2 text-xs text-blue-800">
                {enabled ? "Recepción activa. Los adjuntos válidos aparecerán en esta bandeja." : "Dirección preparada, pero la recepción permanece pausada por seguridad."}
              </p>
            </>
          ) : (
            <p className="mt-1 text-blue-800">Activa una dirección secreta exclusiva para esta empresa.</p>
          )}
        </div>
        {configured && (
          <form action={action} className="shrink-0 space-y-2">
            <input type="hidden" name="companySlug" value={companySlug} />
            <input type="hidden" name="intent" value={address ? "rotate" : "ensure"} />
            <PendingButton tone={address ? "danger" : "primary"}>{address ? "Reemplazar dirección" : "Activar correo"}</PendingButton>
          </form>
        )}
      </div>
      <div className="mt-3"><Feedback state={state} /></div>
      {address && <p className="mt-2 text-[11px] text-blue-700">No publiques esta dirección. Si se filtra, reemplázala para invalidar la anterior.</p>}
    </section>
  );
}
