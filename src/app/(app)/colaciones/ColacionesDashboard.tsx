"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "../../../components/shell/PageHeader";
import { Badge } from "../../../components/shell/Badge";
import { SectionCard } from "../../../components/shell/SectionCard";
import { downloadProductionDiscountExcel } from "../../../lib/colaciones/excel-export";
import { PRODUCTION_MEAL_PRICES } from "../../../lib/colaciones/pricing";
import type { ProductionMealDiscountDataset } from "../../../lib/colaciones/types";
import { MenuUploadDashboard } from "./MenuUploadDashboard";
import { ActiveMealFormDashboard } from "./ActiveMealFormDashboard";
import type { CreatedWeeklyMealGoogleForm } from "../../../lib/colaciones/google-forms";
import type { MealResponseTracking } from "../../../lib/colaciones/response-tracking";
import type { MealFormBusinessState } from "../../../lib/colaciones/form-business-state";

type Panel = "menu" | "responses" | "billing";

const STEPS: Array<{ id: Panel; title: string; subtitle: string }> = [
  { id: "menu", title: "Menú proveedor", subtitle: "Recibido por Google Forms" },
  { id: "responses", title: "Respuestas", subtitle: "Seguimiento real" },
  { id: "billing", title: "Descuentos y Excel", subtitle: "Solo Producción" },
];

