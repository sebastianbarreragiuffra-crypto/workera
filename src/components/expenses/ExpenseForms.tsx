"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  addExpenseItemAction,
  createExpenseReportAction,
  decideExpenseReportAction,
  reviewExpenseReceiptOcrAction,
  submitExpenseReportAction,
  uploadExpenseReceiptAction,
  type ExpenseActionState,
} from "@/app/(expenses)/empresas/[companySlug]/rendiciones/actions";
import type { ExpenseCategoryOption } from "@/lib/expenses/data";

const INITIAL_STATE: ExpenseActionState = { status: "idle", message: "" };
const INPUT = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100";

function Feedback({ state }: { state: ExpenseActionState }) {
  if (state.status === "idle") return null;
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${state.status === "error" ? "bg-critical-bg text-critical" : "bg-success-bg text-success"}`}>
      {state.message}
    </p>
  );
}

function SubmitButton({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "success" }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:cursor-wait disabled:opacity-60 ${tone === "success" ? "bg-success hover:bg-green-800" : "bg-arcotex-blue hover:bg-arcotex-blue-dark"}`}
    >
      {pending ? "Guardando…" : children}
    </button>
  );
}

export function CreateExpenseReportForm({ companySlug }: { companySlug: string }) {
  const [state, action] = useActionState(createExpenseReportAction, INITIAL_STATE);
  // Estable mientras el formulario esté montado -- un doble clic o un
  // reintento de red reenvía el MISMO id, así que create_expense_report()
  // devuelve el borrador ya creado en vez de duplicarlo. Solo una recarga
  // completa de la página genera uno nuevo, que es un intento nuevo real.
  const [clientRequestId] = useState(() => crypto.randomUUID());
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="clientRequestId" value={clientRequestId} />
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">
          Nombre de la rendición
          <input name="title" required minLength={2} maxLength={160} className={INPUT} placeholder="Ej. Visita comercial a Antofagasta" autoFocus />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Moneda
          <select name="currencyCode" defaultValue="CLP" className={INPUT}>
            <option value="CLP">Peso chileno (CLP)</option>
            <option value="USD">Dólar estadounidense (USD)</option>
            <option value="EUR">Euro (EUR)</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">
          Motivo o contexto
          <textarea name="purpose" maxLength={1000} rows={4} className={INPUT} placeholder="Describe brevemente para qué se realizaron estos gastos." />
        </label>
      </div>
      <Feedback state={state} />
      <div className="flex justify-end"><SubmitButton>Crear borrador</SubmitButton></div>
    </form>
  );
}

export function AddExpenseItemForm({
  companySlug,
  reportId,
  currencyCode,
  categories,
  defaultDate,
}: {
  companySlug: string;
  reportId: string;
  currencyCode: string;
  categories: ExpenseCategoryOption[];
  defaultDate: string;
}) {
  const [state, action] = useActionState(addExpenseItemAction, INITIAL_STATE);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.status === "success") formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <input type="hidden" name="currencyCode" value={currencyCode} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-medium text-slate-700">
          Fecha
          <input name="expenseDate" type="date" required defaultValue={defaultDate} className={INPUT} />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Categoría
          <select name="categoryId" defaultValue="" className={INPUT}>
            <option value="">Sin categoría</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">
          Comercio o proveedor
          <input name="merchantName" maxLength={160} className={INPUT} placeholder="Opcional" />
        </label>
        <label className="text-sm font-medium text-slate-700 sm:col-span-2">
          Descripción
          <input name="description" required minLength={2} maxLength={240} className={INPUT} placeholder="Ej. Almuerzo con cliente" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Neto ({currencyCode})
          <input name="netAmount" type="number" required min="0.01" step="0.01" inputMode="decimal" className={INPUT} placeholder="0" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Impuesto ({currencyCode})
          <input name="taxAmount" type="number" min="0" step="0.01" inputMode="decimal" defaultValue="0" className={INPUT} />
        </label>
      </div>
      <Feedback state={state} />
      <div className="flex justify-end"><SubmitButton>Agregar gasto</SubmitButton></div>
    </form>
  );
}

export function SubmitExpenseReportForm({ companySlug, reportId, disabled }: { companySlug: string; reportId: string; disabled: boolean }) {
  const [state, action] = useActionState(submitExpenseReportAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <button
        type="submit"
        disabled={disabled}
        className="inline-flex w-full items-center justify-center rounded-lg bg-success px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-green-800 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        Enviar a revisión
      </button>
      {disabled && <p className="text-center text-xs text-slate-500">Agrega al menos un gasto antes de enviar.</p>}
      <Feedback state={state} />
    </form>
  );
}

export function ExpenseReceiptUploadForm({
  companySlug,
  reportId,
  itemId,
  hasReceipt,
}: {
  companySlug: string;
  reportId: string;
  itemId: string;
  hasReceipt: boolean;
}) {
  const [state, action] = useActionState(uploadExpenseReceiptAction, INITIAL_STATE);
  return (
    <form action={action} className="mt-3 space-y-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <input type="hidden" name="itemId" value={itemId} />
      <label className="block text-xs font-medium text-slate-700">
        {hasReceipt ? "Reemplazar comprobante" : "Adjuntar comprobante"}
        <input name="receipt" type="file" required accept="application/pdf,image/jpeg,image/png" className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-white file:px-3 file:py-2 file:text-xs file:font-semibold file:text-arcotex-blue-dark" />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">PDF, JPG o PNG · máximo 10 MB</span>
        <SubmitButton>{hasReceipt ? "Reemplazar" : "Adjuntar"}</SubmitButton>
      </div>
      <Feedback state={state} />
    </form>
  );
}

export function ExpenseDecisionForm({ companySlug, reportId }: { companySlug: string; reportId: string }) {
  const [state, action] = useActionState(decideExpenseReportAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <label className="block text-sm font-medium text-slate-700">
        Decisión
        <select name="decision" defaultValue="APPROVED" className={INPUT}>
          <option value="APPROVED">Aprobar</option>
          <option value="RETURNED">Devolver para corregir</option>
          <option value="REJECTED">Rechazar</option>
        </select>
      </label>
      <label className="block text-sm font-medium text-slate-700">
        Comentario
        <textarea name="comment" maxLength={1000} rows={3} className={INPUT} placeholder="Obligatorio al devolver o rechazar" />
      </label>
      <Feedback state={state} />
      <SubmitButton tone="success">Registrar decisión</SubmitButton>
    </form>
  );
}

export function ExpenseOcrReviewForm({
  companySlug,
  reportId,
  receiptId,
}: {
  companySlug: string;
  reportId: string;
  receiptId: string;
}) {
  const [state, action] = useActionState(reviewExpenseReceiptOcrAction, INITIAL_STATE);
  return (
    <form action={action} className="mt-3 space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <input type="hidden" name="receiptId" value={receiptId} />
      <label className="block text-xs font-medium text-slate-700">
        Revisión de la sugerencia
        <select name="decision" defaultValue="ACCEPTED" className={INPUT}>
          <option value="ACCEPTED">Aceptar como referencia</option>
          <option value="REJECTED">Rechazar sugerencia</option>
        </select>
      </label>
      <label className="block text-xs font-medium text-slate-700">
        Comentario
        <textarea name="comment" maxLength={1000} rows={2} className={INPUT} placeholder="Obligatorio al rechazar" />
      </label>
      <Feedback state={state} />
      <SubmitButton>Registrar revisión</SubmitButton>
    </form>
  );
}
