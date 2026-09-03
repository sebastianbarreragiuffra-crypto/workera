import { NextResponse } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../../lib/auth/session";
import { buildPayrollExportWorkbook } from "../../../../../lib/payroll/payroll-export";
import type { PayrollBatchItemResult } from "../../../../../lib/payroll/invoice-import";
import { requireSingleOperationalCompany } from "../../../../../lib/tenant/resolve-active-company";

/**
 * Descarga del Excel final de un lote de nómina ya generado -- vuelve a
 * leer `payroll_batch_items` unidos a `suppliers` (datos bancarios
 * actuales, no un snapshot congelado al momento de generar el lote) y
 * arma el archivo en el mismo momento de la descarga.
 */
/**
 * `batchId` llega desde la URL y termina interpolado en el header
 * `Content-Disposition`. Sin validarlo, unas comillas permiten inventar un
 * segundo `filename=` y un CRLF hace que Node rechace el header y la descarga
 * muera con un 500. Exigir un UUID -- que es lo único que la columna acepta --
 * cierra las dos puertas y de paso evita mandar basura a Postgres.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role || (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH")) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  const { batchId } = await params;
  if (!isUuid(batchId)) {
    return NextResponse.json({ error: "Identificador de lote inválido." }, { status: 400 });
  }
  const supabase = await createClient();
  const company = await requireSingleOperationalCompany(supabase);

  const { data: rows, error } = await supabase
    .from("payroll_batch_items")
    .select("nro_docto, nombre_cliente, valor_total, status, suppliers(rut, name, payment_method, bank_code, account_number)")
    .eq("company_id", company.companyId)
    .eq("batch_id", batchId);

  if (error) {
    return NextResponse.json({ error: "No pudimos generar el archivo." }, { status: 500 });
  }

  // Un lote inexistente devolvía un Excel vacío con 200, indistinguible de un
  // lote real sin ítems. Solo se paga la segunda consulta cuando no hubo filas.
  if ((rows ?? []).length === 0) {
    const { data: batch } = await supabase
      .from("payroll_batches")
      .select("id")
      .eq("company_id", company.companyId)
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) {
      return NextResponse.json({ error: "El lote no existe." }, { status: 404 });
    }
  }

  // TODAS las filas del lote van al Excel, con o sin match -- un proveedor sin match
  // nunca queda fuera del archivo, solo sus campos bancarios quedan en blanco
  // (ver `buildPayrollExportWorkbook`).
  const items: PayrollBatchItemResult[] = (rows ?? []).map((row) => {
    const supplierRelation = row.suppliers as { rut: string; name: string; payment_method: string; bank_code: string; account_number: string } | null;
    const isMatched = row.status === "MATCHED" && supplierRelation !== null;
    return {
      nroDocto: row.nro_docto,
      nombreCliente: row.nombre_cliente,
      valorTotal: row.valor_total,
      status: isMatched ? "MATCHED" : "UNMATCHED",
      supplier: isMatched
        ? { rut: supplierRelation!.rut, name: supplierRelation!.name, paymentMethod: supplierRelation!.payment_method, bankCode: supplierRelation!.bank_code, accountNumber: supplierRelation!.account_number }
        : null,
    };
  });

  const workbook = buildPayrollExportWorkbook(items);

  return new NextResponse(Buffer.from(workbook), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="nomina-pago-${batchId}.xlsx"`,
    },
  });
}
