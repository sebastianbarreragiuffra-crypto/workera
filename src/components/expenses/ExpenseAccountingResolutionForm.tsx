"use client";

import { useActionState, useState } from "react";
import {
  resolveExpenseAccountingExportAction,
  type ExpenseActionState,
} from "@/app/(expenses)/empresas/[companySlug]/rendiciones/actions";

const initialState: ExpenseActionState = { status: "idle", message: "" };

type Resolution = "REQUEUE" | "CONFIRM_SUCCEEDED" | "CANCEL";

export function ExpenseAccountingResolutionForm({
  companySlug,
  exportId,
  requeueEnabled,
}: {
  companySlug: string;
  exportId: string;
  requeueEnabled: boolean;
}) {
  const [resolution, setResolution] = useState<Resolution>(
    requeueEnabled ? "REQUEUE" : "CONFIRM_SUCCEEDED"
  );
  const [state, action, pending] = useActionState(resolveExpenseAccountingExportAction, initialState);
  const requiresAbsenceConfirmation = resolution === "REQUEUE" || resolution === "CANCEL";

  return (
    <form action={action} className="min-w-72 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="exportId" value={exportId} />
      <label className="block text-xs font-semibold text-slate-700">
        Resolución
        <select
          name="resolution"
          value={resolution}
          onChange={(event) => setResolution(event.target.value as Resolution)}
          className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
        >
          {requeueEnabled && <option value="REQUEUE">Reintentar de forma segura</option>}
          <option value="CONFIRM_SUCCEEDED">Confirmar asiento existente</option>
          <option value="CANCEL">Cancelar salida</option>
        </select>
      </label>
      {!requeueEnabled && (
        <p className="rounded-md bg-amber-100 px-2 py-1.5 text-xs leading-5 text-amber-900">
          El replay está pausado. Aún puedes confirmar un asiento existente o cancelar una salida verificada como ausente.
        </p>
      )}
      <label className="block text-xs font-semibold text-slate-700">
        Motivo de auditoría
        <textarea
          name="reason"
          required
          minLength={8}
          maxLength={240}
          rows={2}
          className="mt-1 w-full rounded-md border border-slate-300 bg-white p-2 text-sm"
          placeholder="Describe la verificación realizada"
        />
      </label>
      {resolution === "CONFIRM_SUCCEEDED" && (
        <label className="block text-xs font-semibold text-slate-700">
          Referencia del ERP
          <input
            name="externalReference"
            required
            maxLength={160}
            className="mt-1 min-h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
            placeholder="Ej.: ASIENTO-2026-0041"
          />
        </label>
      )}
      {requiresAbsenceConfirmation && (
        <label className="flex items-start gap-2 text-xs leading-5 text-slate-700">
          <input name="confirmNotExported" type="checkbox" required className="mt-1 size-4" />
          Verifiqué en el ERP que el asiento no existe. Esta confirmación evita duplicados.
        </label>
      )}
      <button
        type="submit"
        disabled={pending}
        className="min-h-10 w-full rounded-md bg-arcotex-navy px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Registrando…" : "Registrar resolución"}
      </button>
      {state.message && (
        <p role="status" className={`text-xs ${state.status === "error" ? "text-red-700" : "text-emerald-700"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
