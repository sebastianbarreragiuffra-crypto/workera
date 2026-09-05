"use client";

import { useActionState } from "react";
import { SectionCard } from "../../../../components/shell/SectionCard";
import { createScheduleAction, type ScheduleActionState } from "./actions";

const SCHEDULE_ACTION_INITIAL: ScheduleActionState = { status: "idle", message: "" };

/**
 * Crea un horario con la forma que la empresa usa realmente: una entrada, una
 * salida lunes-jueves y una salida de viernes (más sábado opcional). Cubre el
 * horario estándar de planta y las excepciones individuales confirmadas
 * (Valencia 08:30-18:00/15:50, Vera 08:00-17:30/15:20) sin pedirle al usuario
 * llenar siete tramos día por día.
 */
export function CreateScheduleCard() {
  const [state, action, pending] = useActionState(createScheduleAction, SCHEDULE_ACTION_INITIAL);

  return (
    <SectionCard title="Crear horario">
      <p className="text-xs text-slate-500">
        Para excepciones individuales o turnos distintos al estándar. Una vez creado, puedes asignárselo a quien corresponda en la tabla de
        abajo.
      </p>

      <form action={action} className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Nombre</span>
          <input
            type="text"
            name="name"
            required
            maxLength={120}
            placeholder="Horario individual — Nombre Apellido"
            className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Entrada</span>
            <input type="time" name="start" required defaultValue="07:30" className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Salida L-J</span>
            <input type="time" name="endMonThu" required defaultValue="17:00" className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Salida viernes</span>
            <input type="time" name="endFri" required defaultValue="14:50" className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">
              Salida sábado <span className="font-normal text-slate-400">(opcional)</span>
            </span>
            <input type="time" name="endSat" className="mt-1 w-full rounded-md border border-border px-2 py-1.5 text-sm" />
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-arcotex-blue px-3 py-1.5 text-sm font-medium text-arcotex-blue hover:bg-arcotex-blue/5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Creando..." : "Crear horario"}
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
