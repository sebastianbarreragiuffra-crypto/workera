import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../lib/auth/session";
import { resolveWeeklyPeriod, resolveFortnightPeriod, resolveMonthlyPeriod, type AttendanceExportPeriod } from "../../../../lib/business-rules/attendance-export-periods";
import { buildAttendanceExportRows, buildAttendanceExportWorkbook } from "../../../../lib/business-rules/attendance-export";

/**
 * Descarga del Excel de asistencia -- SOLO tres modos (semanal/quincenal/
 * mensual, ver DescargarAsistenciaCard.tsx), siempre generado en el momento
 * de la descarga a partir de `attendance_status_records` actual -- nunca un
 * archivo pre-generado ni cacheado (backend siempre fuente de verdad, Fase 9).
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
      period = resolveWeeklyPeriod(fecha);
    } else if (tipo === "quincenal") {
      const mes = searchParams.get("mes");
      const quincena = searchParams.get("quincena");
      if (!mes || (quincena !== "1" && quincena !== "2")) throw new Error("Faltan los parámetros 'mes' y 'quincena' (1 o 2) para el modo quincenal.");
      period = resolveFortnightPeriod(mes, quincena === "1" ? 1 : 2);
    } else if (tipo === "mensual") {
      const mes = searchParams.get("mes");
      if (!mes) throw new Error("Falta el parámetro 'mes' para el modo mensual.");
      period = resolveMonthlyPeriod(mes);
    } else {
      throw new Error("El parámetro 'tipo' debe ser semanal, quincenal o mensual.");
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Parámetros de período inválidos." }, { status: 400 });
  }

  const supabase = await createClient();
  let rows;
  try {
    rows = await buildAttendanceExportRows(supabase, profile.role, period);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No pudimos generar el archivo." }, { status: 500 });
  }

  const workbook = buildAttendanceExportWorkbook(rows, period);
  const filename = `asistencia-${period.type.toLowerCase()}-${period.startDate}-al-${period.endDate}.xlsx`;

  return new NextResponse(Buffer.from(workbook), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