const EMPTY_DISCOUNT_DATASET: ProductionMealDiscountDataset = {
  sourceFile: "DESCUENTO DE COLACIONES.xlsx",
  cycleName: "Sin datos",
  cycleStart: "1970-01-01",
  cycleEnd: "1970-01-01",
  records: [],
  registeredAmounts: [],
  pricingMismatchCount: 0,
};

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatShortDate(dateIso: string) {
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${dateIso}T12:00:00Z`));
}

function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekLabel(weekStart: string) {
  return `${formatShortDate(weekStart)}–${formatShortDate(addDays(weekStart, 4))}`;
}

function reviewDayLabel(dateIso: string) {
  return new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" }).format(new Date(`${dateIso}T12:00:00Z`));
}

function ActionNotice({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div role="status" className="rounded-md border border-info-border bg-info-bg px-3 py-2 text-sm text-info">
      {message}
    </div>
  );
}

export function ColacionesDashboard({
  discountDataset,
  discountError,
  recentForms,
  formsError,
  activeForm,
  formBusinessState,
  responseTracking,
  trackingError,
}: {
  discountDataset: ProductionMealDiscountDataset | null;
  discountError: string | null;
  recentForms: CreatedWeeklyMealGoogleForm[];
  formsError: string | null;
  activeForm: CreatedWeeklyMealGoogleForm | null;
  formBusinessState: MealFormBusinessState;
  responseTracking: MealResponseTracking | null;
  trackingError: string | null;
}) {
  const dataset = discountDataset ?? EMPTY_DISCOUNT_DATASET;
  const [panel, setPanel] = useState<Panel>("menu");
  const [message, setMessage] = useState("");
  const [exporting, setExporting] = useState(false);
  const availableDates = useMemo(
    () => [...new Set(dataset.records.map((record) => record.date))].sort(),
    [dataset.records],
  );
  const [selectedReviewDate, setSelectedReviewDate] = useState(() => availableDates.at(-1) ?? "");
  const selectedDayRecords = useMemo(
    () => dataset.records.filter((record) => record.date === selectedReviewDate),
    [dataset.records, selectedReviewDate],
  );
  const availableWeeks = useMemo(
    () => [...new Set(dataset.records.map((record) => record.weekStart))].sort(),
    [dataset.records],
  );
  const [selectedWeek, setSelectedWeek] = useState(() => availableWeeks.at(-1) ?? "");
  const selectedWeekRecords = useMemo(
    () => dataset.records.filter((record) => record.weekStart === selectedWeek),
    [dataset.records, selectedWeek],
  );
  const monthlyTotal = useMemo(
    () => dataset.records.reduce((sum, record) => sum + record.amount, 0),
    [dataset.records],
  );
  const selectedWeekTotal = useMemo(
    () => selectedWeekRecords.reduce((sum, record) => sum + record.amount, 0),
    [selectedWeekRecords],
  );
  const workerSummary = useMemo(() => {
    const workers = new Map<string, { monthlyMeals: number; monthlyTotal: number; weeklyMeals: number; weeklyTotal: number }>();
    for (const record of dataset.records) {
      const current = workers.get(record.workerName) ?? { monthlyMeals: 0, monthlyTotal: 0, weeklyMeals: 0, weeklyTotal: 0 };
      current.monthlyMeals += 1;
      current.monthlyTotal += record.amount;
      if (record.weekStart === selectedWeek) {
        current.weeklyMeals += 1;
        current.weeklyTotal += record.amount;
      }
      workers.set(record.workerName, current);
    }
    return [...workers.entries()].sort(([a], [b]) => a.localeCompare(b, "es"));
  }, [dataset.records, selectedWeek]);

  async function downloadExcel(scope: "daily" | "weekly" | "monthly") {
    const isDaily = scope === "daily";
    const isWeekly = scope === "weekly";
    const records = isDaily ? selectedDayRecords : isWeekly ? selectedWeekRecords : dataset.records;
    if (!records.length) return;
    setExporting(true);
    try {
      const label = isDaily ? `REVISIÓN ${reviewDayLabel(selectedReviewDate)}` : isWeekly ? `SEMANA ${weekLabel(selectedWeek)}` : dataset.cycleName.toUpperCase();
      const filename = isDaily
        ? `revision-colaciones-produccion-${selectedReviewDate}.xlsx`
        : isWeekly
          ? `descuento-almuerzos-produccion-semana-${selectedWeek}.xlsx`
          : `descuento-almuerzos-produccion-${dataset.cycleName.toLowerCase().replaceAll(" ", "-")}.xlsx`;
      const periodLabel = isDaily
        ? `Revisión diaria RRHH · ${reviewDayLabel(selectedReviewDate)}`
        : isWeekly
          ? `Semana ${weekLabel(selectedWeek)}`
          : `Ciclo ${formatShortDate(dataset.cycleStart)} al ${formatShortDate(dataset.cycleEnd)}`;
      await downloadProductionDiscountExcel({
        records,
        title: `DESCUENTO ALMUERZOS PRODUCCIÓN - ${label}`,
        filename,
        periodLabel,
      });
      setMessage(isDaily ? "Revisión diaria descargada para RRHH." : isWeekly ? "Excel semanal descargado con el formato de descuentos." : "Excel mensual acumulado descargado correctamente.");
    } finally {
      setExporting(false);
    }
  }

  function goTo(nextPanel: Panel) {
    setPanel(nextPanel);
    setMessage("");
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Colaciones"
        subtitle="Planifica el menú, comparte el formulario y prepara los cobros semanales."
        actions={
          <button
            type="button"
            onClick={() => goTo("menu")}
            className="rounded-md bg-arcotex-blue px-3 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            + Nueva semana
          </button>
        }
      />

      <section aria-label="Paneles de colaciones" className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <button
          type="button"
          onClick={() => goTo("menu")}
          aria-pressed={panel !== "billing"}
          className={`rounded-xl border p-4 text-left shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue ${
            panel !== "billing" ? "border-arcotex-blue bg-blue-50" : "border-border bg-card hover:border-slate-300 hover:bg-slate-50"
          }`}
        >
          <span className="flex items-start justify-between gap-3">
            <span>
              <span className="block text-base font-semibold text-slate-900">Adjuntar menú de colaciones</span>
              <span className="mt-1 block text-sm text-slate-600">Carga el Word del proveedor y revisa las opciones de lunes a viernes.</span>
            </span>
            <span aria-hidden="true" className="rounded-lg bg-white px-3 py-2 text-xl shadow-sm">▤</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => goTo("billing")}
          aria-pressed={panel === "billing"}
          className={`rounded-xl border p-4 text-left shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue ${
            panel === "billing" ? "border-arcotex-blue bg-blue-50" : "border-border bg-card hover:border-slate-300 hover:bg-slate-50"
          }`}
        >
          <span className="flex items-start justify-between gap-3">
            <span>
              <span className="block text-base font-semibold text-slate-900">Descargar Excel de descuento de colaciones</span>
              <span className="mt-1 block text-sm text-slate-600">Descarga el descuento semanal o el acumulado mensual, solo de Producción.</span>
            </span>
            <span aria-hidden="true" className="rounded-lg bg-white px-3 py-2 text-xl shadow-sm">⇩</span>
          </span>
        </button>
      </section>

      <nav aria-label="Flujo semanal de colaciones" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {STEPS.map((step, index) => {
          const active = panel === step.id;
          return (
            <button
              key={step.id}
              type="button"
              aria-current={active ? "step" : undefined}
              onClick={() => goTo(step.id)}
              className={`min-w-0 rounded-lg border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue ${
                active ? "border-arcotex-blue bg-blue-50" : "border-border bg-card hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <span className={`mb-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${active ? "bg-arcotex-blue text-white" : "bg-slate-100 text-slate-500"}`}>
                {index + 1}
              </span>
              <span className="block truncate text-sm font-medium text-slate-800">{step.title}</span>
              <span className="block truncate text-xs text-slate-500">{step.subtitle}</span>
            </button>
          );
        })}
      </nav>

      <ActionNotice message={message} />

      {panel === "menu" && (
        <MenuUploadDashboard recentForms={recentForms} formsError={formsError} formBusinessState={formBusinessState} />
      )}

      {panel === "responses" && (
        <ActiveMealFormDashboard activeForm={activeForm} responseStatus={formBusinessState.responseStatus} tracking={responseTracking} trackingError={trackingError} showPending onCreateForm={() => goTo("menu")} onViewPending={() => goTo("responses")} />
      )}

      {panel === "billing" && discountError && (
        <SectionCard title="Descargar Excel de descuento de colaciones" actions={<Badge label="Revisión requerida" tone="warning" />}>
          <div className="rounded-md border border-critical-border bg-critical-bg p-4">
            <p className="text-sm font-medium text-critical">No pudimos procesar el Excel de Producción</p>
            <p className="mt-1 text-sm text-slate-700">{discountError}</p>
            <p className="mt-2 text-xs text-slate-600">El panel para adjuntar el menú sigue disponible. Revisa que el Excel incluya las columnas Nombre, Fecha y Monto.</p>
          </div>
        </SectionCard>
      )}

      {panel === "billing" && !discountError && (
        <div className="space-y-4">
          <div className="rounded-lg border border-info-border bg-info-bg p-3">
            <p className="text-sm font-medium text-info">Descuento de almuerzos de Producción</p>
            <p className="mt-1 text-xs text-slate-600">
              Solo considera trabajadores de Producción. El ciclo de cobro va desde el día 15 de un mes hasta el día 15 del siguiente: {formatShortDate(dataset.cycleStart)} al {formatShortDate(dataset.cycleEnd)}.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Trabajadores Producción", value: String(workerSummary.length), detail: "Con descuentos en el ciclo" },
              { label: "Almuerzos acumulados", value: String(dataset.records.length), detail: dataset.cycleName },
              { label: "Semana seleccionada", value: formatClp(selectedWeekTotal), detail: `${selectedWeekRecords.length} almuerzos · ${weekLabel(selectedWeek)}` },
              { label: "Descuento mensual", value: formatClp(monthlyTotal), detail: "Acumulado del ciclo 15–15" },
            ].map((metric) => (
              <div key={metric.label} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                <p className="text-xs text-slate-500">{metric.label}</p>
                <p className="mt-1 text-xl font-semibold text-slate-900">{metric.value}</p>
                <p className="mt-1 truncate text-xs text-slate-500">{metric.detail}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <SectionCard title="Descargar Excel de descuento de colaciones" actions={<Badge label="Solo Producción" tone="info" />}>
                <div className="mb-4 rounded-lg border border-border bg-slate-50 p-3">
                  <div className="mb-3">
                    <p className="text-sm font-medium text-slate-800">Revisión diaria para RRHH</p>
                    <p className="mt-1 text-xs text-slate-500">Selecciona un día para revisar quién pidió colación y validar que el registro esté funcionando correctamente.</p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
                    <label className="text-xs font-medium text-slate-600">
                      Día a revisar
                      <select value={selectedReviewDate} onChange={(event) => setSelectedReviewDate(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm">
                        {availableDates.map((date) => <option key={date} value={date}>{reviewDayLabel(date)}</option>)}
                      </select>
                    </label>
                    <div className="rounded-md border border-border bg-white px-3 py-2 text-sm text-slate-700">
                      <span className="font-semibold">{selectedDayRecords.length}</span> pedidos
                    </div>
                    <button type="button" disabled={exporting || !selectedDayRecords.length} onClick={() => void downloadExcel("daily")} className="rounded-md border border-arcotex-blue bg-white px-3 py-2 text-sm font-medium text-arcotex-blue-dark hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400">
                      Descargar revisión del día
                    </button>
                  </div>
                </div>
                <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <label className="text-xs font-medium text-slate-600">
                    Semana para descargar
                    <select value={selectedWeek} onChange={(event) => setSelectedWeek(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm">
                      {availableWeeks.map((week) => <option key={week} value={week}>{weekLabel(week)}</option>)}
                    </select>
                  </label>
                  <button type="button" disabled={exporting || !selectedWeekRecords.length} onClick={() => void downloadExcel("weekly")} className="rounded-md bg-arcotex-blue px-3 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:bg-slate-300">
                    {exporting ? "Preparando…" : "Descargar Excel semanal"}
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b border-border text-xs text-slate-500">
                      <tr><th className="px-2 py-2 font-medium">Trabajador</th><th className="px-2 py-2 font-medium">Área</th><th className="px-2 py-2 text-right font-medium">Almuerzos semana</th><th className="px-2 py-2 text-right font-medium">Descuento semana</th><th className="px-2 py-2 text-right font-medium">Almuerzos mes</th><th className="px-2 py-2 text-right font-medium">Acumulado mensual</th></tr>
                    </thead>
                    <tbody className="divide-y divide-border text-slate-700">
                      {workerSummary.map(([name, totals]) => (
                        <tr key={name}>
                          <td className="px-2 py-3 font-medium text-slate-800">{name}</td><td className="px-2 py-3">Producción</td><td className="px-2 py-3 text-right tabular-nums">{totals.weeklyMeals}</td><td className="px-2 py-3 text-right tabular-nums">{formatClp(totals.weeklyTotal)}</td><td className="px-2 py-3 text-right tabular-nums">{totals.monthlyMeals}</td><td className="px-2 py-3 text-right font-medium tabular-nums text-slate-900">{formatClp(totals.monthlyTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <p className="text-xs text-slate-500">Un solo archivo incluye únicamente las hojas Resumen y Descuento.</p>
                  <button type="button" disabled={exporting} onClick={() => void downloadExcel("monthly")} className="rounded-md border border-arcotex-blue bg-blue-50 px-3 py-2 text-sm font-medium text-arcotex-blue-dark hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-400">
                    Descargar acumulado mensual
                  </button>
                </div>
              </SectionCard>
            </div>
            <div className="space-y-4">
              <SectionCard title="Formato oficial" actions={<Badge label="Revisado" tone="positive" />}>
                <div className="rounded-md border border-success-border bg-success-bg p-3">
                  <p className="text-sm font-medium text-success">{dataset.sourceFile}</p>
                  <p className="mt-1 text-xs text-slate-600">Se conservaron Nombre, Fecha, Monto, Total a Pagar y Firma.</p>
                </div>
                <div className="mt-4 space-y-2 text-xs">
                  <p className="font-medium text-slate-700">Datos necesarios para descontar</p>
                  <p className="flex gap-2"><span className="text-success">✓</span><span className="text-slate-600">Trabajador validado en Producción</span></p>
                  <p className="flex gap-2"><span className="text-success">✓</span><span className="text-slate-600">Fecha del almuerzo dentro del ciclo</span></p>
                  <p className="flex gap-2"><span className="text-success">✓</span><span className="text-slate-600">Monto por almuerzo registrado</span></p>
                  <p className="flex gap-2"><span className="text-success">✓</span><span className="text-slate-600">Total semanal y acumulado mensual</span></p>
                </div>
              </SectionCard>
              <SectionCard title="Regla de descuentos">
                <div className="space-y-2 text-sm text-slate-700">
                  <p className="flex items-center justify-between gap-3"><span>Colación · lunes a jueves</span><strong>{formatClp(PRODUCTION_MEAL_PRICES.REGULAR_MEAL)}</strong></p>
                  <p className="flex items-center justify-between gap-3"><span>Sándwich · viernes, cuando se elige esta opción</span><strong>{formatClp(PRODUCTION_MEAL_PRICES.FRIDAY_SANDWICH)}</strong></p>
                </div>
                <div className={`mt-3 rounded-md border p-3 text-xs ${dataset.pricingMismatchCount === 0 ? "border-success-border bg-success-bg text-success" : "border-warning-border bg-warning-bg text-warning"}`}>
                  {dataset.pricingMismatchCount === 0
                    ? "El Excel coincide completamente con la regla de cobro."
                    : `${dataset.pricingMismatchCount} registro(s) del Excel fueron ajustados a la tarifa correcta.`}
                </div>
              </SectionCard>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
