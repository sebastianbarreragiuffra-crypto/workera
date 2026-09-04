import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import {
  EXPENSE_BANK_STATEMENT_MAX_BYTES,
  ExpenseBankStatementError,
  parseExpenseBankStatementCsv,
} from "@/lib/expenses/bank-statement";
import {
  claimExpenseBankUploadWithServiceRole,
  importExpenseBankStatementWithServiceRole,
} from "@/lib/expense-bank/service";
import {
  assertExpenseBankUploadHeaders,
  assertSameOrigin,
  ExpenseBankUploadHttpError,
  readRequestBodyWithLimit,
} from "@/lib/expense-bank/http";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/database.types";

type RouteContext = { params: Promise<{ companySlug: string }> };

// El stream expira internamente a los 30 s; el margen restante cubre parseo,
// persistencia y la respuesta sin depender del timeout implícito del proveedor.
export const maxDuration = 60;

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ status: "error", message }, { status });
}

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
  const { companySlug } = await params;
  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) return errorResponse("No tienes una sesión válida para esta empresa.", 403);
  if (!context.canReconcile) return errorResponse("Tu rol no permite importar cartolas.", 403);

  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof ExpenseBankUploadHttpError) return errorResponse(error.message, error.status);
    return errorResponse("La solicitud no es válida.", 400);
  }

  // Se reserva siempre el máximo, no el Content-Length aportado por el cliente:
  // un emisor no puede declarar 1 byte y consumir 2 MB sin gastar su cuota.
  const claim = await claimExpenseBankUploadWithServiceRole({
    actorId: context.userId,
    companyId: context.id,
    declaredBytes: EXPENSE_BANK_STATEMENT_MAX_BYTES,
  });
  if (claim.errorCode === "54000") return errorResponse("Superaste la cuota horaria de importación bancaria.", 429);
  if (claim.errorCode === "42501") return errorResponse("Tu rol ya no permite importar cartolas.", 403);
  if (claim.failed) return errorResponse("No pudimos reservar la importación. Intenta nuevamente.", 503);

  let rows: ReturnType<typeof parseExpenseBankStatementCsv>;
  try {
    assertExpenseBankUploadHeaders(request, EXPENSE_BANK_STATEMENT_MAX_BYTES);
    const bytes = await readRequestBodyWithLimit(request, EXPENSE_BANK_STATEMENT_MAX_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rows = parseExpenseBankStatementCsv(text);
  } catch (error) {
    if (error instanceof ExpenseBankUploadHttpError) return errorResponse(error.message, error.status);
    if (error instanceof ExpenseBankStatementError) return errorResponse(error.message, 400);
    return errorResponse("La cartola debe estar guardada como CSV UTF-8.", 400);
  }

  const result = await importExpenseBankStatementWithServiceRole({
    actorId: context.userId,
    companyId: context.id,
    sourceChannel: "WEB_CSV",
    rows: rows as unknown as Json,
  });
  if (result.errorCode === "23514") return errorResponse("La cartola contiene una fila inválida.", 400);
  if (result.errorCode === "54000") return errorResponse("La importación supera un límite operativo.", 429);
  if (result.errorCode === "42501") return errorResponse("Tu rol ya no permite importar cartolas.", 403);
  if (result.failed || !result.importId) return errorResponse("No pudimos importar la cartola.", 500);

  revalidatePath(`/empresas/${context.slug}/rendiciones/conciliacion`);
  return NextResponse.json({
    status: "success",
    message: `${rows.length} movimientos listos para conciliación. Si repites el mismo archivo, no se duplican.`,
  });
}
