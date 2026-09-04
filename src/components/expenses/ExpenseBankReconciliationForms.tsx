"use client";

import { useActionState, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import {
  ignoreExpenseBankTransactionAction,
  matchExpenseBankTransactionAction,
  type ExpenseActionState,
} from "@/app/(expenses)/empresas/[companySlug]/rendiciones/actions";
import { EXPENSE_BANK_STATEMENT_MAX_BYTES } from "@/lib/expenses/bank-statement";
import type { ExpenseBankCandidate } from "@/lib/expenses/data";
import { formatExpenseMoney } from "@/lib/expenses/presentation";

const INITIAL_STATE: ExpenseActionState = { status: "idle", message: "" };

function Feedback({ state }: { state: ExpenseActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={`rounded-lg px-3 py-2 text-sm ${state.status === "error" ? "bg-critical-bg text-critical" : "bg-success-bg text-success"}`}
    >
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
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold disabled:cursor-wait disabled:opacity-60 ${
        tone === "danger"
          ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          : "bg-arcotex-blue text-white hover:bg-arcotex-blue-dark"
      }`}
    >
      {pending ? "Procesando…" : children}
    </button>
  );
}

export function ExpenseBankStatementImportForm({ companySlug }: { companySlug: string }) {
  const router = useRouter();
  const [state, setState] = useState<ExpenseActionState>(INITIAL_STATE);
  const [pending, setPending] = useState(false);

  async function submitStatement(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("statement");
    if (!(file instanceof File) || file.size <= 0) {
      setState({ status: "error", message: "Selecciona una cartola CSV válida." });
      return;
    }
    if (file.size > EXPENSE_BANK_STATEMENT_MAX_BYTES) {
      setState({ status: "error", message: "La cartola supera el máximo de 2 MB." });
      return;
    }
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setState({ status: "error", message: "Exporta la cartola como archivo CSV antes de subirla." });
      return;
    }

    setPending(true);
    setState(INITIAL_STATE);
    try {
      const response = await fetch(`/api/expenses/${encodeURIComponent(companySlug)}/bank-import`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: file,
      });
      const payload = await response.json().catch(() => null) as { status?: string; message?: string } | null;
      const message = typeof payload?.message === "string"
        ? payload.message
        : "No pudimos importar la cartola. Intenta nuevamente.";
      if (!response.ok || payload?.status !== "success") {
        setState({ status: "error", message });
        return;
      }
      form.reset();
      setState({ status: "success", message });
      router.refresh();
    } catch {
      setState({ status: "error", message: "No pudimos conectar con el servidor. Intenta nuevamente." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submitStatement} className="space-y-3">
      <label className="block text-sm font-medium text-slate-700">
        Cartola bancaria en CSV
        <input
          type="file"
          name="statement"
          accept=".csv,text/csv"
          required
          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-medium"
        />
      </label>
      <p className="text-xs leading-5 text-slate-500">
        Máximo 2 MB y 2.000 filas. Columnas: <strong>fecha, monto, moneda, referencia</strong> y, opcionalmente, descripción.
        El archivo original y los números de cuenta no se guardan.
      </p>
      <Feedback state={state} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-arcotex-blue px-4 py-2.5 text-sm font-semibold text-white hover:bg-arcotex-blue-dark disabled:cursor-wait disabled:opacity-60"
      >
        {pending ? "Importando…" : "Importar movimientos"}
      </button>
    </form>
  );
}

function ExpenseBankMatchForm({
  companySlug,
  transactionId,
  candidate,
}: {
  companySlug: string;
  transactionId: string;
  candidate: ExpenseBankCandidate;
}) {
  const [state, action] = useActionState(matchExpenseBankTransactionAction, INITIAL_STATE);
  return (
    <form action={action} className="rounded-lg border border-slate-200 p-3">
      <input type="hidden" name="companySlug" value={companySlug} />
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="reportId" value={candidate.reportId} />
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="font-medium text-slate-900">{candidate.referenceNumber} · {candidate.title}</p>
          <p className="mt-1 text-xs text-slate-500">
            {candidate.submitterName} · {formatExpenseMoney(candidate.totalAmount, candidate.currencyCode)} · diferencia de {candidate.dateDistanceDays} día(s)
          </p>
        </div>
        <PendingButton>Confirmar enlace</PendingButton>
      </div>
      <div className="mt-2"><Feedback state={state} /></div>
    </form>
  );
}

export function ExpenseBankResolutionForms({
  companySlug,
  transactionId,
  candidates,
}: {
  companySlug: string;
  transactionId: string;
  candidates: ExpenseBankCandidate[];
}) {
  const [ignoreState, ignoreAction] = useActionState(ignoreExpenseBankTransactionAction, INITIAL_STATE);
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="font-medium text-slate-900">Rendiciones sugeridas</h3>
        <p className="text-xs leading-5 text-slate-500">Mismo monto y moneda, hasta 45 días de diferencia. La asociación solo ocurre cuando la confirmas.</p>
        {candidates.length === 0 ? (
          <p className="rounded-lg bg-slate-50 px-3 py-4 text-sm text-slate-600">No encontramos una rendición aprobada que coincida exactamente.</p>
        ) : candidates.map((candidate) => (
          <ExpenseBankMatchForm key={candidate.reportId} companySlug={companySlug} transactionId={transactionId} candidate={candidate} />
        ))}
      </div>

      <form action={ignoreAction} className="space-y-3 border-t border-slate-200 pt-4">
        <input type="hidden" name="companySlug" value={companySlug} />
        <input type="hidden" name="transactionId" value={transactionId} />
        <label className="block text-sm font-medium text-slate-700">
          Apartar movimiento que no corresponde a una rendición
          <input
            name="reason"
            required
            minLength={3}
            maxLength={240}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm"
            placeholder="Ej. Pago de proveedor, no reembolso"
          />
        </label>
        <Feedback state={ignoreState} />
        <PendingButton tone="danger">Apartar con motivo</PendingButton>
      </form>
    </div>
  );
}
