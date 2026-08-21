"use client";

import { useMemo, useState } from "react";

/**
 * Fase 9 -- exportador real, backed por `attendance_status_records`
 * (`/dashboard/export-asistencia`, ver attendance-export.ts). Exactamente
 * tres modos (semanal/quincenal/mensual, sección 25 del encargo) -- nunca
 * diario, rango arbitrario, ni anual. El archivo se genera en el momento de
 * la descarga a partir del estado actual del backend, nunca de un snapshot
 * cacheado -- por eso el botón es un link GET directo al Route Handler, no
 * un fetch con blob intermedio.
 */

type ExportType = "SEMANAL" | "QUINCENAL" | "MENSUAL";

function todayIsoInSantiago(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}

export function DescargarAsistenciaCard({ now = new Date() }: { now?: Date }) {
  const today = todayIsoInSantiago(now);
  const currentMonth = today.slice(0, 7);
  const currentDay = Number(today.slice(8, 10));

  const [tipo, setTipo] = useState<ExportType>("SEMANAL");
  const [semanaFecha, setSemanaFecha] = useState(today);
  const [quincenaMes, setQuincenaMes] = useState(currentMonth);
  const [quincena, setQuincena] = useState<"1" | "2">(currentDay <= 15 ? "1" : "2");
  const [mensualMes, setMensualMes] = useState(currentMonth);

  const href = useMemo(() => {
    const params = new URLSearchParams();
    if (tipo === "SEMANAL") {
      params.set("tipo", "semanal");
      params.set("fecha", semanaFecha);
    } else if (tipo === "QUINCENAL") {
      params.set("tipo", "quincenal");
      params.set("mes", quincenaMes);
      params.set("quincena", quincena);
    } else {
      params.set("tipo", "mensual");
      params.set("mes", mensualMes);
    }
    return `/dashboard/export-asistencia?${params.toString()}`;
  }, [tipo, semanaFecha, quincenaMes, quincena, mensualMes]);

  return (
    <section aria-labelledby="descargar-asistencia-heading" className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h2 id="descargar-asistencia-heading" className="text-sm font-semibold text-slate-900">
        Descargar asistencia
      </h2>

      <label htmlFor="descargar-asistencia-tipo" className="mt-3 block text-xs font-medium text-slate-500">
        Tipo
      </label>
      <select
        id="descargar-asistencia-tipo"
        value={tipo}
        onChange={(event) => setTipo(event.target.value as ExportType)}
        className="mt-1 w-full rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
      >
        <option value="SEMANAL">Semanal</option>
        <option value="QUINCENAL">Quincenal</option>
        <option value="MENSUAL">Mensual</option>
      </select>

      <label htmlFor="descargar-asistencia-periodo" className="mt-3 block text-xs font-medium text-slate-500">
        Período
      </label>
      {tipo === "SEMANAL" && (
        <input
          id="descargar-asistencia-periodo"
          type="date"
          value={semanaFecha}
          onChange={(event) => setSemanaFecha(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
        />
      )}
      {tipo === "QUINCENAL" && (
        <div className="mt-1 grid grid-cols-[1fr_auto] gap-2">
          <input
            id="descargar-asistencia-periodo"
            type="month"
            value={quincenaMes}
            onChange={(event) => setQuincenaMes(event.target.value)}
            className="w-full rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          />
          <select
            aria-label="Quincena"
            value={quincena}
            onChange={(event) => setQuincena(event.target.value as "1" | "2")}
            className="rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
          >
            <option value="1">1–15</option>
            <option value="2">16–fin</option>
          </select>
        </div>
      )}
      {tipo === "MENSUAL" && (
        <input
          id="descargar-asistencia-periodo"
          type="month"
          value={mensualMes}
          onChange={(event) => setMensualMes(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-white px-2.5 py-1.5 text-sm text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
        />
      )}

      <a
        href={href}
        className="mt-3 block w-full rounded-md bg-arcotex-blue px-3 py-1.5 text-center text-sm font-medium text-white hover:bg-arcotex-blue-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue"
      >
        Descargar Excel
      </a>
    </section>
  );
}
