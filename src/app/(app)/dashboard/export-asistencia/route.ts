import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../lib/auth/session";
import {
  resolveDailyPeriod,
  resolveWeeklyPeriod,
  resolveFortnightPeriod,
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
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../../../lib/tenant/legacy-workforce";
import { loadAcceptedPayrollWorkbookAdjustments } from "../../../../lib/payroll/payroll-workbook-adjustments";
import { resolvePayrollCompanyRole } from "../../../../lib/payroll/payroll-company-role";

/**
 * Descarga del Excel de asistencia, siempre generado en el momento de la
 * descarga a partir de los datos actuales -- nunca un archivo pre-generado ni
 * cacheado (backend siempre fuente de verdad, Fase 9).
 *
 * `mensual` replica la planilla real de remuneraciones (16 del mes anterior
 * al 15). Diario, semanal y quincenal son versiones de trabajo regeneradas
 * desde los datos vigentes. `pago` se conserva solo como alias de enlaces
 * históricos.
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

export function canDownloadPayrollWorkbook(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN_RRHH";
}

interface LatestPayrollWorkbookQuery {
  select(columns: string): LatestPayrollWorkbookQuery;
  eq(column: string, value: string): LatestPayrollWorkbookQuery;
  order(column: string, options: { ascending: boolean }): LatestPayrollWorkbookQuery;
  limit(count: number): LatestPayrollWorkbookQuery;
  maybeSingle(): Promise<{ data: { id?: unknown } | null; error: { message: string } | null }>;
}

interface ClosedPayrollQuery {
  select(columns: string): ClosedPayrollQuery;
  eq(column: string, value: unknown): ClosedPayrollQuery;
  order(column: string, options: { ascending: boolean }): ClosedPayrollQuery;
  limit(count: number): ClosedPayrollQuery;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
}

export async function GET(request: NextRequest) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const tipo = searchParams.get("tipo");

  let period: AttendanceExportPeriod;
  try {
    if (tipo === "diario") {
      const fecha = searchParams.get("fecha");
      if (!fecha) throw new Error("Falta el parámetro 'fecha' para el modo diario.");
      if (!isCalendarDate(fecha)) throw new Error("El parámetro 'fecha' debe ser un día real en formato YYYY-MM-DD.");
      period = resolveDailyPeriod(fecha);
    } else if (tipo === "semanal") {
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
      period = resolvePayrollPeriod(requireYearMonth(searchParams.get("mes")));
    } else if (tipo === "pago") {
      period = resolvePayrollPeriod(requireYearMonth(searchParams.get("mes")));
    } else {
      throw new Error("El parámetro 'tipo' debe ser diario, semanal, quincenal o mensual.");
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Parámetros de período inválidos." }, { status: 400 });
  }

  const supabase = await createClient();
  // El libro contiene RUT y variables financieras: se exige el rol exacto de
  // la membresía ARCOTEX, nunca solo la etiqueta global de profiles.role.
  const payrollRole = await resolvePayrollCompanyRole(
    supabase as unknown as Parameters<typeof resolvePayrollCompanyRole>[0],
    ARCOTEX_WORKFORCE_COMPANY_ID,
    ["ADMIN_RRHH", "SUPER_ADMIN"],
  );
  if (!payrollRole) {
    return NextResponse.json({ error: "No tienes permisos para descargar la pre-nómina." }, { status: 403 });
  }
  const access = await authorizeWorkforceDataAccess(supabase, {
    scope: "attendance.export",
    period,
  });
  if (access.status !== "ALLOWED") {
    return workforceDataAccessFailureResponse(access)!;
  }

  // Un período CLOSED se descarga desde el snapshot exacto que fue verificado
  // al cerrar. Regenerarlo desde tablas vivas podría producir bytes distintos
  // y, peor aún, rotularlos falsamente como cerrados.
  if (period.type === "PAGO") {
    const loose = supabase as unknown as { from(name: string): ClosedPayrollQuery };
    const periodResult = await loose.from("reporting_periods")
      .select("id, status")
      .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
      .eq("period_start", period.startDate)
      .eq("period_end", period.endDate)
      .maybeSingle();
    if (periodResult.error) {
      return NextResponse.json({ error: "No pudimos comprobar el estado del período." }, { status: 500 });
    }
    if (periodResult.data?.status === "CLOSED") {
      const snapshot = await loose.from("payroll_workbook_versions")
        .select("storage_path, content_sha256, file_size")
        .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
        .eq("reporting_period_id", periodResult.data.id)
        .eq("status", "CLOSED_SNAPSHOT")
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (snapshot.error || !snapshot.data || typeof snapshot.data.storage_path !== "string") {
        return NextResponse.json({ error: "El período cerrado no tiene un snapshot verificable." }, { status: 500 });
      }
      const stored = await supabase.storage.from("payroll-workbooks").download(snapshot.data.storage_path);
      if (stored.error || !stored.data) {
        return NextResponse.json({ error: "No pudimos recuperar el snapshot cerrado." }, { status: 500 });
      }
      const bytes = Buffer.from(await stored.data.arrayBuffer());
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== snapshot.data.content_sha256 || bytes.byteLength !== Number(snapshot.data.file_size)) {
        console.error("[attendance-export] el snapshot CLOSED no superó la verificación de integridad");
        return NextResponse.json({ error: "El snapshot cerrado no superó la verificación de integridad." }, { status: 500 });
      }
      const filename = `pre-nomina-${period.startDate}-al-${period.endDate}-cierre.xlsx`;
      return new NextResponse(bytes, {
        headers: privateAttachmentHeaders(filename, bytes.byteLength, {
          limit: access.requestLimit,
          remaining: access.remaining,
        }),
      });
    }
  }

  let data;
  try {
    data = await buildAttendanceExportData(supabase, payrollRole, period, ARCOTEX_WORKFORCE_COMPANY_ID);
    if (period.type === "PAGO") {
      const [latest, adjustments] = await Promise.all([
        (supabase as unknown as { from(name: string): LatestPayrollWorkbookQuery })
          .from("payroll_workbook_versions")
          .select("id")
          .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
          .eq("period_start", period.startDate)
          .eq("period_end", period.endDate)
          .eq("status", "ACCEPTED")
          .order("version_number", { ascending: false })
          .limit(1)
          .maybeSingle(),
        loadAcceptedPayrollWorkbookAdjustments(supabase, {
          companyId: ARCOTEX_WORKFORCE_COMPANY_ID,
          periodStart: period.startDate,
          periodEnd: period.endDate,
        }),
      ]);
      if (latest.error) throw new Error(latest.error.message);
      data.workbookBaseVersionId = typeof latest.data?.id === "string" ? latest.data.id : null;
      data.workbookAdjustments = adjustments;
    }
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
