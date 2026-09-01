import { formatTimeInSantiago } from "../../../lib/view-models/date-utils";

/**
 * Fase 8B.2, PASO 9 -- cronología compacta de marcaciones del día. Lee
 * `workera_attendance_events` ya normalizados (`attendance_type_label`,
 * `attendance_timestamp_interpreted`, `origin`) -- nunca JSON crudo, nunca
 * modifica esa tabla, nunca colapsa eventos de forma distinta al backend
 * (solo los lista en orden cronológico tal como vienen).
 */
export function DayTimeline({ events, scheduledStart, scheduledEnd }: { events: { label: string; timestamp: string; origin: string | null }[]; scheduledStart?: string; scheduledEnd?: string }) {
  if (events.length === 0) {
    return <p className="text-sm text-slate-500">Sin marcaciones registradas para este día.</p>;
  }

  return (
    <div className="space-y-1.5">
      {scheduledStart && scheduledEnd && (
        <p className="text-xs text-slate-400">
          Horario: {scheduledStart.slice(0, 5)} – {scheduledEnd.slice(0, 5)}
        </p>
      )}
      <ol className="space-y-1">
        {events.map((event, i) => (
          <li key={i} className="flex items-center gap-2 text-sm">
            <span className="w-14 shrink-0 font-mono text-xs text-slate-500">
              {formatTimeInSantiago(event.timestamp)}
            </span>
            <span className="text-slate-700">{event.label}</span>
            {event.origin && <span className="text-xs text-slate-400">({event.origin})</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
