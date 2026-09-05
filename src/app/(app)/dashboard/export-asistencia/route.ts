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
import {
  authorizeWorkforceDataAccess,
  workforceDataAccessFailureResponse,
} from "../../../../lib/decisions/workforce-data-access";
import { privateAttachmentHeaders } from "../../../../lib/shared/private-download";
import { isCalendarDate } from "../../../../lib/view-models/date-utils";

/**
 * Descarga del Excel de asistencia, siempre generado en el momento de la
 * descarga a partir de los datos actuales -- nunca un archivo pre-generado ni
 * cacheado (backend siempre fuente de verdad, Fase 9).
 *
 * `pago` es el modo que replica la planilla real de remuneraciones (16 del mes
 * anterior al 15). Los otros tres se conservan porque son útiles para revisar
 * ventanas más cortas durante la marcha blanca.
 */
/**
 * Los resolvers hacen aritmética con `Number(...)` sobre las dos mitades de
 * `mes` y no validan nada: `2026-00` producía `startDate = "2026-00-01"`, que
 * Postgres rechaza recién dentro de la consulta, y `2026-13` devolvía enero del
 * año siguiente en silencio. Se exige el mes real antes de llegar ahí.
 */
export function requireYearMonth(value: string | null): string {
  if (!value) throw new Error("Falta el parámetro 'mes' (formato YYYY-MM).");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("El parámetro 'mes' debe tener el formato YYYY-MM, con un mes entre 01 y 12.");
  }
  return value;
}

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
  const access = await authorizeWorkforceDataAccess(supabase, {
    scope: "attendance.export",
    period,
  });
  if (access.status !== "ALLOWED") {
    return workforceDataAccessFailureResponse(access)!;
  }

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
  const bytes = Buffer.from(workbook);

  return new NextResponse(bytes, {
    status: 200,
    headers: privateAttachmentHeaders(filename, bytes.byteLength, {
      limit: access.requestLimit,
      remaining: access.remaining,
    }),
  });
}
