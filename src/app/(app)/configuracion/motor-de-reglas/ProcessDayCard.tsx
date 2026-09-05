"use client";

import { useActionState } from "react";
import { SectionCard } from "../../../../components/shell/SectionCard";
import { processAttendanceDayAction, type ProcessDayActionState } from "./actions";

const PROCESS_DAY_INITIAL: ProcessDayActionState = { status: "idle", message: "" };

const TONE_CLASS = {
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  error: "border-critical-border bg-critical-bg text-critical",
} as const;

export function ProcessDayCard({ defaultDate }: { defaultDate: string }) {
  const [state, action, pending] = useActionState(processAttendanceDayAction, PROCESS_DAY_INITIAL);

  return (
    <SectionCard title="Procesar un día">
      <p className="text-xs text-slate-500">
        Deriva las marcaciones de Workera a asistencia diaria y genera los candidatos de atraso, salida anticipada y horas extra para la
        fecha elegida. Es seguro repetirlo: reprocesar no duplica nada.
      </p>

      <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Fecha</span>
          <input
            type="date"
            name="date"
            required
            defaultValue={defaultDate}
            className="mt-1 rounded-md border border-border px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Procesando..." : "Procesar día"}
        </button>
      </form>

      {state.status !== "idle" && (
        <p
          role={state.status === "error" ? "alert" : "status"}
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${TONE_CLASS[state.status]}`}
        >
          {state.status === "success" ? `✓ ${state.message}` : state.message}
        </p>
      )}
    </SectionCard>
  );
}
