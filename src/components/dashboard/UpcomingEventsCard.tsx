import type { UpcomingEvents } from "../../lib/view-models/dashboard-view";

const MONTH_NAMES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function daysUntilLabel(daysUntil: number): string {
  if (daysUntil === 0) return "HOY";
  if (daysUntil === 1) return "Mañana";
  if (daysUntil > 0) return `En ${daysUntil} días`;
  return "Ya pasó este mes";
}

/**
 * Fase 8B.1, PASO 7/7A/7B -- únicamente cumpleaños del mes y próximo
 * feriado, real desde `employee_birthdays`/`holidays`. Nunca recalcula la
 * autorización de las 12:00 (eso sigue siendo del motor backend, Fase 7) --
 * el 🎂 es puramente informativo.
 */
export function UpcomingEventsCard({ events, monthLabel }: { events: UpcomingEvents; monthLabel: number }) {
  const monthName = MONTH_NAMES[monthLabel - 1];

  return (
    <section aria-labelledby="upcoming-events-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 id="upcoming-events-heading" className="text-sm font-semibold text-slate-900">
        Próximos eventos
      </h2>

      <div className="mt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          🎂 Cumpleaños de {monthName}
        </h3>
        {events.birthdaysThisMonth.length === 0 ? (
          <p role="status" className="mt-2 text-sm text-slate-500">
            No hay cumpleaños registrados este mes en tu área.
          </p>
        ) : (
          <>
            <ul className="mt-2 space-y-1.5">
              {events.birthdaysThisMonth.map((b) => (
                <li key={b.employeeId} className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">
                    {String(b.birthDay).padStart(2, "0")} {monthName.slice(0, 3)} · {b.displayName}
                  </span>
                  <span className={`text-xs font-medium ${b.isToday ? "rounded-full bg-pink-100 px-2 py-0.5 text-pink-700" : "text-slate-400"}`}>
                    {daysUntilLabel(b.daysUntil)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-400">
              {events.birthdaysThisMonth.length} cumpleaños este mes
            </p>
          </>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">🇨🇱 Próximo feriado</h3>
        {events.nextHoliday ? (
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-slate-700">
              {events.nextHoliday.date.slice(8, 10)} — {events.nextHoliday.name}
            </span>
            <span className="text-xs font-medium text-slate-400">{daysUntilLabel(events.nextHoliday.daysUntil)}</span>
          </div>
        ) : (
          <p role="status" className="mt-2 text-sm text-slate-500">
            Sin feriados registrados — fuente de feriados pendiente de carga.
          </p>
        )}
      </div>
    </section>
  );
}
