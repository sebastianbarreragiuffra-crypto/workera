"use client";

import { useActionState } from "react";
import { Badge, type BadgeTone } from "../../../components/shell/Badge";
import { SectionCard } from "../../../components/shell/SectionCard";
import {
  ALLOWED_TRANSITIONS,
  statusLabel,
  type ReportingPeriod,
  type ReportingPeriodStatus,
} from "../../../lib/periods/reporting-period-status";
import { createPeriodAction, transitionPeriodAction, type PeriodActionState } from "./actions";

const PERIOD_ACTION_INITIAL: PeriodActionState = { status: "idle", message: "" };

const STATUS_TONE: Record<ReportingPeriodStatus, BadgeTone> = {
  OPEN: "info",
  IN_REVIEW: "warning",
  READY_TO_CLOSE: "warning",
  CLOSED: "positive",
  REOPENED: "negative",
};

function Feedback({ state }: { state: { status: string; message: string } }) {
  if (state.status === "idle" || !state.message) return null;
  const isError = state.status === "error";
  return (
    <p
      role={isError ? "alert" : "status"}
      className={`mt-3 rounded-md border px-3 py-2 text-sm ${
        isError ? "border-critical-border bg-critical-bg text-critical" : "border-success-border bg-success-bg text-success"
      }`}
    >
      {isError ? state.message : `✓ ${state.message}`}
    </p>
  );
}

function CreatePeriodCard({ suggested }: { suggested: { periodStart: string; periodEnd: string; label: string } }) {
  const [state, action, pending] = useActionState(createPeriodAction, PERIOD_ACTION_INITIAL);

  return (
    <SectionCard title="Crear período de pago">
      <p className="text-xs text-slate-500">
        El ciclo de la empresa va del 16 de un mes al 15 del siguiente. La sugerencia es el ciclo que sigue al último período registrado.
      </p>
      <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Inicio</span>
          <input
            type="date"
            name="periodStart"
            required
            defaultValue={suggested.periodStart}
            className="mt-1 block rounded-md border border-border px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Término</span>
          <input
            type="date"
            name="periodEnd"
            required
            defaultValue={suggested.periodEnd}
            className="mt-1 block rounded-md border border-border px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Creando..." : "Crear período"}
        </button>
      </form>
      <p className="mt-2 text-xs text-slate-400">Sugerido: {suggested.label}</p>
      <Feedback state={state} />
    </SectionCard>
  );
}

function TransitionButton({ period, to }: { period: ReportingPeriod; to: ReportingPeriodStatus }) {
  const [state, action, pending] = useActionState(transitionPeriodAction, PERIOD_ACTION_INITIAL);
  const needsReason = to === "REOPENED";

  return (
    <form action={action} className="inline-flex flex-col gap-1">
      <input type="hidden" name="periodId" value={period.id} />
      <input type="hidden" name="from" value={period.status} />
      <input type="hidden" name="to" value={to} />
      {needsReason && (
        <input
          type="text"
          name="reopenReason"
          required
          maxLength={300}
          placeholder="Motivo de la reapertura"
          className="rounded-md border border-slate-300 px-2 py-1 text-xs"
        />
      )}
      <button
        type="submit"
        disabled={pending}
        className={`rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-60 ${
          to === "CLOSED"
            ? "border-success-border bg-success-bg text-success hover:bg-success-bg/70"
            : to === "REOPENED"
              ? "border-critical-border bg-critical-bg text-critical hover:bg-critical-bg/70"
              : "border-border text-slate-700 hover:bg-slate-50"
        }`}
      >
        {pending ? "..." : `→ ${statusLabel(to)}`}
      </button>
      {state.status === "error" && <span className="text-[11px] text-critical">{state.message}</span>}
    </form>
  );
}

export function PeriodsClient({
  periods,
  suggestedNext,
}: {
  periods: ReportingPeriod[];
  suggestedNext: { periodStart: string; periodEnd: string; label: string };
}) {
  return (
    <div className="space-y-4">
      <CreatePeriodCard suggested={suggestedNext} />

      <SectionCard title={`Períodos (${periods.length})`}>
        {periods.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Todavía no hay ningún período de pago. Mientras no haya un período cerrado, nada impide corregir marcaciones de fechas ya
            pagadas.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2 font-semibold">Período</th>
                  <th className="px-2 py-2 font-semibold">Estado</th>
                  <th className="px-2 py-2 font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.id} className="border-b border-border/60 align-top">
                    <td className="px-2 py-2 font-medium text-slate-900">
                      {period.periodStart} al {period.periodEnd}
                      {period.reopenReason && (
                        <span className="mt-0.5 block text-[11px] font-normal text-slate-500">Reapertura: {period.reopenReason}</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Badge label={statusLabel(period.status)} tone={STATUS_TONE[period.status]} />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-wrap gap-2">
                        {ALLOWED_TRANSITIONS[period.status].map((to) => (
                          <TransitionButton key={to} period={period} to={to} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
