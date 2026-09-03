"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  addExpenseItemAction,
  cancelExpenseAdvanceAction,
  createExpenseReportAction,
  decideExpenseReportAction,
  grantExpenseAdvanceAction,
  linkExpenseReportToAdvanceAction,
  reconcileExpenseReportAction,
  reviewExpenseReceiptOcrAction,
  settleExpenseAdvanceAction,
  submitExpenseReportAction,
  updateCategoryLimitsAction,
  updateExpenseReportCostCenterAction,
  uploadExpenseReceiptAction,
  withdrawExpenseReportAction,
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

export function WithdrawExpenseReportForm({ companySlug, reportId }: { companySlug: string; reportId: string }) {
  const [state, action] = useActionState(withdrawExpenseReportAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <button
        type="submit"
        className="inline-flex w-full items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
      >
        Retirar y corregir
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function ReconcileExpenseReportForm({ companySlug, reportId }: { companySlug: string; reportId: string }) {
  const [state, action] = useActionState(reconcileExpenseReportAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <label className="block text-sm font-medium text-slate-700">
        Referencia de pago o asiento contable
        <input name="paymentReference" required maxLength={160} className={INPUT} placeholder="Ej. Transferencia #4821 o asiento 2026-0912" />
      </label>
      <Feedback state={state} />
      <SubmitButton tone="success">Marcar como pagada</SubmitButton>
    </form>
  );
}

export function CategoryLimitsForm({
  companySlug,
  policyId,
  categories,
  categoryLimits,
  secondApproverThreshold,
}: {
  companySlug: string;
  policyId: string;
  categories: ExpenseCategoryOption[];
  categoryLimits: Record<string, number>;
  secondApproverThreshold: number | null;
}) {
  const [state, action] = useActionState(updateCategoryLimitsAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="policyId" value={policyId} />
      <div className="space-y-3">
        {categories.map((category) => (
          <label key={category.id} className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
            {category.name}
            <input
              type="number"
              name={`limit_${category.id}`}
              min={1}
              step={1}
              placeholder="Sin límite"
              defaultValue={categoryLimits[category.id] ?? ""}
              className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-right text-sm shadow-sm focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">Deja vacío para no limitar esa categoría. Un gasto que supere su límite bloquea el envío hasta corregirlo.</p>
      <div className="border-t border-slate-200 pt-4">
        <label className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
          Monto que exige un segundo aprobador
          <input
            type="number"
            name="secondApproverThreshold"
            min={1}
            step={1}
            placeholder="Sin segundo paso"
            defaultValue={secondApproverThreshold ?? ""}
            className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-right text-sm shadow-sm focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </label>
        <p className="mt-2 text-xs text-slate-500">
          Si el total de la rendición supera este monto, se necesitan dos aprobaciones de personas distintas antes de
          aprobarla. Deja vacío para requerir siempre un solo paso.
        </p>
      </div>
      <SubmitButton>Guardar política</SubmitButton>
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

export function GrantExpenseAdvanceForm({
  companySlug,
  members,
}: {
  companySlug: string;
  members: Array<{ id: string; displayName: string }>;
}) {
  const [state, action] = useActionState(grantExpenseAdvanceAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <label className="block text-sm font-medium text-slate-700">
        Destinatario
        <select name="recipientId" required className={INPUT} defaultValue="">
          <option value="" disabled>Selecciona una persona…</option>
          {members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-700">
          Monto
          <input name="amount" type="number" min="0.01" step="0.01" inputMode="decimal" required className={INPUT} />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Moneda
          <select name="currencyCode" required className={INPUT} defaultValue="CLP">
            <option value="CLP">CLP</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select>
        </label>
      </div>
      <label className="block text-sm font-medium text-slate-700">
        Motivo
        <input name="purpose" required maxLength={240} className={INPUT} placeholder="Ej. Viaje a terreno Concepción" />
      </label>
      <Feedback state={state} />
      <SubmitButton>Otorgar anticipo</SubmitButton>
    </form>
  );
}

export function SettleExpenseAdvanceForm({ companySlug, advanceId }: { companySlug: string; advanceId: string }) {
  const [state, action] = useActionState(settleExpenseAdvanceAction, INITIAL_STATE);
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="advanceId" value={advanceId} />
      <button type="submit" className="text-xs font-medium text-arcotex-blue-dark hover:underline">Cerrar</button>
      {state.status === "error" && <p role="alert" className="text-xs text-critical">{state.message}</p>}
    </form>
  );
}

export function CancelExpenseAdvanceForm({ companySlug, advanceId }: { companySlug: string; advanceId: string }) {
  const [state, action] = useActionState(cancelExpenseAdvanceAction, INITIAL_STATE);
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="advanceId" value={advanceId} />
      <button type="submit" className="text-xs font-medium text-critical hover:underline">Cancelar</button>
      {state.status === "error" && <p role="alert" className="text-xs text-critical">{state.message}</p>}
    </form>
  );
}

export function LinkExpenseAdvanceForm({
  companySlug,
  reportId,
  currentAdvanceId,
  options,
}: {
  companySlug: string;
  reportId: string;
  currentAdvanceId: string | null;
  options: Array<{ id: string; amount: number; purpose: string; status: "PENDING" | "SETTLED" | "CANCELLED" }>;
}) {
  const [state, action] = useActionState(linkExpenseReportToAdvanceAction, INITIAL_STATE);
  if (options.length === 0 && !currentAdvanceId) return null;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <label className="block text-sm font-medium text-slate-700">
        Rendir contra un anticipo propio (opcional)
        <select name="advanceId" className={INPUT} defaultValue={currentAdvanceId ?? ""}>
          <option value="">Sin anticipo -- reembolso normal</option>
          {options.map((option) => (
            <option key={option.id} value={option.id} disabled={option.status !== "PENDING" && option.id !== currentAdvanceId}>
              {option.purpose} -- {option.amount.toLocaleString("es-CL")}
              {option.status !== "PENDING" ? ` (${option.status === "SETTLED" ? "ya cerrado" : "cancelado"})` : ""}
            </option>
          ))}
        </select>
      </label>
      {currentAdvanceId && options.find((option) => option.id === currentAdvanceId)?.status !== "PENDING" && (
        <p className="text-xs font-medium text-amber-700">
          El anticipo vinculado ya no está pendiente -- si sigue seleccionado y guardas sin cambiarlo, se mantiene igual; si necesitas desvincularlo, elige &quot;Sin anticipo&quot;.
        </p>
      )}
      <Feedback state={state} />
      <SubmitButton>Guardar</SubmitButton>
    </form>
  );
}

export function UpdateCostCenterForm({
  companySlug,
  reportId,
  currentOrganizationUnitId,
  options,
}: {
  companySlug: string;
  reportId: string;
  currentOrganizationUnitId: string | null;
  options: Array<{ id: string; name: string; code: string }>;
}) {
  const [state, action] = useActionState(updateExpenseReportCostCenterAction, INITIAL_STATE);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <label className="block text-sm font-medium text-slate-700">
        Centro de costo (opcional)
        <select name="organizationUnitId" className={INPUT} defaultValue={currentOrganizationUnitId ?? ""}>
          <option value="">Sin centro de costo</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>{option.name} ({option.code})</option>
          ))}
        </select>
      </label>
      <Feedback state={state} />
      <SubmitButton>Guardar</SubmitButton>
    </form>
  );
}
