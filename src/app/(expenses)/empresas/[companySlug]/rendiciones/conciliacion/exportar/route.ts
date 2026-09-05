import { NextResponse, type NextRequest } from "next/server";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { authorizeExpenseDataAccess, expenseDataAccessFailureResponse } from "@/lib/expenses/data-access-guard";
import { buildReimbursementExportData, buildReimbursementExportWorkbook } from "@/lib/expenses/reimbursement-export";
import { createClient } from "@/lib/supabase/server";

/**
 * Descarga de la planilla mensual de reembolso -- siempre generada al
 * momento de la descarga desde los datos actuales, nunca cacheada (mismo
 * criterio que la exportación de asistencia).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ companySlug: string }> }) {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context || !context.canReconcile) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const month = new URL(request.url).searchParams.get("mes");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "Falta el parámetro 'mes' (formato YYYY-MM)." }, { status: 400 });
  }

  const access = await authorizeExpenseDataAccess(supabase, context, "reconciliation.export");
  const accessFailure = expenseDataAccessFailureResponse(access);
  if (accessFailure) return accessFailure;

  let data;
  try {
    data = await buildReimbursementExportData(supabase, context, month);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No pudimos generar la planilla." }, { status: 400 });
  }

  const workbook = buildReimbursementExportWorkbook(data);
  const filename = `reembolsos-${context.slug}-${month}.xlsx`;

  return new NextResponse(Buffer.from(workbook), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
