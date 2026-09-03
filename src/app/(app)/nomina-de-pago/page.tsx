import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { PageHeader } from "../../../components/shell/PageHeader";
import { NominaDashboard } from "./NominaDashboard";
import { requireSingleOperationalCompany } from "../../../lib/tenant/resolve-active-company";

export default async function NominaDePagoPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (!isPrivilegedAdmin(profile.role)) redirect("/dashboard");

  const supabase = await createClient();
  const company = await requireSingleOperationalCompany(supabase);

  const { data: batches } = await supabase
    .from("payroll_batches")
    .select("id, source_filename, generated_at, matched_count, unmatched_count, total_amount")
    .eq("company_id", company.companyId)
    .order("generated_at", { ascending: false })
    .limit(10);

  return (
    <div className="space-y-4">
      <PageHeader title="Nómina de Pago" subtitle="Sube el archivo de facturas para generar la nómina de pago" />
      <NominaDashboard recentBatches={batches ?? []} />
    </div>
  );
}
