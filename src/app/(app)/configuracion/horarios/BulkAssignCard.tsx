"use client";

import { useActionState } from "react";
import { SectionCard } from "../../../../components/shell/SectionCard";
import type { WorkScheduleSummary } from "../../../../lib/schedules/schedule-administration";
import { assignScheduleToUnassignedAction, SCHEDULE_ACTION_INITIAL } from "./actions";

/**
 * Acción masiva: el camino rápido para dejar operativa la marcha blanca. Nunca
 * pisa una asignación existente ni toca a un exento -- la RPC
 * `assign_schedule_to_unassigned` filtra ambos casos en SQL, así que reaplicar
 * esta acción es seguro.
 */
export function BulkAssignCard({
  schedules,
  today,
  unassignedCount,
}: {
  schedules: WorkScheduleSummary[];
  today: string;
  unassignedCount: number;
}) {
  const [state, action, pending] = useActionState(assignScheduleToUnassignedAction, SCHEDULE_ACTION_INITIAL);

  return (
    <SectionCard title="Asignar horario base">
      <p className="text-xs text-slate-500">
        Asigna un horario a todos los trabajadores activos que hoy no tienen ninguno. No modifica a quien ya tiene horario ni a los
        exentos.
      </p>

      <form action={action} className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Horario</span>
          <select
            name="workScheduleId"
            required
            defaultValue={schedules[0]?.id ?? ""}
            className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
          >
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-600">Vigente desde</span>
          <input
            type="date"
            name="effectiveFrom"
            required
            defaultValue={today}
            className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
          />
        </label>

        <button
          type="submit"
          disabled={pending || schedules.length === 0}
          className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Asignando..." : `Asignar a los ${unassignedCount} sin horario`}
        </button>
      </form>

      {state.status === "success" && (
        <p role="status" className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
          ✓ {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
          {state.message}
        </p>
      )}
    </SectionCard>
  );
}
