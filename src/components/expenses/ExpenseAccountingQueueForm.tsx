"use client";

import { useActionState } from "react";
import { queueExpenseAccountingExportAction, type ExpenseActionState } from "@/app/(expenses)/empresas/[companySlug]/rendiciones/actions";

const initialState: ExpenseActionState = { status: "idle", message: "" };

export function ExpenseAccountingQueueForm({ companySlug, reportId }: { companySlug: string; reportId: string }) {
  const [state, action, pending] = useActionState(queueExpenseAccountingExportAction, initialState);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="reportId" value={reportId} />
      <button type="submit" disabled={pending} className="min-h-11 rounded-md bg-arcotex-navy px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {pending ? "Preparando…" : "Preparar salida"}
      </button>
      {state.message && <p className={`max-w-xs text-right text-xs ${state.status === "error" ? "text-red-700" : "text-emerald-700"}`}>{state.message}</p>}
    </form>
  );
}
