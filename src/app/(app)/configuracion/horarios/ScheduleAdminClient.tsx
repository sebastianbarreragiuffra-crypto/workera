"use client";

import { Fragment, useState } from "react";
import { Badge } from "../../../../components/shell/Badge";
import type { AreaCode } from "../../../../lib/access/scope";
import type { ScheduleAdminRow, WorkScheduleSummary } from "../../../../lib/schedules/schedule-administration";
import { EmployeeScheduleEditor } from "./EmployeeScheduleEditor";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const LEGAL_BASIS_LABEL: Record<string, string> = {
  ARTICLE_22: "Artículo 22",
  NO_MARKING_REQUIRED: "No marca",
  OTHER: "Otro",
};

type Filter = "todos" | "sin-horario" | "exentos";

export function ScheduleAdminClient({
  rows,
  schedules,
  today,
}: {
  rows: ScheduleAdminRow[];
  schedules: WorkScheduleSummary[];
  today: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("todos");

  const visibleRows = rows.filter((row) => {
    if (filter === "sin-horario") return row.timeControl === "NORMAL" && row.workScheduleId === null;
    if (filter === "exentos") return row.timeControl === "EXEMPT";
    return true;
  });

  const filters: { key: Filter; label: string }[] = [
    { key: "todos", label: `Todos (${rows.length})` },
    { key: "sin-horario", label: `Sin horario (${rows.filter((r) => r.timeControl === "NORMAL" && r.workScheduleId === null).length})` },
    { key: "exentos", label: `Exentos (${rows.filter((r) => r.timeControl === "EXEMPT").length})` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.key ? "bg-arcotex-blue text-white" : "border border-border text-slate-600 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visibleRows.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-500">No hay trabajadores en este filtro.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2 font-semibold">Trabajador</th>
                <th className="px-2 py-2 font-semibold">Área</th>
                <th className="px-2 py-2 font-semibold">Horario vigente</th>
                <th className="px-2 py-2 font-semibold">Control horario</th>
                <th className="px-2 py-2 text-right font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const expanded = expandedId === row.employeeId;
                return (
                  <Fragment key={row.employeeId}>
                    <tr className="border-b border-border/60">
                      <td className="px-2 py-2 font-medium text-slate-900">{row.displayName}</td>
                      <td className="px-2 py-2 text-slate-600">{row.areaCode ? AREA_LABEL[row.areaCode] : "—"}</td>
                      <td className="px-2 py-2">
                        {row.workScheduleName ? (
                          <span className="text-slate-700">{row.workScheduleName}</span>
                        ) : row.timeControl === "EXEMPT" ? (
                          <span className="text-slate-400">No aplica</span>
                        ) : (
                          <Badge label="Sin horario" tone="negative" />
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {row.timeControl === "EXEMPT" ? (
                          <Badge label={`Exento · ${LEGAL_BASIS_LABEL[row.legalBasis ?? "OTHER"]}`} tone="info" />
                        ) : (
                          <span className="text-slate-600">Normal</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : row.employeeId)}
                          aria-expanded={expanded}
                          className="rounded-md border border-border px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {expanded ? "Cerrar" : "Editar"}
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5} className="px-2 pb-3">
                          <EmployeeScheduleEditor row={row} schedules={schedules} today={today} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
