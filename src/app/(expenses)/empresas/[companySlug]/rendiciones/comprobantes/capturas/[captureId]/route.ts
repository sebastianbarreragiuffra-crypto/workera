import { getExpenseCompanyContextFromClient } from "@/lib/expenses/access";
import { isExpenseFileReleased } from "@/lib/expenses/file-security";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ companySlug: string; captureId: string }> }
) {
  const { companySlug, captureId } = await params;
  if (!UUID.test(captureId)) return new Response("Comprobante no encontrado.", { status: 404 });

  const supabase = await createClient();
  const context = await getExpenseCompanyContextFromClient(supabase, companySlug);
  if (!context?.canSubmit) return new Response("Comprobante no encontrado.", { status: 404 });

  const { data: capture, error } = await supabase
    .from("expense_receipt_captures")
    .select("storage_path, security_status")
    .eq("company_id", context.id)
    .eq("uploaded_by", context.userId)
    .eq("id", captureId)
    .eq("status", "PENDING")
    .maybeSingle();
  if (error || !capture) return new Response("Comprobante no encontrado.", { status: 404 });
  if (!isExpenseFileReleased(capture.security_status)) {
    return new Response("El comprobante sigue aislado por seguridad.", { status: 423 });
  }

  const { data: signed, error: signedError } = await supabase.storage
    .from("expense-receipts")
    .createSignedUrl(capture.storage_path, 60);
  if (signedError || !signed?.signedUrl) return new Response("No fue posible abrir el comprobante.", { status: 503 });

  return Response.redirect(signed.signedUrl, 302);
}
