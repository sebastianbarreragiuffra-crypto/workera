import { NextResponse } from "next/server";
import { z } from "zod";
import { buildExpenseAccountingCsv } from "@/lib/expense-accounting/csv";
import { parseExpenseAccountingPayload } from "@/lib/expense-accounting/payload";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { authorizeExpenseDataAccess, expenseDataAccessFailureResponse } from "@/lib/expenses/data-access-guard";
import { createClient } from "@/lib/supabase/server";

const input = z.object({
  companySlug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
  exportId: z.string().uuid(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ companySlug: string; exportId: string }> }) {
  const parsed = input.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Salida inválida." }, { status: 404 });
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, parsed.data.companySlug);
  if (!context?.canReconcile) return NextResponse.json({ error: "No autorizado." }, { status: 403 });

  const access = await authorizeExpenseDataAccess(supabase, context, "accounting.export", parsed.data.exportId);
  const accessFailure = expenseDataAccessFailureResponse(access);
  if (accessFailure) return accessFailure;

  const { data, error } = await supabase.from("expense_accounting_exports")
    .select("payload").eq("company_id", context.id).eq("id", parsed.data.exportId).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Salida no encontrada." }, { status: 404 });
  try {
    const csv = `\uFEFF${buildExpenseAccountingCsv(parseExpenseAccountingPayload(data.payload))}`;
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="asiento-${parsed.data.exportId}.csv"`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "El snapshot contable es inválido." }, { status: 500 });
  }
}
