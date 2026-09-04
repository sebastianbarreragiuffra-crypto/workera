"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  attachExpenseReceiptCaptureAction,
  captureExpenseReceiptAction,
  configureExpenseReceiptEmailAction,
  configureExpenseReceiptWhatsappAction,
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
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold disabled:cursor-wait disabled:opacity-60 ${tone === "danger" ? "border border-red-200 bg-white text-red-700 hover:bg-red-50" : "bg-arcotex-blue text-white shadow-sm hover:bg-arcotex-blue-dark"}`}
    >
      {pending ? "Procesando…" : children}
    </button>
  );
}

function CaptureUploadForm({ companySlug, camera }: { companySlug: string; camera: boolean }) {
  const [state, action] = useActionState(captureExpenseReceiptAction, INITIAL_STATE);
  const inputId = camera ? "camera-receipt" : "file-receipt";
  return (
    <form action={action} className={`space-y-4 rounded-xl border p-5 shadow-sm ${camera ? "border-blue-200 bg-blue-50/60" : "border-slate-200 bg-white"}`}>
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="source" value={camera ? "WEB_CAMERA" : "WEB_UPLOAD"} />
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-900">{camera ? "Tomar foto ahora" : "Elegir un archivo"}</h3>
          {camera && <span className="rounded-full bg-blue-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-800">Más rápido</span>}
        </div>
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
          className="mt-2 block min-h-11 w-full text-xs text-slate-600 file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-white file:px-4 file:py-3 file:text-xs file:font-semibold file:text-arcotex-blue-dark"
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
    <section className="space-y-4" aria-labelledby="capture-guide-title">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 id="capture-guide-title" className="text-sm font-semibold text-slate-900">Guarda la boleta en menos de un minuto</h2>
        <ol className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
          <li className="rounded-lg bg-slate-50 px-3 py-2"><strong className="text-slate-900">1. Captura</strong><br />Toma la foto o elige el PDF.</li>
          <li className="rounded-lg bg-slate-50 px-3 py-2"><strong className="text-slate-900">2. Asocia</strong><br />Vincúlala a un gasto en borrador.</li>
          <li className="rounded-lg bg-slate-50 px-3 py-2"><strong className="text-slate-900">3. Envía</strong><br />RR.HH. la verá con tu rendición.</li>
        </ol>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <CaptureUploadForm companySlug={companySlug} camera />
        <CaptureUploadForm companySlug={companySlug} camera={false} />
      </div>
    </section>
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

export function ExpenseWhatsappConnectorCard({
  companySlug,
  configured,
  enabled,
  paired,
  businessNumber,
}: {
  companySlug: string;
  configured: boolean;
  enabled: boolean;
  paired: boolean;
  businessNumber: string | null;
}) {
  const [state, action] = useActionState(configureExpenseReceiptWhatsappAction, INITIAL_STATE);
  return (
    <section className="rounded-xl border border-emerald-100 bg-emerald-50 px-5 py-4 text-sm text-emerald-950">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Recibir comprobantes por WhatsApp</p>
          {!configured ? (
            <p className="mt-1 text-emerald-800">El administrador todavía debe conectar un número de WhatsApp Business.</p>
          ) : paired ? (
            <p className="mt-1 text-emerald-800">Número personal vinculado. Las fotos y PDF enviados a {businessNumber} aparecerán en esta bandeja.</p>
          ) : (
            <p className="mt-1 text-emerald-800">Vincula tu WhatsApp con un código temporal; el número real no se guarda en GESTORA.</p>
          )}
          {configured && !enabled && (
            <p className="mt-2 text-xs text-emerald-800">El canal está configurado, pero permanece pausado por seguridad.</p>
          )}
          {state.pairingCode && state.pairingUrl && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-white p-3">
              <p className="text-xs text-slate-600">Envía este mensaje dentro de 10 minutos:</p>
              <code className="mt-1 block select-all font-mono text-sm font-semibold text-slate-950">VINCULAR {state.pairingCode}</code>
              <a href={state.pairingUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700">
                Abrir WhatsApp
              </a>
            </div>
          )}
        </div>
        {configured && (enabled || paired) && (
          <form action={action} className="shrink-0 space-y-2">
            <input type="hidden" name="companySlug" value={companySlug} />
            <input type="hidden" name="intent" value={paired ? "disconnect" : "pair"} />
            <PendingButton tone={paired ? "danger" : "primary"}>{paired ? "Desvincular" : "Vincular WhatsApp"}</PendingButton>
          </form>
        )}
      </div>
      <div className="mt-3"><Feedback state={state} /></div>
    </section>
  );
}
