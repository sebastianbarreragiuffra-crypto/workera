import { NextResponse } from "next/server";
import { createClient } from "../../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../../lib/auth/session";
import { buildPayrollExportWorkbook } from "../../../../../lib/payroll/payroll-export";
import type { PayrollBatchItemResult } from "../../../../../lib/payroll/invoice-import";

/**
 * Descarga del Excel final de un lote de nómina ya generado -- vuelve a
 * leer `payroll_batch_items` unidos a `suppliers` (datos bancarios
 * actuales, no un snapshot congelado al momento de generar el lote) y
 * arma el archivo en el mismo momento de la descarga.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role || (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH")) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 });
  }

  const { batchId } = await params;
  const supabase = await createClient();

  const { data: rows, error } = await supabase
    .from("payroll_batch_items")
    .select("nro_docto, nombre_cliente, valor_total, status, suppliers(rut, name, payment_method, bank_code, account_number)")
    .eq("batch_id", batchId);

  if (error) {
    return NextResponse.json({ error: "No pudimos generar el archivo." }, { status: 500 });
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
