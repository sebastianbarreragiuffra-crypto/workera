import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../lib/auth/session";
import {
  resolveWeeklyPeriod,
  resolveFortnightPeriod,
  resolveMonthlyPeriod,
  resolvePayrollPeriod,
  type AttendanceExportPeriod,
} from "../../../../lib/business-rules/attendance-export-periods";
import { buildAttendanceExportData, buildAttendanceExportWorkbook } from "../../../../lib/business-rules/attendance-export";
import { isCalendarDate } from "../../../../lib/view-models/date-utils";
import { requireYearMonth } from "./route-helpers";

/**
 * Descarga del Excel de asistencia, siempre generado en el momento de la
 * descarga a partir de los datos actuales -- nunca un archivo pre-generado ni
 * cacheado (backend siempre fuente de verdad, Fase 9).
 *
 * `pago` es el modo que replica la planilla real de remuneraciones (16 del mes
 * anterior al 15). Los otros tres se conservan porque son útiles para revisar
 * ventanas más cortas durante la marcha blanca.
 */
export async function GET(request: NextRequest) {
  const profile = await getCurrentProfile();
  if (!profile?.role) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const tipo = searchParams.get("tipo");

  let period: AttendanceExportPeriod;
  try {
    if (tipo === "semanal") {
      const fecha = searchParams.get("fecha");
      if (!fecha) throw new Error("Falta el parámetro 'fecha' para el modo semanal.");
      if (!isCalendarDate(fecha)) throw new Error("El parámetro 'fecha' debe ser un día real en formato YYYY-MM-DD.");
      period = resolveWeeklyPeriod(fecha);
    } else if (tipo === "quincenal") {
      const mes = requireYearMonth(searchParams.get("mes"));
      const quincena = searchParams.get("quincena");
      if (quincena !== "1" && quincena !== "2") throw new Error("El parámetro 'quincena' debe ser 1 o 2.");
      period = resolveFortnightPeriod(mes, quincena === "1" ? 1 : 2);
    } else if (tipo === "mensual") {
      period = resolveMonthlyPeriod(requireYearMonth(searchParams.get("mes")));
    } else if (tipo === "pago") {
      period = resolvePayrollPeriod(requireYearMonth(searchParams.get("mes")));
    } else {
      throw new Error("El parámetro 'tipo' debe ser pago, semanal, quincenal o mensual.");
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Parámetros de período inválidos." }, { status: 400 });
  }

  const supabase = await createClient();
  let data;
  try {
    data = await buildAttendanceExportData(supabase, profile.role, period);
  } catch (err) {
    // El mensaje interno lleva el error crudo de PostgREST (nombres de tabla,
    // detalle de la consulta). Se registra en el servidor y al cliente le
    // llega solo el texto genérico, igual que en /api/sync/workera.
    console.error("[attendance-export] fallo generando el archivo", err instanceof Error ? err.message : "error desconocido");
    return NextResponse.json({ error: "No pudimos generar el archivo." }, { status: 500 });
  }

  const workbook = buildAttendanceExportWorkbook(data);
  const filename = `asistencia-${period.type.toLowerCase()}-${period.startDate}-al-${period.endDate}.xlsx`;

  return new NextResponse(Buffer.from(workbook), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
