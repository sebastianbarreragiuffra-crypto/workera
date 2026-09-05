import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { authorizeExpenseDataAccess, expenseDataAccessFailureResponse } from "@/lib/expenses/data-access-guard";
import { isExpenseFileReleased } from "@/lib/expenses/file-security";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ companySlug: string; receiptId: string }> }
) {
  const { companySlug, receiptId } = await params;
  if (!UUID.test(receiptId)) return new Response("Comprobante no encontrado.", { status: 404 });

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context) return new Response("Comprobante no encontrado.", { status: 404 });

  const access = await authorizeExpenseDataAccess(supabase, context, "receipt.download", receiptId);
  const accessFailure = expenseDataAccessFailureResponse(access, {
    deniedStatus: 404,
    deniedMessage: "Comprobante no encontrado.",
  });
  if (accessFailure) return accessFailure;

  const { data: receipt, error } = await supabase
    .from("expense_receipts")
    .select("storage_path, security_status")
    .eq("company_id", context.id)
    .eq("id", receiptId)
    .maybeSingle();
  if (error || !receipt) return new Response("Comprobante no encontrado.", { status: 404 });
  if (!isExpenseFileReleased(receipt.security_status)) {
    return new Response("Comprobante no encontrado.", { status: 404 });
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from("expense-receipts")
    .createSignedUrl(receipt.storage_path, 60);
  if (signedError || !signed?.signedUrl) return new Response("No fue posible abrir el comprobante.", { status: 503 });

  return new Response(null, {
    status: 302,
    headers: {
      Location: signed.signedUrl,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
