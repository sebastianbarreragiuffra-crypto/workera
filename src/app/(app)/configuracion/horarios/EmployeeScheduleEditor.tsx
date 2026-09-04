"use client";

import { useActionState } from "react";
import type { ScheduleAdminRow, WorkScheduleSummary } from "../../../../lib/schedules/schedule-administration";
import {
  assignScheduleAction,
  setExemptionAction,
  clearExemptionAction,
  type ScheduleActionState,
} from "./actions";

const SCHEDULE_ACTION_INITIAL: ScheduleActionState = { status: "idle", message: "" };

/**
 * Editor de una sola fila. Se monta únicamente para el trabajador expandido,
 * de modo que cada instancia tenga su propio `useActionState` -- con un estado
 * compartido a nivel de tabla, el mensaje de una fila aparecería en otra.
 */
function FeedbackMessage({ status, message }: { status: "idle" | "success" | "error"; message: string }) {
  if (status === "idle" || !message) return null;
  const isError = status === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`mt-2 rounded-md border px-3 py-2 text-xs ${
        isError ? "border-critical-border bg-critical-bg text-critical" : "border-success-border bg-success-bg text-success"
      }`}
    >
      {isError ? message : `✓ ${message}`}
    </p>
  );
}

export function EmployeeScheduleEditor({
  row,
  schedules,
  today,
}: {
  row: ScheduleAdminRow;
  schedules: WorkScheduleSummary[];
  today: string;
}) {
  const [assignState, assignAction, assignPending] = useActionState(assignScheduleAction, SCHEDULE_ACTION_INITIAL);
  const [exemptState, exemptAction, exemptPending] = useActionState(setExemptionAction, SCHEDULE_ACTION_INITIAL);
  const [clearState, clearAction, clearPending] = useActionState(clearExemptionAction, SCHEDULE_ACTION_INITIAL);

  return (
    <div className="grid grid-cols-1 gap-4 rounded-md border border-border bg-slate-50 p-3 lg:grid-cols-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Asignar horario</h3>
        <form action={assignAction} className="mt-2 space-y-2">
          <input type="hidden" name="employeeId" value={row.employeeId} />
          <label className="block">
            <span className="text-xs text-slate-600">Horario</span>
            <select
              name="workScheduleId"
              required
              defaultValue={row.workScheduleId ?? schedules[0]?.id ?? ""}
              className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm"
            >
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-600">Vigente desde</span>
            <input
              type="date"
              name="effectiveFrom"
              required
              defaultValue={today}
              className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            disabled={assignPending}
            className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {assignPending ? "Guardando..." : "Asignar horario"}
          </button>
        </form>
        <FeedbackMessage status={assignState.status} message={assignState.message} />
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Control horario</h3>

        {row.timeControl === "EXEMPT" ? (
          <>
            <p className="mt-2 text-xs text-slate-600">
              Hoy está exento de control horario. Mientras lo esté, no se le calculan atrasos, salidas anticipadas ni horas extra.
            </p>
            <form action={clearAction} className="mt-2 space-y-2">
              <input type="hidden" name="employeeId" value={row.employeeId} />
              <label className="block">
                <span className="text-xs text-slate-600">Vuelve a control normal desde</span>
                <input
                  type="date"
                  name="effectiveFrom"
                  required
                  defaultValue={today}
                  className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <button
                type="submit"
                disabled={clearPending}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {clearPending ? "Guardando..." : "Quitar exención"}
              </button>
            </form>
            <FeedbackMessage status={clearState.status} message={clearState.message} />
          </>
        ) : (
          <>
            <p className="mt-2 text-xs text-slate-600">
              Marca como exento a quien no debe marcar entrada/salida. El motor deja de generar atrasos y horas extra para esa persona.
            </p>
            <form action={exemptAction} className="mt-2 space-y-2">
              <input type="hidden" name="employeeId" value={row.employeeId} />
              <label className="block">
                <span className="text-xs text-slate-600">Base legal</span>
                <select name="legalBasis" required defaultValue="ARTICLE_22" className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm">
                  <option value="ARTICLE_22">Artículo 22</option>
                  <option value="NO_MARKING_REQUIRED">No requiere marcación</option>
                  <option value="OTHER">Otro</option>
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-slate-600">Motivo</span>
                <input
                  type="text"
                  name="reason"
                  required
                  maxLength={300}
                  placeholder="Por qué queda exento"
                  className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-xs text-slate-600">Vigente desde</span>
                <input
                  type="date"
                  name="effectiveFrom"
                  required
                  defaultValue={today}
                  className="mt-1 w-full rounded-md border border-border bg-white px-2 py-1.5 text-sm"
                />
              </label>
              <button
                type="submit"
                disabled={exemptPending}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {exemptPending ? "Guardando..." : "Marcar como exento"}
              </button>
            </form>
            <FeedbackMessage status={exemptState.status} message={exemptState.message} />
          </>
        )}
      </div>
    </div>
  );
}
